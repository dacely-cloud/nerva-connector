// SPDX-FileCopyrightText: 2026 Dacely <business@dacely.com>
// SPDX-License-Identifier: LicenseRef-Proprietary

import { randomUUID } from 'node:crypto';
import { createServer, type Server, type Socket } from 'node:net';
import type { HostProcessReport } from './HostProcessReport.js';
import {
    HostProcessWindowsProtocol,
    HostProcessWindowsFrameKind,
    type HostProcessWindowsFrame,
    type HostProcessWindowsRejectedFrame,
} from './HostProcessWindowsProtocol.js';

const HostWindowsControl = { Start: 'start', Stop: 'stop' } as const;
type HostWindowsControl = (typeof HostWindowsControl)[keyof typeof HostWindowsControl];

/** An authenticated local channel gates process creation and carries independent root/tree/EOF observations. */
export class HostWindowsProcessChannel implements AsyncDisposable {
    readonly #server: Server;
    readonly #token: string = randomUUID();
    readonly #timer: NodeJS.Timeout;
    readonly #ready: PromiseWithResolvers<undefined> = Promise.withResolvers<undefined>();
    #socket: Socket | null = null;
    #buffer: string = '';
    #closed: boolean = false;
    #authenticated: boolean = false;
    #launchDecided: boolean = false;
    #failed: boolean = false;
    #writing: boolean = false;
    #disposal: Promise<void> | null = null;
    readonly #report: (result: HostProcessReport) => void;
    readonly #unavailableNotification: () => void;
    readonly #stopFailure: () => void;
    readonly #started: () => void;
    readonly #rejected: (result: HostProcessWindowsRejectedFrame) => void;
    /** The runtime chooses a fresh local pipe, never a caller-supplied endpoint. */
    public readonly path: string = '\\\\.\\pipe\\nerva-connector-host-' + randomUUID();

    private constructor(
        report: (result: HostProcessReport) => void,
        unavailable: () => void,
        stopFailed: () => void,
        started: () => void,
        rejected: (result: HostProcessWindowsRejectedFrame) => void,
    ) {
        this.#report = report;
        this.#unavailableNotification = unavailable;
        this.#stopFailure = stopFailed;
        this.#started = started;
        this.#rejected = rejected;
        this.#server = createServer((socket: Socket): void => {
            if (this.#socket !== null || this.#closed) {
                socket.destroy();
                return;
            }
            this.#socket = socket;
            socket.setEncoding('utf8');
            socket.on('data', (chunk: string): void => this.#receive(chunk));
            socket.on('error', (): void => {
                socket.destroy();
            });
            socket.on('close', (): void => this.#unavailable());
        });
        this.#timer = setTimeout((): void => {
            this.#unavailable();
            this.#socket?.destroy();
            this.#server.close();
        }, 15000);
    }

    /** Listening precedes broker launch; only a matching ready token receives the start acknowledgment. */
    public static async create(
        report: (result: HostProcessReport) => void,
        unavailable: () => void,
        stopFailed: () => void,
        started: () => void,
        rejected: (result: HostProcessWindowsRejectedFrame) => void,
    ): Promise<HostWindowsProcessChannel> {
        const channel: HostWindowsProcessChannel = new HostWindowsProcessChannel(
            report,
            unavailable,
            stopFailed,
            started,
            rejected,
        );
        try {
            await new Promise<void>((resolve: () => void, reject: (error: Error) => void): void => {
                channel.#server.once('error', reject);
                channel.#server.listen(channel.path, (): void => {
                    channel.#server.off('error', reject);
                    resolve();
                });
            });
            channel.#server.on('error', (): void => channel.#unavailable());
            return channel;
        } catch (caught: unknown) {
            await channel[Symbol.asyncDispose]();
            throw caught;
        }
    }

    /** The token authenticates both directions; it never grants authority beyond this already admitted process. */
    public get token(): string {
        return this.#token;
    }

    /** A successful write only requests termination; the caller must separately observe confirmed treeRunning=false. */
    public async stop(): Promise<void> {
        await this.#ready.promise;
        if (this.#failed || !this.#authenticated || this.#closed) {
            throw new Error(
                'Windows host process control is unavailable; tree shutdown is unconfirmed',
            );
        }
        await this.#write(HostWindowsControl.Stop);
    }

    /** Parent teardown closes control ownership; this alone is never a verified stop acknowledgment. */
    public async [Symbol.asyncDispose](): Promise<void> {
        this.#disposal ??= this.#dispose();
        await this.#disposal;
    }

    async #dispose(): Promise<void> {
        this.#closed = true;
        this.#ready.resolve(undefined);
        clearTimeout(this.#timer);
        this.#socket?.destroy();
        if (this.#server.listening) {
            await new Promise<void>((resolve: () => void): void => {
                this.#server.close((): void => resolve());
            });
        }
    }

    #unavailable(): void {
        if (this.#closed || this.#failed) {
            return;
        }
        this.#failed = true;
        this.#ready.resolve(undefined);
        this.#unavailableNotification();
    }

    async #write(operation: HostWindowsControl): Promise<void> {
        const socket: Socket | null = this.#socket;
        if (socket === null || socket.destroyed || this.#writing) {
            throw new Error('Windows host process control pipe is closed or busy');
        }
        this.#writing = true;
        try {
            await new Promise<void>((resolve: () => void, reject: (error: Error) => void): void => {
                socket.write(
                    JSON.stringify({ token: this.#token, operation }) + '\n',
                    (error: Error | null | undefined): void => {
                        if (error !== undefined && error !== null) {
                            reject(error);
                        } else {
                            resolve();
                        }
                    },
                );
            });
        } finally {
            this.#writing = false;
        }
    }

    async #start(): Promise<void> {
        try {
            await this.#write(HostWindowsControl.Start);
            clearTimeout(this.#timer);
            this.#ready.resolve(undefined);
        } catch {
            this.#unavailable();
            this.#socket?.destroy();
        }
    }

    #receive(chunk: string): void {
        this.#buffer += chunk;
        if (this.#buffer.length > 4096) {
            this.#socket?.destroy();
            return;
        }
        let newline: number = this.#buffer.indexOf('\n');
        while (newline !== -1) {
            try {
                if (newline > 1024) {
                    throw new Error('Windows host report exceeds limit');
                }
                const raw: unknown = JSON.parse(this.#buffer.slice(0, newline));
                const frame: HostProcessWindowsFrame = HostProcessWindowsProtocol.decode(
                    raw,
                    this.#token,
                );
                if (frame.kind === HostProcessWindowsFrameKind.Ready) {
                    if (this.#authenticated) {
                        throw new Error('Duplicate Windows host readiness');
                    }
                    this.#authenticated = true;
                    void this.#start();
                } else {
                    if (!this.#authenticated) {
                        throw new Error('Windows host report preceded authentication');
                    }
                    if (frame.kind === HostProcessWindowsFrameKind.StopFailed) {
                        this.#stopFailure();
                    } else if (
                        frame.kind === HostProcessWindowsFrameKind.Started ||
                        frame.kind === HostProcessWindowsFrameKind.LaunchRejected
                    ) {
                        if (this.#launchDecided) {
                            throw new Error('Duplicate Windows host launch decision');
                        }
                        this.#launchDecided = true;
                        if (frame.kind === HostProcessWindowsFrameKind.Started) {
                            this.#started();
                        } else {
                            this.#rejected(frame);
                        }
                    } else if (frame.kind === HostProcessWindowsFrameKind.Report) {
                        if (!this.#launchDecided && !frame.report.launchFailed) {
                            throw new Error('Windows exit report preceded native creation');
                        }
                        this.#report(frame.report);
                    } else {
                        throw new Error('Invalid Windows host report kind');
                    }
                }
                this.#buffer = this.#buffer.slice(newline + 1);
                newline = this.#buffer.indexOf('\n');
            } catch {
                this.#unavailable();
                this.#socket?.destroy();
                return;
            }
        }
    }
}
