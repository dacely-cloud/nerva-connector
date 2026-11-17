// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

import { EventEmitter } from 'node:events';
import { NativeSocketDispatcher } from './NativeSocketDispatcher.js';
import { ConnectorNodeRuntime } from './ConnectorNodeRuntime.js';
import type { ConnectorStartupObserver } from '../runtime/ConnectorStartup.js';

/** Only the connector's small typed transport event surface is exposed to pairing and session owners. */
interface ConnectorSocketEvents {
    open: [];
    message: [data: Buffer, binary: boolean];
    error: [error: Error];
    /** The WebSocket close code and reason; 1006 and an empty reason when the connection dropped. */
    close: [code: number, reason: string];
}

/** Owned connection policy retains verified private CA support and finite native parser/handshake limits. */
export interface ConnectorSocketOptions {
    readonly progress?: ConnectorStartupObserver;
    readonly ca: Buffer | undefined;
    readonly maximumPayload: number;
    readonly handshakeMs: number;
}

/** Uses Node's built-in WebSocket client with a per-connection verified HTTPS dispatcher; no third-party client or native addon is used. */
export class ConnectorSocket extends EventEmitter<ConnectorSocketEvents> {
    readonly #socket: WebSocket;
    readonly #dispatcher: NativeSocketDispatcher;
    readonly #maximumPayload: number;
    #closing: NodeJS.Timeout | null = null;

    /** One current native parser API is required; unsafe or unsupported bundled runtimes fail explicitly. */
    public constructor(endpoint: string, protocol: string, options: ConnectorSocketOptions) {
        super();
        ConnectorNodeRuntime.assertCurrent();
        this.#maximumPayload = options.maximumPayload;
        this.#dispatcher = new NativeSocketDispatcher(
            endpoint,
            options.ca,
            options.handshakeMs,
            options.maximumPayload,
            options.progress,
        );
        let candidate: unknown;
        try {
            candidate = Reflect.construct(globalThis.WebSocket, [
                endpoint,
                { protocols: [protocol], dispatcher: this.#dispatcher },
            ]);
        } catch (caught: unknown) {
            this.#dispatcher.abort();
            throw caught;
        }
        if (!(candidate instanceof globalThis.WebSocket)) {
            this.#dispatcher.abort();
            throw new Error('Node native WebSocket construction failed');
        }
        this.#socket = candidate;
        candidate.binaryType = 'arraybuffer';
        candidate.addEventListener('open', (): void => {
            if (candidate.protocol !== protocol || candidate.extensions !== '') {
                this.terminate();
                return;
            }
            this.emit('open');
        });
        candidate.addEventListener('message', (event: MessageEvent): void => {
            const raw: unknown = event.data;
            let data: Buffer;
            let binary: boolean;
            if (typeof raw === 'string') {
                data = Buffer.from(raw);
                binary = false;
            } else if (raw instanceof ArrayBuffer) {
                data = Buffer.from(raw);
                binary = true;
            } else {
                this.terminate();
                return;
            }
            if (data.byteLength > this.#maximumPayload) {
                this.terminate();
                return;
            }
            this.emit('message', data, binary);
        });
        candidate.addEventListener('error', (): void => {
            this.#dispatcher.abort();
            this.emit('error', new Error('Native connector WebSocket failed'));
        });
        candidate.addEventListener(
            'close',
            (event: CloseEvent): void => {
                if (this.#closing !== null) {
                    clearTimeout(this.#closing);
                }
                this.#dispatcher.abort();
                this.emit('close', event.code, event.reason);
            },
            { once: true },
        );
    }

    /** Only an actually open native socket can send an authenticated protocol frame. */
    public get isOpen(): boolean {
        return this.#socket.readyState === globalThis.WebSocket.OPEN;
    }
    /** Native send-queue bytes and actual underlying socket bytes both participate in admission. */
    public get bufferedAmount(): number {
        return this.#socket.bufferedAmount + this.#dispatcher.bufferedAmount;
    }
    /** Bounded outbound application frames are encoded by Node's native WebSocket implementation. */
    public send(value: string): void {
        if (
            !this.isOpen ||
            Buffer.byteLength(value) > this.#maximumPayload ||
            this.bufferedAmount > this.#maximumPayload
        ) {
            throw new Error('Native connector socket send budget exceeded');
        }
        this.#socket.send(value);
    }
    /** The owned dispatcher supplies forceful cancellation absent from the browser-shaped WebSocket API. */
    public terminate(): void {
        this.#dispatcher.abort();
    }

    /**
     * Ends an open socket with a close frame that tells Nerva why, then terminates it if Nerva does not answer.
     *
     * @param code - An application close code from 4000 to 4999
     * @param reason - A short fixed word Nerva records in its journal
     */
    public close(code: number, reason: string): void {
        if (!this.isOpen || this.#closing !== null) {
            this.terminate();
            return;
        }
        try {
            this.#socket.close(code, reason);
        } catch {
            this.terminate();
            return;
        }
        this.#closing = setTimeout((): void => this.terminate(), 2000);
        this.#closing.unref();
    }
}
