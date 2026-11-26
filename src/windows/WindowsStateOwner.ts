// SPDX-FileCopyrightText: 2026 Dacely <business@dacely.com>
// SPDX-License-Identifier: LicenseRef-Proprietary

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { win32 } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Boundary } from 'nerva-connector-protocol/protocol/Boundary.js';
import { WindowsStateExecutable } from './WindowsStateExecutable.js';
import { WindowsStateRequestCodec } from './WindowsStateRequestCodec.js';
import { ProtectedFileLimits } from '../local/ProtectedFileLimits.js';
import type { WindowsStateArtifactMetadata } from './WindowsStateArtifactMetadata.js';
import {
    WindowsStateOperation,
    WindowsStateFailure,
    WindowsStateError,
    WindowsStateScope,
    WindowsStateCheck,
    type WindowsStateDiagnostic,
    type WindowsStateParameters,
    type WindowsStateRequest,
    type WindowsStateResponse,
} from './WindowsStateProtocol.js';

/** A pending local operation owns its finite timer and resolver, never a copy of its private input. */
interface WindowsStatePending {
    readonly ready: PromiseWithResolvers<WindowsStateResponse>;
    readonly timer: NodeJS.Timeout;
}

/** A caller's lease names the helper generation that issued it and that helper's own opaque token. */
interface WindowsStateLease {
    readonly generation: bigint;
    readonly token: string;
}

/**
 * One Windows process owns a bounded native bridge; all protected I/O is performed against its validated handles.
 *
 * @remarks
 * A helper that stops after it has answered is replaced on the next request that does not name a lease. Its leases
 * ended with its process, so requests naming them fail with {@link WindowsStateFailure.Stopped} instead of reaching
 * a replacement, and {@link WindowsStateOwner.release} treats them as already released. A replacement starts only
 * after the stopped process has exited, so it never meets that process's directory locks.
 */
export class WindowsStateOwner {
    static readonly #replyMs: number = 30000;
    static readonly #stallMs: number = 1000;
    static readonly #exitMs: number = 5000;
    static readonly #local: ReadonlySet<WindowsStateFailure> = new Set([
        WindowsStateFailure.Unavailable,
        WindowsStateFailure.Stopped,
        WindowsStateFailure.HelperMissing,
        WindowsStateFailure.HelperUntrusted,
    ]);
    static #current: WindowsStateOwner | null = null;
    static #opening: Promise<void> | null = null;
    static #closing: Promise<void> | null = null;
    static #generations: bigint = 0n;
    readonly #generation: bigint;
    readonly #child: ChildProcessWithoutNullStreams;
    readonly #decoder: TextDecoder = new TextDecoder('utf-8', { fatal: true });
    readonly #pending: Map<string, WindowsStatePending> = new Map();
    readonly #done: PromiseWithResolvers<undefined> = Promise.withResolvers<undefined>();
    #counter: bigint = 0n;
    #buffer: string = '';
    #answered: boolean = false;
    #ended: boolean = false;
    #closed: boolean = false;

    private constructor(executable: string) {
        const root: string | undefined = process.env['SystemRoot'];
        if (
            process.platform !== 'win32' ||
            root === undefined ||
            !/^[A-Za-z]:\\/u.test(root) ||
            win32.resolve(root) !== root
        ) {
            throw new WindowsStateError(WindowsStateFailure.Unavailable);
        }
        this.#generation = ++WindowsStateOwner.#generations;
        this.#child = spawn(executable, [], {
            stdio: ['pipe', 'pipe', 'pipe'],
            windowsHide: true,
            cwd: root,
            env: process.env,
        });
        this.#child.once('error', (): void => this.#fail(this.#lost()));
        this.#child.once('close', (): void => {
            this.#ended = true;
            this.#fail(this.#lost());
            this.#done.resolve(undefined);
        });
        this.#child.stdin.on('error', (): void => this.#fail(this.#lost()));
        this.#child.stdout.on('data', (bytes: Buffer): void => this.#receive(bytes));
        let diagnostics: number = 0;
        this.#child.stderr.on('data', (bytes: Buffer): void => {
            diagnostics += bytes.byteLength;
            if (diagnostics > 16384) {
                this.#fail(this.#lost());
            }
        });
    }

    /**
     * Only this fixed native protocol may access private state on Windows.
     *
     * @remarks
     * A request that names a lease goes only to the helper that issued it. Any other request starts a helper when
     * none is running, including after an earlier one stopped.
     *
     * @throws {@link WindowsStateError} With {@link WindowsStateFailure.Stopped} when the lease's helper has stopped
     * or the connector is shutting down
     */
    public static async request(
        operation: WindowsStateOperation,
        parameters: WindowsStateParameters = {},
    ): Promise<WindowsStateResponse> {
        if (process.platform !== 'win32') {
            throw new WindowsStateError(WindowsStateFailure.Unavailable);
        }
        if (parameters.lease !== undefined) {
            const lease: WindowsStateLease = this.#parse(parameters.lease);
            const issuer: WindowsStateOwner | null = this.#current;
            if (
                this.#closing !== null ||
                issuer === null ||
                issuer.#closed ||
                issuer.#generation !== lease.generation
            ) {
                throw new WindowsStateError(WindowsStateFailure.Stopped);
            }
            return await issuer.#request(operation, { ...parameters, lease: lease.token });
        }
        const current: WindowsStateOwner = await this.#live();
        const response: WindowsStateResponse = await current.#request(operation, parameters);
        return response.lease === null
            ? response
            : { ...response, lease: current.#generation.toString() + '.' + response.lease };
    }

    /**
     * Ends one directory lease and its kernel lock.
     *
     * @remarks
     * A lease whose helper has stopped was already released when that process exited, so closing it succeeds
     * without starting another helper.
     */
    public static async release(lease: string): Promise<void> {
        try {
            await this.request(WindowsStateOperation.Close, { lease });
        } catch (caught: unknown) {
            if (
                !(caught instanceof WindowsStateError) ||
                caught.failure !== WindowsStateFailure.Stopped
            ) {
                throw caught;
            }
        }
    }

    /** Entry-point shutdown joins the owned helper; it never changes account enrollment or deletes state. */
    public static async close(): Promise<void> {
        const closing: Promise<void> = (this.#closing ??= this.#shutdown());
        try {
            await closing;
        } finally {
            if (this.#closing === closing) {
                this.#closing = null;
            }
        }
    }

    static async #open(): Promise<void> {
        try {
            this.#current = new WindowsStateOwner(await WindowsStateExecutable.path());
        } finally {
            this.#opening = null;
        }
    }

    /** Returns the running helper, starting one at most once per call after a stopped helper has exited. */
    static async #live(): Promise<WindowsStateOwner> {
        let started: boolean = false;
        for (;;) {
            if (this.#closing !== null) {
                throw new WindowsStateError(WindowsStateFailure.Stopped);
            }
            const current: WindowsStateOwner | null = this.#current;
            if (current !== null && !current.#closed) {
                return current;
            }
            if (current !== null) {
                await current.#exited();
                if (this.#current === current) {
                    this.#current = null;
                }
                continue;
            }
            if (started) {
                throw new WindowsStateError(WindowsStateFailure.Unavailable);
            }
            started = true;
            await (this.#opening ??= this.#open());
        }
    }

    static #parse(lease: string): WindowsStateLease {
        const match: RegExpExecArray | null = /^([1-9][0-9]{0,19})\.(.{1,128})$/su.exec(lease);
        const generation: string | undefined = match?.[1];
        const token: string | undefined = match?.[2];
        if (
            generation === undefined ||
            token === undefined ||
            BigInt(generation) > this.#generations
        ) {
            throw new WindowsStateError(WindowsStateFailure.Invalid);
        }
        return { generation: BigInt(generation), token };
    }

    static async #shutdown(): Promise<void> {
        if (this.#opening !== null) {
            await Promise.allSettled([this.#opening]);
        }
        const current: WindowsStateOwner | null = this.#current;
        this.#current = null;
        if (current === null) {
            return;
        }
        current.#closed = true;
        current.#reject(WindowsStateFailure.Stopped);
        current.#child.stdin.end();
        await current.#settle();
        if (!current.#ended) {
            current.#child.kill();
            await current.#done.promise;
        }
    }

    /** Native bytes retain ordinary bounds; a named lease read permits the reserved encrypted host receipt budget. */
    public static bytes(
        response: WindowsStateResponse,
        maximum: number,
        name: string | null = null,
    ): Buffer {
        const limit: number =
            name === null ? ProtectedFileLimits.ordinaryBytes : ProtectedFileLimits.maximum(name);
        if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > limit) {
            throw new WindowsStateError(WindowsStateFailure.Limit);
        }
        const encoded: string | null = response.dataBase64;
        if (encoded === null || encoded.length > Math.ceil(maximum / 3) * 4) {
            throw new WindowsStateError(WindowsStateFailure.Invalid);
        }
        const bytes: Buffer = Buffer.from(encoded, 'base64');
        if (bytes.byteLength > maximum || bytes.toString('base64') !== encoded) {
            bytes.fill(0);
            throw new WindowsStateError(WindowsStateFailure.Invalid);
        }
        return bytes;
    }

    /** Streamed artifacts expose only bounded exact metadata, never a large IPC allocation. */
    public static artifact(
        response: WindowsStateResponse,
        maximumBytes: number,
    ): WindowsStateArtifactMetadata {
        if (
            !Number.isSafeInteger(maximumBytes) ||
            maximumBytes < 1 ||
            maximumBytes > 268435456 ||
            !response.ok ||
            response.sizeBytes === null ||
            response.sizeBytes < 1n ||
            response.sizeBytes > BigInt(maximumBytes) ||
            response.sha256 === null ||
            !/^[a-f0-9]{64}$/u.test(response.sha256)
        ) {
            throw new WindowsStateError(WindowsStateFailure.Invalid);
        }
        return { sizeBytes: response.sizeBytes, sha256: response.sha256 };
    }

    async #request(
        operation: WindowsStateOperation,
        parameters: WindowsStateParameters,
    ): Promise<WindowsStateResponse> {
        if (this.#closed || this.#pending.size >= 16) {
            throw new WindowsStateError(
                this.#closed ? WindowsStateFailure.Stopped : WindowsStateFailure.Busy,
            );
        }
        const id: string = (++this.#counter).toString();
        const request: WindowsStateRequest = WindowsStateRequestCodec.create(
            id,
            operation,
            parameters,
        );
        const encoded: string = JSON.stringify(request);
        if (Buffer.byteLength(encoded) > ProtectedFileLimits.nativeFrameBytes) {
            throw new WindowsStateError(WindowsStateFailure.Limit);
        }
        const ready: PromiseWithResolvers<WindowsStateResponse> =
            Promise.withResolvers<WindowsStateResponse>();
        this.#pending.set(id, { ready, timer: this.#deadline(id) });
        this.#child.stdin.write(encoded + '\n');
        const response: WindowsStateResponse = await ready.promise;
        if (!response.ok) {
            throw new WindowsStateError(
                response.error ?? WindowsStateFailure.Invalid,
                response.diagnostic,
            );
        }
        return response;
    }

    #receive(bytes: Buffer): void {
        if (this.#closed) {
            return;
        }
        try {
            this.#buffer += this.#decoder.decode(bytes, { stream: true });
        } catch {
            this.#fail(WindowsStateFailure.Invalid);
            return;
        }
        if (Buffer.byteLength(this.#buffer) > ProtectedFileLimits.nativeFrameBytes) {
            this.#fail(WindowsStateFailure.Limit);
            return;
        }
        for (;;) {
            const end: number = this.#buffer.indexOf('\n');
            if (end < 0) {
                return;
            }
            const line: string = this.#buffer.slice(0, end).replace(/\r$/u, '');
            this.#buffer = this.#buffer.slice(end + 1);
            try {
                const response: WindowsStateResponse = WindowsStateOwner.decode(JSON.parse(line));
                const pending: WindowsStatePending | undefined = this.#pending.get(response.id);
                if (pending === undefined) {
                    throw new WindowsStateError(WindowsStateFailure.Invalid);
                }
                this.#pending.delete(response.id);
                clearTimeout(pending.timer);
                this.#answered = true;
                pending.ready.resolve(response);
            } catch {
                this.#fail(WindowsStateFailure.Invalid);
                return;
            }
        }
    }

    /** Local native output is still an untrusted boundary: exact fields, finite codes and bounded text are mandatory. */
    public static decode(raw: unknown): WindowsStateResponse {
        const value: Readonly<Record<string, unknown>> = Boundary.record(raw, [
            'id',
            'ok',
            'path',
            'lease',
            'exists',
            'names',
            'dataBase64',
            'error',
            'diagnostic',
            'sizeBytes',
            'sha256',
        ]);
        if (
            typeof value['id'] !== 'string' ||
            !/^[1-9][0-9]{0,19}$/u.test(value['id']) ||
            typeof value['ok'] !== 'boolean' ||
            (value['exists'] !== null && typeof value['exists'] !== 'boolean')
        ) {
            throw new WindowsStateError(WindowsStateFailure.Invalid);
        }
        const text: (raw: unknown, maximum: number) => string | null = (
            raw: unknown,
            maximum: number,
        ): string | null => {
            if (raw === null) {
                return null;
            }
            if (typeof raw !== 'string' || raw.length > maximum || !raw.isWellFormed()) {
                throw new WindowsStateError(WindowsStateFailure.Invalid);
            }
            return raw;
        };
        const error: WindowsStateFailure | null | undefined =
            value['error'] === null
                ? null
                : Object.values(WindowsStateFailure).find(
                      (failure: WindowsStateFailure): boolean =>
                          failure.valueOf() === value['error'] &&
                          !WindowsStateOwner.#local.has(failure),
                  );
        if (error === undefined || value['ok'] !== (error === null)) {
            throw new WindowsStateError(WindowsStateFailure.Invalid);
        }
        const diagnostic: WindowsStateDiagnostic | undefined = WindowsStateOwner.#diagnostic(
            value['diagnostic'],
            error,
        );
        const rawSize: unknown = value['sizeBytes'];
        const rawHash: unknown = value['sha256'];
        if (
            (rawSize === null) !== (rawHash === null) ||
            (rawSize !== null &&
                (!value['ok'] ||
                    typeof rawSize !== 'string' ||
                    !/^[1-9][0-9]{0,8}$/u.test(rawSize) ||
                    BigInt(rawSize) > 268435456n ||
                    typeof rawHash !== 'string' ||
                    !/^[a-f0-9]{64}$/u.test(rawHash)))
        ) {
            throw new WindowsStateError(WindowsStateFailure.Invalid);
        }
        return {
            id: value['id'],
            ok: value['ok'],
            path: text(value['path'], 4096),
            lease: text(value['lease'], 128),
            exists: value['exists'],
            names:
                value['names'] === null
                    ? null
                    : Boundary.array(value['names'], 128).map((name: unknown): string => {
                          const result: string | null = text(name, 255);
                          if (result === null || result.length === 0) {
                              throw new WindowsStateError(WindowsStateFailure.Invalid);
                          }
                          return result;
                      }),
            dataBase64: text(
                value['dataBase64'],
                Math.ceil(ProtectedFileLimits.hostRecordBytes / 3) * 4,
            ),
            error,
            ...(diagnostic === undefined ? {} : { diagnostic }),
            sizeBytes: typeof rawSize === 'string' ? BigInt(rawSize) : null,
            sha256: typeof rawHash === 'string' ? rawHash : null,
        };
    }

    static #diagnostic(
        raw: unknown,
        error: WindowsStateFailure | null,
    ): WindowsStateDiagnostic | undefined {
        if (raw === undefined) {
            return undefined;
        }
        if (error !== WindowsStateFailure.Untrusted || typeof raw !== 'string' || raw.length > 64) {
            throw new WindowsStateError(WindowsStateFailure.Invalid);
        }
        const [scope, check, extra]: string[] = raw.split('/');
        const matchedScope: WindowsStateScope | undefined = Object.values(WindowsStateScope).find(
            (value: WindowsStateScope): boolean => value === scope,
        );
        const matchedCheck: WindowsStateCheck | undefined = Object.values(WindowsStateCheck).find(
            (value: WindowsStateCheck): boolean => value === check,
        );
        if (matchedScope === undefined || matchedCheck === undefined || extra !== undefined) {
            throw new WindowsStateError(WindowsStateFailure.Invalid);
        }
        return `${matchedScope}/${matchedCheck}`;
    }

    /**
     * A reply is due within the reply window of responsive event-loop time.
     *
     * @remarks
     * Timers run before pending pipe input is read, so after the connector's own event loop was blocked an expired
     * deadline says nothing about the helper: its reply may already be waiting. Such a late deadline starts a fresh
     * window instead of stopping a helper that answered.
     */
    #deadline(id: string): NodeJS.Timeout {
        const due: number = performance.now() + WindowsStateOwner.#replyMs;
        return setTimeout((): void => {
            const pending: WindowsStatePending | undefined = this.#pending.get(id);
            if (pending === undefined) {
                return;
            }
            if (performance.now() - due > WindowsStateOwner.#stallMs) {
                this.#pending.set(id, { ready: pending.ready, timer: this.#deadline(id) });
                return;
            }
            this.#fail(WindowsStateFailure.Stopped);
        }, WindowsStateOwner.#replyMs);
    }

    /** A helper that never answered could not start; one that answered before ending has stopped. */
    #lost(): WindowsStateFailure {
        return this.#answered ? WindowsStateFailure.Stopped : WindowsStateFailure.Unavailable;
    }

    /** Waits a bounded time for the process to exit. */
    async #settle(): Promise<void> {
        const stop: AbortController = new AbortController();
        try {
            await Promise.race([
                this.#done.promise,
                delay(WindowsStateOwner.#exitMs, undefined, { signal: stop.signal }),
            ]);
        } finally {
            stop.abort();
        }
    }

    /** A replacement helper starts only once this one has exited and released its leases. */
    async #exited(): Promise<void> {
        await this.#settle();
        if (!this.#ended) {
            throw new WindowsStateError(WindowsStateFailure.Stopped);
        }
    }

    #reject(failure: WindowsStateFailure): void {
        for (const pending of this.#pending.values()) {
            clearTimeout(pending.timer);
            pending.ready.reject(new WindowsStateError(failure));
        }
        this.#pending.clear();
    }

    #fail(failure: WindowsStateFailure): void {
        this.#closed = true;
        this.#reject(failure);
        this.#child.stdin.destroy();
        if (!this.#ended) {
            this.#child.kill();
        }
    }
}
