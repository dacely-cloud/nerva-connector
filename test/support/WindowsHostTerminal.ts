// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { createServer, type Server, type Socket } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { Boundary } from 'nerva-connector-protocol/protocol/Boundary.js';
import { HostWindowsBuild } from '../../src/host/HostWindowsBuild.js';

/** Report variants remain distinct when a root exits while descendants or output remain. */
const ReportKind = {
    Hello: 'hello',
    Ready: 'ready',
    Input: 'input',
    State: 'state',
    Control: 'control',
} as const;

interface HelloReport {
    readonly kind: typeof ReportKind.Hello;
}

interface ReadyReport {
    readonly kind: typeof ReportKind.Ready;
    readonly cols: number;
    readonly rows: number;
}
interface InputReport {
    readonly kind: typeof ReportKind.Input;
    readonly acceptedBytes: bigint;
}
interface StateReport {
    readonly kind: typeof ReportKind.State;
    readonly running: boolean;
    readonly treeRunning: boolean | null;
    readonly exitCode: number | null;
    readonly outputComplete: boolean;
    readonly outputFinalBytes: bigint | null;
}
interface ControlReport {
    readonly kind: typeof ReportKind.Control;
    readonly id: bigint;
    readonly ok: boolean;
}
/** Every native record is narrowed and validated at the private pipe boundary. */
export type WindowsTerminalReport =
    HelloReport | ReadyReport | InputReport | StateReport | ControlReport;

/** Direct native qualification owns one pipe server, one broker and all asynchronous observation. */
export class WindowsHostTerminal implements AsyncDisposable {
    readonly #server: Server;
    readonly #token: string = randomBytes(32).toString('hex');
    readonly #path: string = '\\\\.\\pipe\\nerva-connector-host-' + randomUUID();
    readonly #reports: WindowsTerminalReport[] = [];
    readonly #bytes: Buffer[] = [];
    readonly #closed: PromiseWithResolvers<number | null> = Promise.withResolvers<number | null>();
    #child: ChildProcessWithoutNullStreams | null = null;
    #socket: Socket | null = null;
    #pending: Buffer = Buffer.alloc(0);
    #outputBytes: number = 0;
    #failure: Error | null = null;
    #exited: boolean = false;

    private constructor() {
        this.#server = createServer((socket: Socket): void => {
            if (this.#socket !== null) {
                socket.destroy();
                return;
            }
            this.#socket = socket;
            socket.on('data', (bytes: Buffer): void => this.#receive(bytes));
            socket.on('error', (error: Error): void => {
                this.#failure ??= error;
            });
        });
    }

    /** The fixed built broker is verified before any qualification command executes. */
    public static async create(source: string): Promise<WindowsHostTerminal> {
        const fixture: WindowsHostTerminal = new WindowsHostTerminal();
        try {
            await new Promise<void>((resolve: () => void, reject: (error: Error) => void): void => {
                fixture.#server.once('error', reject);
                fixture.#server.listen(fixture.#path, (): void => {
                    fixture.#server.off('error', reject);
                    resolve();
                });
            });
            fixture.#server.on('error', (error: Error): void => {
                fixture.#failure ??= error;
            });
            const launch: string = Buffer.from(
                JSON.stringify({
                    executable: process.execPath,
                    arguments: ['-e', source],
                    windowsVerbatimArguments: false,
                    cols: 80,
                    rows: 24,
                }),
            ).toString('base64');
            const child: ChildProcessWithoutNullStreams = spawn(
                await HostWindowsBuild.verifiedExecutable(),
                ['--terminal', launch, fixture.#path, fixture.#token],
                { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true },
            );
            fixture.#child = child;
            child.stdin.on('error', (error: Error): void => {
                fixture.#failure ??= error;
            });
            child.stdout.on('data', (bytes: Buffer): void => {
                fixture.#outputBytes += bytes.length;
                if (fixture.#outputBytes > 1048576) {
                    fixture.#failure ??= new Error(
                        'Native terminal qualification output exceeded its bound',
                    );
                    child.kill();
                    return;
                }
                fixture.#bytes.push(bytes);
            });
            child.stderr.resume();
            child.once('error', (error: Error): void => {
                fixture.#failure ??= error;
            });
            child.once('close', (code: number | null): void => {
                fixture.#exited = true;
                fixture.#closed.resolve(code);
            });
            await fixture.report(
                (value: WindowsTerminalReport): boolean => value.kind === ReportKind.Ready,
            );
            return fixture;
        } catch (error: unknown) {
            await fixture[Symbol.asyncDispose]();
            throw error;
        }
    }

    /** Complete captured bytes remain untouched by UTF-8 or VT decoding. */
    public get output(): Buffer {
        return Buffer.concat(this.#bytes);
    }

    /** One finite input write has an independent cumulative native acceptance report. */
    public async write(bytes: Buffer): Promise<void> {
        const child: ChildProcessWithoutNullStreams | null = this.#child;
        if (child === null) {
            throw new Error('Native terminal is unavailable');
        }
        await new Promise<void>((resolve: () => void, reject: (error: Error) => void): void => {
            child.stdin.write(bytes, (error?: Error | null): void => {
                if (error === null || error === undefined) {
                    resolve();
                } else {
                    reject(error);
                }
            });
        });
    }

    /** A resize is identified independently from the process and from terminal input bytes. */
    public resize(id: bigint, cols: number, rows: number): void {
        this.#send({ token: this.#token, operation: 'resize', id: id.toString(), cols, rows });
    }

    /** Stop succeeds only after a native control acknowledgment and process close. */
    public async stop(id: bigint = 2n): Promise<void> {
        if (this.#exited) {
            return;
        }
        this.#send({ token: this.#token, operation: 'stop', id: id.toString() });
        const report: WindowsTerminalReport = await this.report(
            (value: WindowsTerminalReport): boolean =>
                value.kind === ReportKind.Control && value.id === id,
        );
        if (report.kind !== ReportKind.Control || !report.ok) {
            throw new Error('Native terminal shutdown was not confirmed');
        }
        await this.#closed.promise;
    }

    /** Observation is bounded even if native startup, resize or shutdown fails. */
    public async report(
        predicate: (value: WindowsTerminalReport) => boolean,
    ): Promise<WindowsTerminalReport> {
        for (let attempt: number = 0; attempt < 1000; attempt += 1) {
            if (this.#failure !== null) {
                throw this.#failure;
            }
            const report: WindowsTerminalReport | undefined = this.#reports.find(predicate);
            if (report !== undefined) {
                return report;
            }
            if (this.#exited) {
                throw new Error('Native terminal exited before its expected report');
            }
            await delay(20);
        }
        throw new Error('Native terminal report timed out');
    }

    public async [Symbol.asyncDispose](): Promise<void> {
        try {
            if (!this.#exited && this.#child !== null) {
                try {
                    await this.stop(9223372036854775807n);
                } catch {
                    this.#socket?.destroy();
                    this.#child.stdin.destroy();
                    this.#child.kill();
                }
                await this.#closed.promise;
            }
        } finally {
            this.#socket?.destroy();
            if (this.#server.listening) {
                await new Promise<void>((resolve: () => void): void => {
                    this.#server.close((): void => resolve());
                });
            }
        }
    }

    #send(value: WindowsTerminalControl): void {
        if (this.#socket === null || this.#socket.destroyed) {
            throw new Error('Native terminal control pipe is unavailable');
        }
        this.#socket.write(JSON.stringify(value) + '\n');
    }

    #receive(bytes: Buffer): void {
        try {
            if (this.#pending.length + bytes.length > 8192) {
                throw new Error('Native terminal report exceeds its bound');
            }
            this.#pending = Buffer.concat([this.#pending, bytes]);
            for (
                let newline: number = this.#pending.indexOf(10);
                newline >= 0;
                newline = this.#pending.indexOf(10)
            ) {
                if (newline > 4096 || this.#reports.length >= 4096) {
                    throw new Error('Native terminal report exceeds its bound');
                }
                const raw: unknown = JSON.parse(
                    new TextDecoder('utf-8', { fatal: true }).decode(
                        this.#pending.subarray(0, newline),
                    ),
                );
                this.#pending = this.#pending.subarray(newline + 1);
                const report: WindowsTerminalReport = this.#decode(raw);
                if (report.kind === ReportKind.Hello) {
                    this.#socket?.write(
                        JSON.stringify({ token: this.#token, operation: 'start' }) + '\n',
                    );
                }
                this.#reports.push(report);
            }
        } catch (error: unknown) {
            this.#failure =
                error instanceof Error ? error : new Error('Native terminal report failed');
            this.#socket?.destroy();
        }
    }

    #decode(raw: unknown): WindowsTerminalReport {
        const value: Readonly<Record<string, unknown>> = Boundary.record(raw, [
            'token',
            'kind',
            'cols',
            'rows',
            'acceptedBytes',
            'running',
            'treeRunning',
            'exitCode',
            'signal',
            'outputComplete',
            'outputFinalBytes',
            'id',
            'ok',
        ]);
        if (value['token'] !== this.#token) {
            throw new Error('Native terminal token changed');
        }
        switch (value['kind']) {
            case ReportKind.Hello:
                return { kind: ReportKind.Hello };
            case ReportKind.Ready:
                return {
                    kind: ReportKind.Ready,
                    cols: Boundary.count(value['cols'], 500),
                    rows: Boundary.count(value['rows'], 200),
                };
            case ReportKind.Input:
                return {
                    kind: ReportKind.Input,
                    acceptedBytes: Boundary.integer(value['acceptedBytes']),
                };
            case ReportKind.Control:
                return {
                    kind: ReportKind.Control,
                    id: Boundary.integer(value['id']),
                    ok: Boundary.boolean(value['ok']),
                };
            case ReportKind.State:
                if (value['signal'] !== null) {
                    throw new Error('Unexpected native Windows signal');
                }
                return {
                    kind: ReportKind.State,
                    running: Boundary.boolean(value['running']),
                    treeRunning:
                        value['treeRunning'] === null
                            ? null
                            : Boundary.boolean(value['treeRunning']),
                    exitCode:
                        value['exitCode'] === null
                            ? null
                            : Boundary.count(value['exitCode'], 4294967295),
                    outputComplete: Boundary.boolean(value['outputComplete']),
                    outputFinalBytes:
                        value['outputFinalBytes'] === null
                            ? null
                            : Boundary.integer(value['outputFinalBytes']),
                };
            default:
                throw new Error('Unknown native terminal report');
        }
    }
}

/** Tests use the same closed resize/stop command grammar as the private native owner. */
interface WindowsTerminalControl {
    readonly token: string;
    readonly operation: string;
    readonly id: string;
    readonly cols?: number;
    readonly rows?: number;
}
