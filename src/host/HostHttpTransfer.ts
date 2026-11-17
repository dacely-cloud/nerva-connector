// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

import { Agent, request as requestHttp, type ClientRequest, type IncomingMessage } from 'node:http';
import { Agent as TlsAgent, request as requestTls, type RequestOptions } from 'node:https';
import type { LookupOptions } from 'node:dns';
import { isIP, type LookupFunction, type Socket } from 'node:net';
import {
    HostHttpFailure,
    HostHttpMethod,
    HostHttpState,
    type HostHttpHead,
    type HostHttpRead,
    type HostHttpRequest,
    type HostHttpTrust,
} from './HostHttpTypes.js';
import { HostHttpValidation } from './HostHttpValidation.js';

/** Node forwards the connection high-water mark to its private HTTP agent and socket. */
interface HostHttpConnectionOptions extends RequestOptions {
    readonly highWaterMark: number;
}

/** A private pinned HTTP connection retains its actual request and socket through joined cleanup. */
export class HostHttpTransfer {
    #agent: Agent | null = null;
    #request: ClientRequest | null = null;
    #response: IncomingMessage | null = null;
    #socket: Socket | null = null;
    #head: PromiseWithResolvers<HostHttpHead> | null = null;
    #headSettled: Promise<readonly PromiseSettledResult<HostHttpHead>[]> | null = null;
    #requestClosed: PromiseWithResolvers<undefined> | null = null;
    #socketClosed: PromiseWithResolvers<undefined> | null = null;
    #headerTimer: NodeJS.Timeout | null = null;
    #lifetime: NodeJS.Timeout | null = null;
    #offset: bigint = 0n;
    #state: HostHttpState = HostHttpState.Pending;
    #failure: HostHttpFailure | null = null;
    #last: HostHttpRead | null = null;
    #lastMaximum: number = 0;
    #expected: bigint | null = null;
    #noBody: boolean = false;
    #closing: Promise<void> | null = null;
    #closed: boolean = false;

    /** Construction performs no network I/O, allowing its pool to retain ownership before start. */
    public constructor(
        public readonly id: string,
        public readonly input: HostHttpRequest,
    ) {}

    /** Node is already the connector runtime on Windows and POSIX; no shell, Python or runtime compiler is needed. */
    public async start(signal: AbortSignal, trust?: HostHttpTrust): Promise<HostHttpHead> {
        signal.throwIfAborted();
        if (this.#request !== null || this.#closed) {
            throw new Error('Native HTTP transfer cannot be restarted');
        }
        const url: URL = HostHttpValidation.request(this.input);
        const hostname: string = url.hostname.replace(/^\[|\]$/gu, '');
        const lookup: LookupFunction = (
            _hostname: string,
            options: LookupOptions,
            callback: Parameters<LookupFunction>[2],
        ): void => {
            const family: number = isIP(this.input.address);
            if (options.all === true) {
                callback(null, [{ address: this.input.address, family }]);
            } else {
                callback(null, this.input.address, family);
            }
        };
        this.#agent =
            url.protocol === 'https:'
                ? new TlsAgent({
                      keepAlive: false,
                      proxyEnv: {},
                      ...(trust === undefined ? {} : { ca: [...trust.certificates] }),
                  })
                : new Agent({ keepAlive: false, proxyEnv: {} });
        const options: HostHttpConnectionOptions = {
            protocol: url.protocol,
            hostname,
            port: url.port === '' ? (url.protocol === 'https:' ? 443 : 80) : Number(url.port),
            path: url.pathname + url.search,
            method: this.input.method,
            headers: {
                ...this.input.headers,
                host: url.host,
                connection: 'close',
                'accept-encoding': 'identity',
            },
            lookup,
            agent: this.#agent,
            maxHeaderSize: 32768,
            highWaterMark: 32768,
            ...(isIP(hostname) === 0 ? { servername: hostname } : {}),
        };
        this.#head = Promise.withResolvers<HostHttpHead>();
        this.#headSettled = Promise.allSettled([this.#head.promise]);
        this.#requestClosed = Promise.withResolvers<undefined>();
        const stop: () => void = (): void => this.#fail(HostHttpFailure.Canceled);
        signal.addEventListener('abort', stop, { once: true });
        try {
            this.#request = (url.protocol === 'https:' ? requestTls : requestHttp)(
                options,
                (response: IncomingMessage): void => this.#opened(response),
            );
            this.#request.maxHeadersCount = 101;
            this.#request.once('error', (): void => this.#fail(HostHttpFailure.Network));
            this.#request.once('close', (): void => this.#requestClosed?.resolve(undefined));
            this.#request.once('socket', (socket: Socket): void => {
                this.#socket = socket;
                this.#socketClosed = Promise.withResolvers<undefined>();
                socket.once('close', (): void => this.#socketClosed?.resolve(undefined));
                socket.setTimeout(this.input.idleTimeoutMs, (): void =>
                    this.#fail(HostHttpFailure.Timeout),
                );
                if (this.#closed) {
                    socket.destroy();
                }
            });
            this.#request.once('upgrade', (_response: IncomingMessage, socket: Socket): void => {
                socket.destroy();
                this.#fail(HostHttpFailure.Network);
            });
            this.#headerTimer = setTimeout((): void => this.#fail(HostHttpFailure.Timeout), 10000);
            this.#lifetime = setTimeout(
                (): void => this.#fail(HostHttpFailure.Timeout),
                this.input.timeoutMs,
            );
            this.#request.end();
            return await this.#head.promise;
        } catch (caught: unknown) {
            if (this.#request === null) {
                this.#requestClosed.resolve(undefined);
            }
            this.#fail(HostHttpFailure.Network);
            throw caught;
        } finally {
            signal.removeEventListener('abort', stop);
        }
    }

    /** Exact sequential pulls use the bounded native readable buffer and its TCP backpressure; no body ring evicts bytes. */
    public read(offset: bigint, maximum: number): HostHttpRead {
        if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > 1048576 || offset < 0n) {
            throw new Error('Invalid native HTTP read window');
        }
        if (offset !== this.#offset) {
            if (this.#last?.offset === offset && this.#lastMaximum === maximum) {
                return this.#last;
            }
            throw new Error('Native HTTP body cursor changed');
        }
        const response: IncomingMessage | null = this.#response;
        if (response === null || this.#closed) {
            throw new Error('Native HTTP body is unavailable');
        }
        let bytes: Uint8Array = new Uint8Array();
        if (this.#state === HostHttpState.Pending) {
            const length: number = Math.min(maximum, response.readableLength, 32768);
            const raw: unknown = response.read(length);
            if (raw !== null) {
                if (!(raw instanceof Uint8Array) || raw.byteLength > length) {
                    this.#fail(HostHttpFailure.Network);
                } else if (this.#offset + BigInt(raw.byteLength) > this.input.maximumBytes) {
                    this.#fail(HostHttpFailure.Limit);
                } else {
                    bytes = raw;
                    this.#offset += BigInt(raw.byteLength);
                    if (raw.byteLength !== 0) {
                        this.#socket?.setTimeout(this.input.idleTimeoutMs);
                    }
                }
            }
        }
        const result: HostHttpRead = {
            transferId: this.id,
            offset,
            nextOffset: this.#offset,
            bytes,
            state: this.#state,
            failure: this.#failure,
        };
        if (bytes.byteLength !== 0) {
            this.#last = result;
            this.#lastMaximum = maximum;
        }
        return result;
    }

    /** Abort precedes the physical request/socket join; an unconfirmed close remains owned for retry. */
    public close(): Promise<void> {
        return (this.#closing ??= this.#close());
    }

    #opened(response: IncomingMessage): void {
        this.#response = response;
        response.once('error', (): void => this.#fail(HostHttpFailure.Network));
        response.once('aborted', (): void => this.#fail(HostHttpFailure.Network));
        response.once('end', (): void => {
            if (
                this.#state === HostHttpState.Pending &&
                response.complete &&
                (this.#noBody || this.#expected === null || this.#offset === this.#expected)
            ) {
                this.#state = HostHttpState.Complete;
                this.#clearTimers();
            } else if (this.#state === HostHttpState.Pending) {
                this.#fail(HostHttpFailure.Network);
            }
        });
        const status: number | undefined = response.statusCode;
        const headers: [string, string][] = [];
        if (
            status === undefined ||
            status < 200 ||
            status > 599 ||
            response.rawHeaders.length > 200
        ) {
            this.#fail(HostHttpFailure.Network);
            return;
        }
        for (let index: number = 0; index < response.rawHeaders.length; index += 2) {
            const name: string | undefined = response.rawHeaders[index];
            const value: string | undefined = response.rawHeaders[index + 1];
            if (name === undefined || value === undefined) {
                this.#fail(HostHttpFailure.Network);
                return;
            }
            headers.push([name, value]);
        }
        const lengths: readonly string[] = headers
            .filter(
                (pair: readonly [string, string]): boolean =>
                    pair[0].toLowerCase() === 'content-length',
            )
            .map((pair: readonly [string, string]): string => pair[1].trim());
        if (
            lengths.length > 1 ||
            lengths.some((value: string): boolean => !/^(0|[1-9][0-9]*)$/u.test(value))
        ) {
            this.#fail(HostHttpFailure.Network);
            return;
        }
        this.#expected = lengths[0] === undefined ? null : BigInt(lengths[0]);
        this.#noBody =
            this.input.method === HostHttpMethod.Head || status === 204 || status === 304;
        if (!this.#noBody && this.#expected !== null && this.#expected > this.input.maximumBytes) {
            this.#fail(HostHttpFailure.Limit);
            return;
        }
        if (this.#headerTimer !== null) {
            clearTimeout(this.#headerTimer);
            this.#headerTimer = null;
        }
        this.#head?.resolve({
            transferId: this.id,
            status,
            headers,
            contentLength: this.#expected,
        });
    }

    #fail(failure: HostHttpFailure): void {
        if (this.#state !== HostHttpState.Pending) {
            return;
        }
        this.#state = HostHttpState.Failed;
        this.#failure = failure;
        this.#clearTimers();
        this.#head?.reject(new Error('Native HTTP request failed: ' + failure));
        this.#response?.destroy();
        this.#request?.destroy();
        this.#socket?.destroy();
        this.#agent?.destroy();
    }

    #clearTimers(): void {
        if (this.#headerTimer !== null) {
            clearTimeout(this.#headerTimer);
            this.#headerTimer = null;
        }
        if (this.#lifetime !== null) {
            clearTimeout(this.#lifetime);
            this.#lifetime = null;
        }
    }

    async #close(): Promise<void> {
        this.#closed = true;
        this.#fail(HostHttpFailure.Canceled);
        this.#clearTimers();
        this.#response?.destroy();
        this.#request?.destroy();
        this.#socket?.destroy();
        this.#agent?.destroy();
        const timeout: PromiseWithResolvers<undefined> = Promise.withResolvers<undefined>();
        const timer: NodeJS.Timeout = setTimeout((): void => {
            timeout.reject(new Error('Native HTTP socket shutdown is unconfirmed'));
        }, 10000);
        try {
            await Promise.race([this.#join(), timeout.promise]);
        } catch (caught: unknown) {
            this.#closing = null;
            throw caught;
        } finally {
            clearTimeout(timer);
        }
    }

    async #join(): Promise<void> {
        await this.#requestClosed?.promise;
        await this.#socketClosed?.promise;
        await this.#headSettled;
    }
}
