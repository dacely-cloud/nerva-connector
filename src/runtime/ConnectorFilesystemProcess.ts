// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

import type { FileHandle } from 'node:fs/promises';
import { spawn, type ChildProcess, type StdioOptions } from 'node:child_process';
import {
    ConnectorFileLimits,
    ConnectorFileMode,
} from 'nerva-connector-protocol/protocol/ConnectorFiles.js';
import { ConnectorUploadLimits } from 'nerva-connector-protocol/protocol/ConnectorUpload.js';
import type { ConnectorFileRootCapability } from './ConnectorFileRoots.js';
import { Writable } from 'node:stream';
import type { Stream } from 'node:stream';
import type { ConnectorNativeFileEffect } from './ConnectorEffectContext.js';
import { ConnectorEffectContextCodec } from './ConnectorEffectContextCodec.js';

/** A failed process has no fabricated successful native response. */
export interface ConnectorNativeFailure {
    readonly ok: false;
}
/** The operation decoder validates one bounded native response after the actual child closes. */
export interface ConnectorNativeSuccess<T> {
    readonly ok: true;
    readonly value: T;
}
/** Typed process outcomes keep native failure independent of filesystem operation failure. */
export type ConnectorNativeOutcome<T> = ConnectorNativeFailure | ConnectorNativeSuccess<T>;
/** Only an owned process and its terminal close hold a child slot. */
interface ConnectorNativeChild {
    readonly process: ChildProcess;
    readonly closed: Promise<void>;
}

/** Runs the pinned audited native helper with only selected directory descriptors and finite I/O. */
export class ConnectorFilesystemProcess implements AsyncDisposable {
    readonly #children: Set<ConnectorNativeChild> = new Set();
    #closed: boolean = false;
    /** The surrounding filesystem retains and closes the borrowed executable after this owner joins every child. */
    public constructor(
        public readonly executable: FileHandle,
        public readonly mode: ConnectorFileMode,
    ) {}

    /** No queue, inherited secrets, shell, caller environment or ambient file descriptor crosses this boundary. */
    public async run<T>(
        root: ConnectorFileRootCapability,
        payload: string,
        decode: (raw: unknown) => T,
        writable: boolean = false,
        effect?: ConnectorNativeFileEffect,
    ): Promise<ConnectorNativeOutcome<T>> {
        if (
            this.#closed ||
            this.#children.size >= ConnectorFileLimits.children ||
            Buffer.byteLength(payload) > ConnectorUploadLimits.requestBytes ||
            (writable && this.mode !== ConnectorFileMode.ReadWrite) ||
            (effect !== undefined &&
                ((writable && effect.staging === null) || (!writable && effect.staging !== null)))
        ) {
            return { ok: false };
        }
        const context: string | null =
            effect === undefined ? null : ConnectorEffectContextCodec.encode(effect);
        if (context !== null && Buffer.byteLength(context) > 4096) {
            return { ok: false };
        }
        const descriptors: StdioOptions = [
            'pipe',
            'pipe',
            'pipe',
            this.executable.fd,
            root.directory.fd,
        ];
        if (effect === undefined) {
            if (writable && root.staging !== null) {
                descriptors.push(root.staging.fd);
            }
        } else {
            descriptors.push(
                writable && root.staging !== null ? root.staging.fd : 'ignore',
                'pipe',
            );
        }
        const child: ChildProcess = spawn('/proc/self/fd/3', [], {
            env: {
                LANG: 'C',
                LC_ALL: 'C',
                NERVA_CONNECTOR_PARENT_PID: process.pid.toString(),
                NERVA_CONNECTOR_FILE_MODE: writable
                    ? ConnectorFileMode.ReadWrite
                    : ConnectorFileMode.ReadOnly,
                ...(effect === undefined ? {} : { NERVA_CONNECTOR_FILE_EFFECT: 'required' }),
            },
            stdio: descriptors,
        });
        const closed: PromiseWithResolvers<undefined> = Promise.withResolvers<undefined>();
        const result: PromiseWithResolvers<ConnectorNativeOutcome<T>> =
            Promise.withResolvers<ConnectorNativeOutcome<T>>();
        const record: ConnectorNativeChild = { process: child, closed: closed.promise };
        this.#children.add(record);
        const contextPipe: Stream | null | undefined = child.stdio.at(6);
        const output: Buffer[] = [];
        let size: number = 0;
        let errors: number = 0;
        let invalid: boolean = false;
        if (context !== null) {
            if (contextPipe instanceof Writable) {
                contextPipe.once('error', (): void => {
                    invalid = true;
                    child.kill('SIGKILL');
                });
                contextPipe.end(context);
            } else {
                invalid = true;
                child.kill('SIGKILL');
            }
        }
        const timeout: NodeJS.Timeout = setTimeout((): void => {
            invalid = true;
            child.kill('SIGKILL');
        }, 2500);
        child.stdout?.on('data', (chunk: Buffer): void => {
            size += chunk.byteLength;
            if (size > 65536) {
                invalid = true;
                child.kill('SIGKILL');
            } else {
                output.push(chunk);
            }
        });
        child.stderr?.on('data', (chunk: Buffer): void => {
            errors += chunk.byteLength;
            if (errors > 4096) {
                invalid = true;
                child.kill('SIGKILL');
            }
        });
        child.once('error', (): void => {
            invalid = true;
        });
        child.stdin?.once('error', (): void => {
            invalid = true;
            child.kill('SIGKILL');
        });
        child.once('close', (code: number | null, signal: NodeJS.Signals | null): void => {
            clearTimeout(timeout);
            this.#children.delete(record);
            closed.resolve(undefined);
            try {
                if (invalid || signal !== null || code !== 0) {
                    throw new Error('Native connector operation failed');
                }
                const raw: unknown = JSON.parse(
                    new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(output, size)),
                );
                result.resolve({ ok: true, value: decode(raw) });
            } catch {
                result.resolve({ ok: false });
            }
        });
        if (child.stdin === null) {
            invalid = true;
            child.kill('SIGKILL');
        } else {
            child.stdin.end(payload);
        }
        return await result.promise;
    }

    /** Shutdown joins real kernel child termination before the surrounding owner closes borrowed capabilities. */
    public async [Symbol.asyncDispose](): Promise<void> {
        this.#closed = true;
        for (const child of this.#children) {
            child.process.kill('SIGKILL');
        }
        await Promise.allSettled(
            [...this.#children].map((child: ConnectorNativeChild): Promise<void> => child.closed),
        );
    }
}
