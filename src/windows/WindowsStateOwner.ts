// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { win32 } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Boundary } from 'nerva-connector-protocol/protocol/Boundary.js';
import { WindowsStateExecutable } from './WindowsStateExecutable.js';
import { WindowsStateRequestCodec } from './WindowsStateRequestCodec.js';
import type { WindowsStateArtifactMetadata } from './WindowsStateArtifactMetadata.js';
import {
    WindowsStateOperation,
    WindowsStateFailure,
    WindowsStateError,
    type WindowsStateParameters,
    type WindowsStateRequest,
    type WindowsStateResponse,
} from './WindowsStateProtocol.js';

/** A pending local operation owns its finite timer and resolver, never a copy of its private input. */
interface WindowsStatePending {
    readonly ready: PromiseWithResolvers<WindowsStateResponse>;
    readonly timer: NodeJS.Timeout;
}

/** One Windows process owns a bounded native bridge; all protected I/O is performed against its validated handles. */
export class WindowsStateOwner {
    static #current: WindowsStateOwner | null = null;
    static #opening: Promise<void> | null = null;
    static #closing: Promise<void> | null = null;
    readonly #child: ChildProcessWithoutNullStreams;
    readonly #decoder: TextDecoder = new TextDecoder('utf-8', { fatal: true });
    readonly #pending: Map<string, WindowsStatePending> = new Map();
    readonly #done: PromiseWithResolvers<undefined> = Promise.withResolvers<undefined>();
    #counter: bigint = 0n;
    #buffer: string = '';
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
        this.#child = spawn(executable, [], {
            stdio: ['pipe', 'pipe', 'pipe'],
            windowsHide: true,
            cwd: root,
            env: process.env,
        });
        this.#child.once('error', (): void => this.#fail(WindowsStateFailure.Unavailable));
        this.#child.once('close', (): void => {
            this.#ended = true;
            this.#fail(WindowsStateFailure.Unavailable);
            this.#done.resolve(undefined);
        });
        this.#child.stdin.on('error', (): void => this.#fail(WindowsStateFailure.Io));
        this.#child.stdout.on('data', (bytes: Buffer): void => this.#receive(bytes));
        let diagnostics: number = 0;
        this.#child.stderr.on('data', (bytes: Buffer): void => {
            diagnostics += bytes.byteLength;
            if (diagnostics > 16384) {
                this.#fail(WindowsStateFailure.Unavailable);
            }
        });
    }

    /** Only this fixed native protocol may access private state on Windows. */
    public static async request(
        operation: WindowsStateOperation,
        parameters: WindowsStateParameters = {},
    ): Promise<WindowsStateResponse> {
        if (process.platform !== 'win32') {
            throw new WindowsStateError(WindowsStateFailure.Unavailable);
        }
        if (this.#closing !== null) {
            throw new WindowsStateError(WindowsStateFailure.Unavailable);
        }
        if (this.#current === null) {
            await (this.#opening ??= this.#open());
        }
        const current: WindowsStateOwner | null = this.#current;
        if (current === null || this.#closing !== null) {
            throw new WindowsStateError(WindowsStateFailure.Unavailable);
        }
        return await current.#request(operation, parameters);
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
        current.#reject(WindowsStateFailure.Io);
        current.#child.stdin.end();
        const stop: AbortController = new AbortController();
        try {
            await Promise.race([
                current.#done.promise,
                delay(5000, undefined, { signal: stop.signal }),
            ]);
        } finally {
            stop.abort();
        }
        if (!current.#ended) {
            current.#child.kill();
            await current.#done.promise;
        }
    }

    /** Native bytes are canonical base64 and bounded again before allocation escapes the process boundary. */
    public static bytes(response: WindowsStateResponse, maximum: number): Buffer {
        if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > 1048576) {
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
                this.#closed ? WindowsStateFailure.Unavailable : WindowsStateFailure.Busy,
            );
        }
        const id: string = (++this.#counter).toString();
        const request: WindowsStateRequest = WindowsStateRequestCodec.create(
            id,
            operation,
            parameters,
        );
        const encoded: string = JSON.stringify(request);
        if (Buffer.byteLength(encoded) > 1500000) {
            throw new WindowsStateError(WindowsStateFailure.Limit);
        }
        const ready: PromiseWithResolvers<WindowsStateResponse> =
            Promise.withResolvers<WindowsStateResponse>();
        const timer: NodeJS.Timeout = setTimeout(
            (): void => this.#fail(WindowsStateFailure.Io),
            30000,
        );
        this.#pending.set(id, { ready, timer });
        this.#child.stdin.write(encoded + '\n');
        const response: WindowsStateResponse = await ready.promise;
        if (!response.ok) {
            throw new WindowsStateError(response.error ?? WindowsStateFailure.Invalid);
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
        if (Buffer.byteLength(this.#buffer) > 1500000) {
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
                          failure.valueOf() === value['error'],
                  );
        if (error === undefined || value['ok'] !== (error === null)) {
            throw new WindowsStateError(WindowsStateFailure.Invalid);
        }
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
            dataBase64: text(value['dataBase64'], 1400000),
            error,
            sizeBytes: typeof rawSize === 'string' ? BigInt(rawSize) : null,
            sha256: typeof rawHash === 'string' ? rawHash : null,
        };
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
