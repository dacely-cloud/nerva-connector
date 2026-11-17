// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

import { createServer, type Server, type Socket } from 'node:net';
import { Duplex } from 'node:stream';
import { randomBytes, randomUUID } from 'node:crypto';
import {
    HostTerminalReportCodec,
    HostTerminalReportKind,
    type HostTerminalReport,
} from './HostTerminalReport.js';
import {
    HostTerminalControlKind,
    HostTerminalLimits,
    type HostTerminalControl,
} from './HostTerminalTypes.js';

/** A native acknowledgment settles the same finite original, including late geometry observations. */
interface PendingControl {
    readonly result: PromiseWithResolvers<undefined>;
    readonly timer: NodeJS.Timeout;
}
/** Only the owner consumes decoded reports and authentic transport failures. */
export interface HostTerminalChannelObserver {
    report(value: HostTerminalReport, control: HostTerminalControl | null): void;
    failed(error: Error, closed?: boolean): void;
}

/** One bounded authenticated channel carries control independently from paused terminal stdout. */
export class HostTerminalChannel implements AsyncDisposable {
    public readonly token: string = randomBytes(32).toString('hex');
    public readonly path: string = '\\\\.\\pipe\\nerva-connector-host-' + randomUUID();
    readonly #pending: Map<bigint, PendingControl> = new Map();
    readonly #issued: Map<bigint, HostTerminalControl> = new Map();
    #server: Server | null = null;
    #stream: Duplex | null = null;
    #buffer: Buffer = Buffer.alloc(0);
    #sequence: bigint = 0n;
    #lastAck: bigint = 0n;
    #closed: boolean = false;
    #windows: boolean;
    #authenticated: boolean = false;
    #broken: boolean = false;

    public constructor(
        public readonly observer: HostTerminalChannelObserver,
        windows: boolean = process.platform === 'win32',
    ) {
        this.#windows = windows;
    }

    /** Listen before Windows creates the broker, retaining exactly one local peer. */
    public async listen(): Promise<void> {
        if (this.#server !== null || this.#closed) {
            throw new Error('Terminal channel already initialized');
        }
        this.#windows = true;
        const server: Server = createServer((socket: Socket): void => {
            if (this.#stream !== null || this.#closed) {
                socket.destroy();
                return;
            }
            this.attach(socket);
        });
        this.#server = server;
        await new Promise<void>((resolve: () => void, reject: (error: Error) => void): void => {
            server.once('error', reject);
            server.listen(this.path, (): void => {
                server.off('error', reject);
                resolve();
            });
        });
        server.on('error', (error: Error): void => this.#failed(error));
    }

    /** Linux transfers a duplex inherited descriptor; Windows attaches its accepted named pipe. */
    public attach(stream: Duplex): void {
        if (this.#stream !== null || this.#closed) {
            throw new Error('Terminal channel already connected');
        }
        this.#stream = stream;
        stream.on('data', (bytes: Buffer): void => this.#receive(bytes));
        stream.on('error', (error: Error): void => this.#failed(error));
        stream.on('close', (): void => {
            if (!this.#closed) {
                this.#failed(new Error('Terminal native control channel closed'), true);
            }
        });
    }

    /** Initial launch is the only non-control record on the Linux private descriptor. */
    public async launch(json: string): Promise<void> {
        if (Buffer.byteLength(json) > 131072) {
            throw new Error('Terminal launch exceeds its bound');
        }
        await this.#write(json + '\n');
    }

    /** Pending controls and lifetime control count are independently finite; a stop retains one reserved slot. */
    public async control(
        operation: HostTerminalControlKind,
        cols: number | null = null,
        rows: number | null = null,
    ): Promise<void> {
        const maximum: number =
            operation === HostTerminalControlKind.Stop
                ? HostTerminalLimits.pendingControls
                : HostTerminalLimits.pendingControls - 1;
        const lifetimeMaximum: bigint =
            HostTerminalLimits.controls - (operation === HostTerminalControlKind.Stop ? 0n : 1n);
        if (
            this.#closed ||
            this.#broken ||
            this.#pending.size >= maximum ||
            this.#sequence >= lifetimeMaximum
        ) {
            throw new Error('Terminal control admission exceeded its bound');
        }
        const id: bigint = ++this.#sequence;
        const control: HostTerminalControl = { operation, id, cols, rows };
        const result: PromiseWithResolvers<undefined> = Promise.withResolvers<undefined>();
        const timer: NodeJS.Timeout = setTimeout(
            (): void => {
                this.#pending.delete(id);
                result.reject(new Error('Terminal control outcome was not confirmed'));
            },
            operation === HostTerminalControlKind.Stop
                ? HostTerminalLimits.stopMs
                : HostTerminalLimits.controlMs,
        );
        this.#pending.set(id, { result, timer });
        this.#issued.set(id, control);
        const json: string = JSON.stringify({
            token: this.token,
            operation,
            id: id.toString(),
            ...(operation === HostTerminalControlKind.Resize ? { cols, rows } : {}),
        });
        try {
            await Promise.all([this.#write(json + '\n'), result.promise]);
        } catch (error: unknown) {
            clearTimeout(timer);
            this.#pending.delete(id);
            throw error;
        }
    }

    public async [Symbol.asyncDispose](): Promise<void> {
        if (this.#closed) {
            return;
        }
        this.#closed = true;
        this.#stream?.destroy();
        for (const pending of this.#pending.values()) {
            clearTimeout(pending.timer);
            pending.result.reject(new Error('Terminal channel closed before acknowledgment'));
        }
        this.#pending.clear();
        this.#issued.clear();
        if (this.#server?.listening) {
            await new Promise<void>((resolve: () => void): void => {
                this.#server?.close((): void => resolve());
            });
        }
    }

    async #write(value: string): Promise<void> {
        const stream: Duplex | null = this.#stream;
        if (this.#closed || stream === null || stream.destroyed) {
            throw new Error('Terminal native channel is unavailable');
        }
        await new Promise<void>((resolve: () => void, reject: (error: Error) => void): void => {
            stream.write(value, (error: Error | null | undefined): void => {
                if (error !== undefined && error !== null) {
                    reject(error);
                } else {
                    resolve();
                }
            });
        });
    }

    #receive(bytes: Buffer): void {
        try {
            if (!Buffer.isBuffer(bytes) || this.#buffer.length + bytes.length > 262144) {
                throw new Error('Terminal private report buffer exceeded its bound');
            }
            this.#buffer = Buffer.concat([this.#buffer, bytes]);
            for (
                let end: number = this.#buffer.indexOf(10);
                end >= 0;
                end = this.#buffer.indexOf(10)
            ) {
                if (end > 4096) {
                    throw new Error('Terminal private report exceeded its bound');
                }
                const raw: unknown = JSON.parse(
                    new TextDecoder('utf-8', { fatal: true }).decode(this.#buffer.subarray(0, end)),
                );
                this.#buffer = this.#buffer.subarray(end + 1);
                const report: HostTerminalReport = HostTerminalReportCodec.decode(raw, this.token);
                if (report.kind === HostTerminalReportKind.Hello) {
                    if (!this.#windows || this.#authenticated) {
                        throw new Error('Unexpected terminal native authentication');
                    }
                    this.#authenticated = true;
                    void this.#authenticate();
                    continue;
                }
                if (this.#windows && !this.#authenticated) {
                    throw new Error('Terminal native peer has not authenticated');
                }
                let control: HostTerminalControl | null = null;
                if (report.kind === HostTerminalReportKind.Control) {
                    control = this.#issued.get(report.id) ?? null;
                    if (control === null) {
                        if (report.id <= this.#lastAck) {
                            continue;
                        }
                        throw new Error('Terminal acknowledged an unknown control');
                    }
                    this.#lastAck = report.id;
                    this.#issued.delete(report.id);
                    this.observer.report(report, control);
                    const pending: PendingControl | undefined = this.#pending.get(report.id);
                    if (pending !== undefined) {
                        clearTimeout(pending.timer);
                        this.#pending.delete(report.id);
                        if (report.ok) {
                            pending.result.resolve(undefined);
                        } else {
                            pending.result.reject(
                                new Error('Terminal native control did not complete'),
                            );
                        }
                    }
                } else {
                    this.observer.report(report, null);
                }
            }
            if (this.#buffer.length > 4096) {
                throw new Error('Terminal private report exceeded its bound');
            }
        } catch (error: unknown) {
            this.#failed(
                error instanceof Error ? error : new Error('Invalid terminal native report'),
            );
        }
    }

    #failed(error: Error, closed: boolean = false): void {
        if (this.#closed || this.#broken) {
            return;
        }
        this.#broken = true;
        this.#stream?.destroy();
        for (const pending of this.#pending.values()) {
            clearTimeout(pending.timer);
            pending.result.reject(error);
        }
        this.#pending.clear();
        this.observer.failed(error, closed);
    }

    async #authenticate(): Promise<void> {
        try {
            await this.#write(JSON.stringify({ token: this.token, operation: 'start' }) + '\n');
        } catch (error: unknown) {
            this.#failed(
                error instanceof Error ? error : new Error('Terminal native authentication failed'),
            );
        }
    }
}
