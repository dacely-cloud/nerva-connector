// SPDX-FileCopyrightText: 2026 Dacely <business@dacely.com>
// SPDX-License-Identifier: LicenseRef-Proprietary

import { spawn, type ChildProcess } from 'node:child_process';
import type { WorkspaceInspection } from './WorkspaceInspection.js';
import { WorkspaceIdentityFailure, type WorkspaceIdentityResult } from './WorkspaceIdentity.js';
import { WorkspaceIdentityCodec } from './WorkspaceIdentityCodec.js';
import type { WorkspaceFileInspection } from './WorkspaceFileInspection.js';
import type { WorkspaceDirectoryInspection } from './WorkspaceDirectoryInspection.js';
import type { ExecutionCgroupIdentity } from '../execution/ExecutionCgroupIdentity.js';
import { ExecutionCgroupIdentityCodec } from '../execution/ExecutionCgroupIdentityCodec.js';
import type { ConnectorNativeFileEffect } from '../runtime/ConnectorEffectContext.js';
import { ConnectorEffectContextCodec } from '../runtime/ConnectorEffectContextCodec.js';
import { Boundary } from 'nerva-connector-protocol/protocol/Boundary.js';

enum WorkspaceCaptureKind {
    Diagnostic = '--inspect-root',
    FileEffect = '--capture-file-effect',
    Cgroup = '--capture-cgroup',
}

/** Every active slot owns a particular process and its terminal close, never a PID-only kill target. */
interface WorkspaceIdentityChild {
    readonly child: ChildProcess;
    readonly closed: Promise<void>;
}

/** Bounded local inspector borrows already verified policy descriptors and joins owned children on every exit. */
export class WorkspaceIdentityProcess implements AsyncDisposable {
    readonly #children: Set<WorkspaceIdentityChild> = new Set();
    #closed: boolean = false;

    /** No paths, grants, signing secrets, command payloads or caller environment enter the native child. */
    public async inspect(root: WorkspaceInspection): Promise<WorkspaceIdentityResult> {
        return await this.#capture(
            root,
            WorkspaceCaptureKind.Diagnostic,
            null,
            (raw: unknown, code: number): WorkspaceIdentityResult => {
                const value: WorkspaceIdentityResult = WorkspaceIdentityCodec.result(raw);
                return (value.ok && code !== 0) || (!value.ok && code !== 1)
                    ? { ok: false, error: WorkspaceIdentityFailure.Invalid }
                    : value;
            },
            (error: WorkspaceIdentityFailure): WorkspaceIdentityResult => ({ ok: false, error }),
        );
    }

    /** This exact enforcing-helper feature must succeed before a new bound file effect can start. */
    public async fileEffect(root: WorkspaceFileInspection): Promise<ConnectorNativeFileEffect> {
        const result: ConnectorNativeFileEffect | null = await this.#capture(
            root,
            WorkspaceCaptureKind.FileEffect,
            root.stagingDescriptor,
            (raw: unknown, code: number): ConnectorNativeFileEffect => {
                const value: Readonly<Record<string, unknown>> = Boundary.record(raw, [
                    'ok',
                    'root',
                    'staging',
                ]);
                if (code !== 0 || value['ok'] !== true) {
                    throw new Error('File capture unavailable');
                }
                return ConnectorEffectContextCodec.native({
                    root: value['root'],
                    staging: value['staging'],
                });
            },
            (): null => null,
        );
        if (result === null) {
            throw new Error('Original physical file capture is unavailable');
        }
        return result;
    }

    /** Cgroup identity is boot-scoped and generation-bearing; no pathname or inode-only fallback is accepted. */
    public async cgroup(root: WorkspaceDirectoryInspection): Promise<ExecutionCgroupIdentity> {
        const identity: ExecutionCgroupIdentity | null = await this.#capture(
            root,
            WorkspaceCaptureKind.Cgroup,
            null,
            (raw: unknown, code: number): ExecutionCgroupIdentity => {
                const value: Readonly<Record<string, unknown>> = Boundary.record(raw, [
                    'ok',
                    'identity',
                ]);
                if (code !== 0 || value['ok'] !== true) {
                    throw new Error('Original cgroup identity unavailable');
                }
                return ExecutionCgroupIdentityCodec.read(value['identity']);
            },
            (): null => null,
        );
        if (identity === null) {
            throw new Error('Original cgroup capture unavailable');
        }
        return identity;
    }

    async #capture<T>(
        root: WorkspaceDirectoryInspection,
        kind: WorkspaceCaptureKind,
        staging: number | null,
        decode: (raw: unknown, code: number) => T,
        failure: (error: WorkspaceIdentityFailure) => T,
    ): Promise<T> {
        if (
            this.#closed ||
            root.signal.aborted ||
            this.#children.size >= 2 ||
            !this.#descriptor(root.descriptor) ||
            !this.#descriptor(root.helperDescriptor) ||
            (staging !== null && !this.#descriptor(staging))
        ) {
            return failure(WorkspaceIdentityFailure.Unavailable);
        }
        let child: ChildProcess;
        try {
            child = spawn('/proc/self/fd/3', [kind], {
                cwd: '/',
                env: { LANG: 'C', NERVA_CONNECTOR_PARENT_PID: process.pid.toString() },
                stdio: [
                    'pipe',
                    'pipe',
                    'pipe',
                    root.helperDescriptor,
                    root.descriptor,
                    ...(staging === null ? [] : [staging]),
                ],
            });
        } catch {
            return failure(WorkspaceIdentityFailure.Unavailable);
        }
        const closed: PromiseWithResolvers<undefined> = Promise.withResolvers<undefined>();
        const result: PromiseWithResolvers<T> = Promise.withResolvers<T>();
        const record: WorkspaceIdentityChild = { child, closed: closed.promise };
        this.#children.add(record);
        const output: Buffer = Buffer.alloc(kind === WorkspaceCaptureKind.Diagnostic ? 1024 : 4096);
        let bytes: number = 0;
        let errors: number = 0;
        let invalid: boolean = false;
        const abort: () => void = (): void => {
            invalid = true;
            child.kill('SIGKILL');
        };
        const timeout: NodeJS.Timeout = setTimeout(abort, 2500);
        root.signal.addEventListener('abort', abort, { once: true });
        child.stdout?.on('data', (chunk: Buffer): void => {
            if (chunk.byteLength > output.byteLength - bytes) {
                abort();
            } else if (!invalid) {
                chunk.copy(output, bytes);
                bytes += chunk.byteLength;
            }
        });
        child.stderr?.on('data', (chunk: Buffer): void => {
            errors += chunk.byteLength;
            if (errors > 1024) {
                abort();
            }
        });
        child.once('error', abort);
        child.stdin?.once('error', abort);
        child.once('close', (code: number | null, signal: NodeJS.Signals | null): void => {
            clearTimeout(timeout);
            root.signal.removeEventListener('abort', abort);
            this.#children.delete(record);
            let response: T = failure(WorkspaceIdentityFailure.Unavailable);
            try {
                if (
                    !invalid &&
                    errors === 0 &&
                    !this.#closed &&
                    !root.signal.aborted &&
                    signal === null &&
                    (code === 0 || code === 1)
                ) {
                    const raw: unknown = JSON.parse(
                        new TextDecoder('utf-8', { fatal: true }).decode(output.subarray(0, bytes)),
                    );
                    response = decode(raw, code);
                }
            } catch {
                response = failure(WorkspaceIdentityFailure.Invalid);
            } finally {
                output.fill(0);
                closed.resolve(undefined);
                result.resolve(response);
            }
        });
        if (child.stdin === null || child.stdout === null || child.stderr === null) {
            abort();
        } else {
            child.stdin.end();
        }
        if (root.signal.aborted || this.#closed) {
            abort();
        }
        return await result.promise;
    }

    /** Disposal kills and joins only this owner's inspectors before callers may release borrowed descriptors. */
    public async [Symbol.asyncDispose](): Promise<void> {
        this.#closed = true;
        const current: readonly WorkspaceIdentityChild[] = [...this.#children];
        for (const record of current) {
            record.child.kill('SIGKILL');
        }
        await Promise.allSettled(
            current.map((record: WorkspaceIdentityChild): Promise<void> => record.closed),
        );
    }

    #descriptor(value: number): boolean {
        return Number.isSafeInteger(value) && value >= 0 && value <= 2147483647;
    }
}
