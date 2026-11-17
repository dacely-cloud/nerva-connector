// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

import { spawn, type ChildProcess, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { Duplex } from 'node:stream';
import type { FileHandle } from 'node:fs/promises';
import { Boundary } from 'nerva-connector-protocol/protocol/Boundary.js';
import { ConnectorNativeExecutable } from '../runtime/ConnectorNativeExecutable.js';
import { HostLinuxBuild } from './HostLinuxBuild.js';
import type { HostLinuxArtifact } from './HostLinuxArtifact.js';
import type { HostProcessLaunchOptions } from './HostProcessLaunch.js';
import { HostTerminalChannel, type HostTerminalChannelObserver } from './HostTerminalChannel.js';
import type { HostTerminalControlKind } from './HostTerminalTypes.js';

/** OS process and byte events stay below the terminal owner's evidence and authorization boundary. */
export interface HostTerminalBackendObserver extends HostTerminalChannelObserver {
    output(bytes: Buffer): void;
    closed(): void;
}
/** Validated launch configuration never accepts an executable override from a native report. */
export interface HostTerminalBackendLaunch {
    readonly launch: HostProcessLaunchOptions;
    readonly directory: string;
    readonly environment: Readonly<Record<string, string>>;
    readonly cols: number;
    readonly rows: number;
    readonly windowsLauncher: string | undefined;
}

/** One owner retains the exact reviewed ELF or Mach-O descriptor, or the compiled Windows broker, until process close. */
export class HostTerminalBackend {
    readonly #channel: HostTerminalChannel;
    readonly #closed: PromiseWithResolvers<undefined> = Promise.withResolvers<undefined>();
    #child: ChildProcessWithoutNullStreams | null = null;
    #pin: FileHandle | null = null;
    #ended: boolean = false;
    #closing: boolean = false;

    public constructor(public readonly observer: HostTerminalBackendObserver) {
        this.#channel = new HostTerminalChannel(observer);
    }
    public get ended(): boolean {
        return this.#ended;
    }
    public get spawned(): boolean {
        return this.#child?.pid !== undefined;
    }
    public get closed(): Promise<void> {
        return this.#closed.promise;
    }

    /** Construction is separate from startup so the pool registers this resource owner before any await or spawn. */
    public async start(input: HostTerminalBackendLaunch, signal: AbortSignal): Promise<void> {
        signal.throwIfAborted();
        let executable: string;
        let arguments_: readonly string[];
        const configuration: HostProcessLaunchOptions = input.launch;
        const encoded: string = JSON.stringify({
            ...configuration,
            cols: input.cols,
            rows: input.rows,
        });
        if (process.platform === 'win32') {
            if (input.windowsLauncher === undefined) {
                throw new Error('Windows terminal requires its verified native broker');
            }
            await this.#channel.listen();
            executable = input.windowsLauncher;
            const launch: string = Buffer.from(encoded).toString('base64');
            if (launch.length > 30000) {
                throw new Error('Windows terminal launch exceeds its bound');
            }
            arguments_ = ['--terminal', launch, this.#channel.path, this.#channel.token];
        } else if (process.platform === 'linux' || process.platform === 'darwin') {
            const artifact: HostLinuxArtifact | null = await HostLinuxBuild.read();
            if (artifact === null) {
                throw new Error('Host terminals require their reviewed native build');
            }
            this.#pin = await ConnectorNativeExecutable.open(
                HostLinuxBuild.executable(),
                artifact.sha256,
                artifact.bytes,
            );
            executable = await HostTerminalBackend.#executable(this.#pin);
            arguments_ = ['--host-terminal'];
        } else {
            throw new Error('Native terminals are unavailable on this platform');
        }
        signal.throwIfAborted();
        const child: ChildProcess = spawn(executable, arguments_, {
            cwd: input.directory,
            env: {
                ...process.env,
                ...input.environment,
                TERM: input.environment['TERM'] ?? process.env['TERM'] ?? 'xterm-256color',
            },
            stdio:
                this.#pin === null
                    ? ['pipe', 'pipe', 'pipe']
                    : process.platform === 'linux'
                      ? ['pipe', 'pipe', 'pipe', 'pipe', this.#pin.fd]
                      : ['pipe', 'pipe', 'pipe', 'pipe'],
            windowsHide: true,
        });
        if (!HostTerminalBackend.#piped(child)) {
            child.kill();
            throw new Error('Native terminal pipes are unavailable');
        }
        this.#child = child;
        child.stdin.on('error', (error: Error): void => {
            if (!this.#closing) {
                this.observer.failed(error);
            }
        });
        child.stdout.on('data', (bytes: Buffer): void => this.observer.output(bytes));
        child.stderr.resume();
        child.once('error', (error: Error): void => this.observer.failed(error));
        child.once('close', (): void => {
            this.#ended = true;
            this.observer.closed();
            void this.#finish();
        });
        if (this.#pin !== null) {
            const stream: ChildProcess['stdio'][number] = child.stdio[3];
            if (!(stream instanceof Duplex)) {
                throw new Error('Host terminal requires its private duplex channel');
            }
            this.#channel.attach(stream);
            await this.#channel.launch(
                JSON.stringify({
                    token: this.#channel.token,
                    ...configuration,
                    cols: input.cols,
                    rows: input.rows,
                }),
            );
        }
    }

    public pause(value: boolean): void {
        if (value) {
            this.#child?.stdout.pause();
        } else {
            this.#child?.stdout.resume();
        }
    }
    public stopInput(): void {
        this.#child?.stdin.destroy();
    }

    /** Each chunk waits for the OS pipe callback; the owner additionally waits for cumulative native acceptance. */
    public async input(bytes: Buffer): Promise<void> {
        const child: ChildProcessWithoutNullStreams | null = this.#child;
        if (child === null || this.#ended || child.stdin.destroyed || child.stdin.writableEnded) {
            throw new Error('Terminal input is closed');
        }
        await new Promise<void>((resolve: () => void, reject: (error: Error) => void): void => {
            child.stdin.write(bytes, (error: Error | null | undefined): void => {
                if (error !== null && error !== undefined) {
                    reject(error);
                } else {
                    resolve();
                }
            });
        });
    }

    public async control(
        operation: HostTerminalControlKind,
        cols: number | null = null,
        rows: number | null = null,
    ): Promise<void> {
        await this.#channel.control(operation, cols, rows);
    }

    /** Only a successful stop or a never-spawned startup may close this capability. Unknown cleanup keeps it owned. */
    public async closeControl(): Promise<void> {
        this.#closing = true;
        this.#child?.stdin.destroy();
        await this.#channel[Symbol.asyncDispose]();
        if (this.#child === null) {
            await this.#finish();
        }
    }

    async #finish(): Promise<void> {
        try {
            await this.#pin?.close();
            this.#pin = null;
            this.#closed.resolve(undefined);
        } catch (error: unknown) {
            this.#closed.reject(error);
        }
    }

    /** Actual native capability is probed after verifying the same executable used for future launches. */
    public static async available(windowsLauncher?: string): Promise<boolean> {
        let pin: FileHandle | null = null;
        let timer: NodeJS.Timeout | undefined;
        try {
            let executable: string;
            if (process.platform === 'linux' || process.platform === 'darwin') {
                const artifact: HostLinuxArtifact | null = await HostLinuxBuild.read();
                if (artifact === null) {
                    return false;
                }
                pin = await ConnectorNativeExecutable.open(
                    HostLinuxBuild.executable(),
                    artifact.sha256,
                    artifact.bytes,
                );
                executable = await this.#executable(pin);
            } else if (process.platform === 'win32' && windowsLauncher !== undefined) {
                executable = windowsLauncher;
            } else {
                return false;
            }
            const spawned: ChildProcess = spawn(
                executable,
                [pin === null ? '--terminal-probe' : '--host-terminal-probe'],
                {
                    stdio:
                        pin === null
                            ? ['pipe', 'pipe', 'pipe']
                            : process.platform === 'linux'
                              ? ['pipe', 'pipe', 'pipe', 'ignore', pin.fd]
                              : ['pipe', 'pipe', 'pipe', 'ignore'],
                    windowsHide: true,
                },
            );
            if (!this.#piped(spawned)) {
                spawned.kill();
                return false;
            }
            const child: ChildProcessWithoutNullStreams = spawned;
            const bytes: Buffer[] = [];
            let length: number = 0;
            let valid: boolean = true;
            child.stdout.on('data', (chunk: Buffer): void => {
                length += chunk.length;
                if (length > 2048) {
                    valid = false;
                    spawned.kill();
                } else {
                    bytes.push(chunk);
                }
            });
            child.stderr.resume();
            child.stdin.on('error', (): void => undefined);
            child.stdin.end();
            timer = setTimeout((): void => {
                valid = false;
                spawned.kill();
            }, 15000);
            const code: number | null = await new Promise<number | null>(
                (resolve: (value: number | null) => void): void => {
                    spawned.once('error', (): void => {
                        valid = false;
                    });
                    spawned.once('close', resolve);
                },
            );
            if (!valid || code !== 0) {
                return false;
            }
            const raw: unknown = JSON.parse(
                new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(bytes)),
            );
            return Boundary.boolean(Boundary.record(raw, ['supported'])['supported']);
        } catch {
            return false;
        } finally {
            clearTimeout(timer);
            await pin?.close();
        }
    }

    /** Linux executes the pinned descriptor passed as fd 4; macOS executes the path still naming it. */
    static async #executable(pin: FileHandle): Promise<string> {
        if (process.platform === 'linux') {
            await ConnectorNativeExecutable.assertRunnable(pin);
            return '/proc/self/fd/4';
        }
        return await ConnectorNativeExecutable.verifiedPath(pin, HostLinuxBuild.executable());
    }

    static #piped(child: ChildProcess): child is ChildProcessWithoutNullStreams {
        return child.stdin !== null && child.stdout !== null && child.stderr !== null;
    }
}
