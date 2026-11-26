// SPDX-FileCopyrightText: 2026 Dacely <business@dacely.com>
// SPDX-License-Identifier: LicenseRef-Proprietary

import { ConnectorHostLimits } from 'nerva-connector-protocol/protocol/ConnectorHost.js';
import { request as httpsRequest } from 'node:https';
import type { ClientRequest, IncomingHttpHeaders, IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { isIP, type Socket } from 'node:net';
import {
    ConnectorStartupStage,
    type ConnectorStartupObserver,
} from '../runtime/ConnectorStartup.js';

/** Per-connection native WebSocket parser limits apply before assembling messages. */
interface NativeWebSocketLimits {
    readonly maxFragments: number;
    readonly maxPayloadSize: number;
}

/** A callback read from Node's built-in WebSocket handler; its arguments are fixed by this dispatcher. */
type NativeCallback = (...args: readonly unknown[]) => unknown;

/**
 * The upgrade lifecycle of Node's built-in WebSocket handler, independent of its callback names.
 *
 * @remarks
 * Undici 8 (Node 26) names the start and failure callbacks `onRequestStart` and
 * `onResponseError`; Undici 7 (Node 24) names them `onConnect` and `onError`. Both take the
 * upgrade through `onRequestUpgrade` and read the same per-dispatcher parser limits.
 */
interface NativeDispatchHandler {
    readonly start: () => void;
    readonly upgrade: (status: number, headers: IncomingHttpHeaders, socket: Duplex) => boolean;
    readonly fail: (error: Error) => void;
}

/** The native client owns WebSocket framing; this dispatcher owns verified HTTPS, finite upgrade admission and exact socket cancellation. */
export class NativeSocketDispatcher {
    readonly #target: URL;
    #request: ClientRequest | null = null;
    #socket: Duplex | null = null;
    #handler: NativeDispatchHandler | null = null;
    #timer: NodeJS.Timeout | null = null;
    #upgraded: boolean = false;
    #aborted: boolean = false;
    #reason: Error | null = null;
    #rejectedHttpStatus: number | null = null;
    #paused: boolean = false;
    /** Node's native parser reads these limits from its connection-specific dispatcher. */
    public readonly webSocketOptions: NativeWebSocketLimits;
    /** Exact upgrade headers are retained only for Node's native handshake verification. */
    public rawHeaders: string[] = [];

    /** No TLS process globals or trust pools are changed; enterprise CA bytes belong to this connection alone. */
    public constructor(
        endpoint: string,
        public readonly ca: Buffer | undefined,
        public readonly handshakeMs: number,
        maximumPayload: number,
        public readonly progress?: ConnectorStartupObserver,
    ) {
        this.#target = new URL(endpoint);
        if (
            this.#target.protocol !== 'wss:' ||
            this.#target.username !== '' ||
            this.#target.password !== '' ||
            this.#target.hash !== '' ||
            !Number.isSafeInteger(maximumPayload) ||
            maximumPayload < 1 ||
            maximumPayload > ConnectorHostLimits.frameBytes ||
            !Number.isSafeInteger(handshakeMs) ||
            handshakeMs < 1 ||
            handshakeMs > 60000
        ) {
            throw new Error('Invalid native connector transport configuration');
        }
        this.#target.protocol = 'https:';
        this.webSocketOptions = Object.freeze({ maxFragments: 64, maxPayloadSize: maximumPayload });
    }

    /** Dispatcher cancellation is visible to the native fetch/upgrade controller. */
    public get aborted(): boolean {
        return this.#aborted;
    }
    /** Read-side pause state is exposed through the public dispatcher controller contract. */
    public get paused(): boolean {
        return this.#paused;
    }
    /** The original native failure is available for code-based diagnostics. */
    public get reason(): Error | null {
        return this.#reason;
    }
    /** The verified HTTP response status when the peer rejected the upgrade. */
    public get rejectedHttpStatus(): number | null {
        return this.#rejectedHttpStatus;
    }
    /** The owner includes actual socket backlog in its finite send admission. */
    public get bufferedAmount(): number {
        return this.#socket?.writableLength ?? 0;
    }

    /** Native runtime data crosses this typed boundary before any network request is issued. */
    public dispatch(options: unknown, handler: unknown): boolean {
        const native: NativeDispatchHandler | null = this.#native(handler);
        if (this.#handler !== null || native === null) {
            throw new Error('Unsupported native WebSocket dispatcher invocation');
        }
        this.#handler = native;
        try {
            const headers: Readonly<Record<string, string>> = this.#headers(options);
            native.start();
            if (this.#aborted) {
                return true;
            }
            this.progress?.({
                stage:
                    isIP(this.#target.hostname.replace(/^\[|\]$/gu, '')) === 0
                        ? ConnectorStartupStage.Dns
                        : ConnectorStartupStage.Tcp,
            });
            const request: ClientRequest = httpsRequest(this.#target, {
                method: 'GET',
                headers,
                ca: this.ca,
                rejectUnauthorized: true,
                agent: false,
                maxHeaderSize: 16384,
            });
            this.#request = request;
            request.once('socket', (socket: Socket): void => {
                socket.once('lookup', (error: Error | null): void => {
                    if (!this.#aborted && error === null) {
                        this.progress?.({ stage: ConnectorStartupStage.Tcp });
                    }
                });
                socket.once('connect', (): void => {
                    if (!this.#aborted) {
                        this.progress?.({ stage: ConnectorStartupStage.Tls });
                    }
                });
                socket.once('secureConnect', (): void => {
                    if (!this.#aborted) {
                        this.progress?.({ stage: ConnectorStartupStage.Upgrade });
                    }
                });
            });
            this.#timer = setTimeout(
                (): void => this.abort(new Error('Native WebSocket upgrade expired')),
                this.handshakeMs,
            );
            request.once('error', (error: Error): void => this.#failure(error));
            request.once('response', (response: IncomingMessage): void => {
                const status: number | undefined = response.statusCode;
                if (
                    !this.#aborted &&
                    status !== undefined &&
                    Number.isInteger(status) &&
                    status >= 100 &&
                    status <= 599
                ) {
                    this.#rejectedHttpStatus = status;
                    this.progress?.({ stage: ConnectorStartupStage.Rejected, httpStatus: status });
                }
                response.destroy();
                this.abort(new Error('Native WebSocket upgrade rejected'));
            });
            request.once(
                'upgrade',
                (response: IncomingMessage, socket: Duplex, head: Buffer): void => {
                    try {
                        if (
                            this.#aborted ||
                            response.statusCode !== 101 ||
                            response.headers['sec-websocket-extensions'] !== undefined
                        ) {
                            socket.destroy();
                            throw new Error('Native WebSocket upgrade violated its contract');
                        }
                        this.#socket = socket;
                        socket.once('error', (error: Error): void => {
                            this.#reason ??= error;
                        });
                        this.#upgraded = true;
                        this.#clearTimer();
                        this.rawHeaders = response.rawHeaders;
                        if (head.byteLength > 0) {
                            socket.unshift(head);
                        }
                        if (!native.upgrade(101, response.headers, socket)) {
                            this.abort(new Error('Native WebSocket handshake rejected'));
                        }
                    } catch (caught: unknown) {
                        socket.destroy();
                        this.#upgraded = false;
                        this.#failure(
                            caught instanceof Error
                                ? caught
                                : new Error('Native WebSocket upgrade failed'),
                        );
                    }
                },
            );
            request.end();
        } catch (caught: unknown) {
            this.#failure(
                caught instanceof Error ? caught : new Error('Native WebSocket dispatch failed'),
            );
        }
        return true;
    }

    /** Aborts the exact upgrade or live native socket, including while connecting; no graceful-close timeout retains resources. */
    public abort(error: Error = new Error('Native WebSocket connection stopped')): void {
        if (this.#aborted) {
            return;
        }
        this.#aborted = true;
        this.#reason ??= error;
        this.#clearTimer();
        if (this.#upgraded) {
            this.#socket?.destroy();
        } else {
            this.#request?.destroy();
            this.#handler?.fail(error);
        }
    }

    /** Required dispatcher flow-control callbacks act only on this exact connection. */
    public pause(): void {
        this.#paused = true;
        this.#socket?.pause();
    }
    /** Required dispatcher flow-control callbacks act only on this exact connection. */
    public resume(): void {
        this.#paused = false;
        this.#socket?.resume();
    }

    #failure(error: Error): void {
        if (!this.#upgraded && !this.#aborted) {
            this.abort(error);
        }
    }
    #clearTimer(): void {
        if (this.#timer !== null) {
            clearTimeout(this.#timer);
            this.#timer = null;
        }
    }
    #headers(raw: unknown): Readonly<Record<string, string>> {
        if (
            typeof raw !== 'object' ||
            raw === null ||
            !('origin' in raw) ||
            raw.origin !== this.#target.origin ||
            !('path' in raw) ||
            raw.path !== this.#target.pathname + this.#target.search ||
            !('method' in raw) ||
            raw.method !== 'GET' ||
            !('upgrade' in raw) ||
            raw.upgrade !== 'websocket' ||
            !('headers' in raw) ||
            typeof raw.headers !== 'object' ||
            raw.headers === null ||
            Array.isArray(raw.headers)
        ) {
            throw new Error('Native WebSocket dispatcher target changed');
        }
        const headers: Record<string, string> = Object.create(null) as Record<string, string>;
        let size: number = 0;
        for (const [name, value] of Object.entries(raw.headers)) {
            if (
                !/^[a-z0-9!#$%&'*+.^_`|~-]{1,128}$/u.test(name) ||
                typeof value !== 'string' ||
                /[\r\n]/u.test(value)
            ) {
                throw new Error('Invalid native WebSocket request headers');
            }
            size += name.length + Buffer.byteLength(value);
            if (size > 16384 || ['authorization', 'cookie', 'proxy-authorization'].includes(name)) {
                throw new Error('Native WebSocket request headers exceed their authority');
            }
            if (name !== 'sec-websocket-extensions') {
                headers[name] = value;
            }
        }
        headers['connection'] = 'Upgrade';
        headers['upgrade'] = 'websocket';
        return headers;
    }
    /** Binds the handler's own callbacks to this exact connection, or rejects an unknown handler shape. */
    #native(raw: unknown): NativeDispatchHandler | null {
        if (typeof raw !== 'object' || raw === null) {
            return null;
        }
        const onRequestUpgrade: unknown = Reflect.get(raw, 'onRequestUpgrade');
        if (!NativeSocketDispatcher.#callable(onRequestUpgrade)) {
            return null;
        }
        const upgrade: NativeDispatchHandler['upgrade'] = (
            status: number,
            headers: IncomingHttpHeaders,
            socket: Duplex,
        ): boolean =>
            Reflect.apply(onRequestUpgrade, raw, [this, status, headers, socket]) === true;
        const onRequestStart: unknown = Reflect.get(raw, 'onRequestStart');
        const onResponseError: unknown = Reflect.get(raw, 'onResponseError');
        if (
            NativeSocketDispatcher.#callable(onRequestStart) &&
            NativeSocketDispatcher.#callable(onResponseError)
        ) {
            return {
                start: (): void => {
                    Reflect.apply(onRequestStart, raw, [this]);
                },
                upgrade,
                fail: (error: Error): void => {
                    Reflect.apply(onResponseError, raw, [this, error]);
                },
            };
        }
        const onConnect: unknown = Reflect.get(raw, 'onConnect');
        const onError: unknown = Reflect.get(raw, 'onError');
        if (
            NativeSocketDispatcher.#callable(onConnect) &&
            NativeSocketDispatcher.#callable(onError)
        ) {
            return {
                start: (): void => {
                    Reflect.apply(onConnect, raw, [
                        (reason: unknown): void =>
                            this.abort(
                                reason instanceof Error
                                    ? reason
                                    : new Error('Native WebSocket connection stopped'),
                            ),
                    ]);
                },
                upgrade,
                fail: (error: Error): void => {
                    Reflect.apply(onError, raw, [error]);
                },
            };
        }
        return null;
    }
    static #callable(value: unknown): value is NativeCallback {
        return typeof value === 'function';
    }
}
