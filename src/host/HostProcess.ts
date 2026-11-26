// SPDX-FileCopyrightText: 2026 Dacely <business@dacely.com>
// SPDX-License-Identifier: LicenseRef-Proprietary

import { spawn, type ChildProcess, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { HostProcessOutputState } from './HostProcessOutputState.js';
import { HostReadRevision } from './HostReadRevision.js';
import { HostProcessReportCodec, type HostProcessReport } from './HostProcessReport.js';
import { HostProcessLaunch, type HostProcessLaunchOptions } from './HostProcessLaunch.js';
import type { HostProcessWorkerInput } from './HostProcessWorker.js';
import { HostWindowsProcessChannel } from './HostWindowsProcessChannel.js';
import { HostWorkspaceValidation } from './HostWorkspaceValidation.js';
import { HostProcessStartup } from './HostProcessStartup.js';
import { HostOperationError } from './HostOperationError.js';
import { ConnectorHostErrorCode } from 'nerva-connector-protocol/protocol/ConnectorHost.js';
import type { HostProcessWindowsRejectedFrame } from './HostProcessWindowsProtocol.js';
import {
    HostProcessFailure,
    HostWorkspaceLimits,
    type HostProcessRequest,
    type HostProcessSnapshot,
} from './HostWorkspaceTypes.js';

/** One host process owner retains piped I/O and terminates its live POSIX group or Windows job on cleanup. */
export class HostProcess implements AsyncDisposable {
    /** Only this exact native owner advances its local read-side hint revision. */
    public readonly changes: HostReadRevision = new HostReadRevision();
    /** The program and every process it started have exited, or the broker can no longer tell. */
    public get ended(): boolean {
        return !this.#running && this.#treeRunning !== true;
    }
    readonly #child: ChildProcessWithoutNullStreams;
    readonly #output: HostProcessOutputState = new HostProcessOutputState(this.changes);
    readonly #targetClosed: PromiseWithResolvers<undefined> = Promise.withResolvers<undefined>();
    readonly #closed: PromiseWithResolvers<undefined> = Promise.withResolvers<undefined>();
    readonly #timeoutMs: number;
    readonly #retentionAfterTimeoutMs: number | undefined;
    readonly #expired: (process: HostProcess) => void;
    #timer: NodeJS.Timeout | undefined = undefined;
    #retentionTimer: NodeJS.Timeout | undefined = undefined;
    readonly #startup: HostProcessStartup = new HostProcessStartup(process.platform === 'win32');
    #stopChanged: PromiseWithResolvers<undefined> = Promise.withResolvers<undefined>();
    #channel: HostWindowsProcessChannel | null = null;
    #running: boolean = true;
    #treeRunning: boolean | null = null;
    #ownerRunning: boolean = true;
    #exitCode: number | null = null;
    #signal: string | null = null;
    #failure: HostProcessFailure | null = null;
    #inputPending: boolean = false;
    #stopping: boolean = false;
    #stop: Promise<void> | null = null;

    private constructor(
        public readonly id: string,
        request: HostProcessRequest,
        directory: string,
        launch: HostProcessLaunchOptions,
        windowsLauncher: string | undefined,
        channel: HostWindowsProcessChannel | null,
        expired: (process: HostProcess) => void,
    ) {
        this.#channel = channel;
        this.#timeoutMs = request.timeoutMs;
        this.#retentionAfterTimeoutMs = request.retentionAfterTimeoutMs;
        this.#expired = expired;
        let executable: string = process.execPath;
        let arguments_: readonly string[] = [
            fileURLToPath(
                new URL(
                    import.meta.url.endsWith('.ts')
                        ? './HostProcessWorker.ts'
                        : './nerva-connector-host-worker.mjs',
                    import.meta.url,
                ),
            ),
        ];
        if (process.platform === 'win32') {
            if (windowsLauncher === undefined || channel === null) {
                throw new HostOperationError(
                    ConnectorHostErrorCode.Unsupported,
                    'Windows process creation requires the verified job launcher',
                    true,
                );
            }
            executable = windowsLauncher;
            arguments_ = [
                Buffer.from(JSON.stringify(launch)).toString('base64'),
                channel.path,
                channel.token,
            ];
            if (arguments_[0].length > 30000) {
                throw new HostOperationError(
                    ConnectorHostErrorCode.ResourceLimit,
                    'Windows process arguments exceed the native command-line limit',
                    true,
                );
            }
        }
        const child: ChildProcess = spawn(executable, arguments_, {
            cwd: directory,
            env:
                process.platform === 'win32'
                    ? { ...process.env, ...request.environment }
                    : process.env,
            stdio:
                process.platform === 'win32'
                    ? ['pipe', 'pipe', 'pipe']
                    : ['pipe', 'pipe', 'pipe', 'ipc'],
            detached: process.platform !== 'win32',
            windowsHide: false,
        });
        if (!HostProcess.#piped(child)) {
            child.kill();
            throw new Error('Host process pipes are unavailable');
        }
        this.#child = child;
        this.#child.stdout.on('data', (bytes: Buffer): void => this.#output.appendStdout(bytes));
        this.#child.stderr.on('data', (bytes: Buffer): void => this.#output.appendStderr(bytes));
        this.#child.stdin.on('error', (): void => undefined);
        this.#child.on('error', (cause: Error): void => {
            this.#failureChanged(HostProcessFailure.Launch);
            this.#startup.failed(
                new HostOperationError(
                    ConnectorHostErrorCode.OperationFailed,
                    'The job launcher reported a process startup error',
                    false,
                    { cause },
                ),
            );
        });
        this.#child.on('message', (raw: unknown): void => this.#message(raw));
        this.#child.once('exit', (): void => {
            this.#ownerRunning = false;
            this.#targetClosed.resolve(undefined);
        });
        this.#child.once('close', (): void => {
            this.#startup.failed(
                new HostOperationError(
                    ConnectorHostErrorCode.OperationFailed,
                    'The job launcher exited before reporting whether it created the process',
                    false,
                ),
            );
            clearTimeout(this.#timer);
            this.#ownerRunning = false;
            if (process.platform === 'win32' && this.#treeRunning !== false) {
                this.#treeRunning = null;
                this.#failure ??= HostProcessFailure.Launch;
            }
            if (this.#running) {
                this.#running = false;
                this.#exitCode = null;
                this.#signal = null;
                this.#failure ??= HostProcessFailure.Launch;
            }
            this.#targetClosed.resolve(undefined);
            this.#closed.resolve(undefined);
            this.#stopChanged.resolve(undefined);
            this.changes.advance();
        });
        if (process.platform !== 'win32') {
            this.#admitted();
            const input: HostProcessWorkerInput = {
                executable: launch.executable,
                arguments: launch.arguments,
                directory,
                environment: { ...process.env, ...request.environment },
            };
            this.#child.send(input, (error: Error | null): void => {
                if (error !== null) {
                    this.#failureChanged(HostProcessFailure.Launch);
                    void this.#terminate().catch((): void => undefined);
                }
            });
        }
    }

    /** A Windows pipe listener exists before the broker creates any user process. */
    public static async create(
        id: string,
        request: HostProcessRequest,
        directory: string,
        windowsLauncher: string | undefined,
        expired: (process: HostProcess) => void = (): void => undefined,
        created: (process: HostProcess) => void = (): void => undefined,
    ): Promise<HostProcess> {
        const launch: HostProcessLaunchOptions = HostProcessLaunch.prepare(request);
        let owner: HostProcess | null = null;
        let channel: HostWindowsProcessChannel | null = null;
        if (process.platform === 'win32') {
            channel = await HostWindowsProcessChannel.create(
                (result: HostProcessReport): void => {
                    if (owner !== null) {
                        owner.#result(result);
                    }
                },
                (): void => {
                    if (owner !== null && owner.#treeRunning !== false) {
                        owner.#treeRunning = null;
                        owner.#failure ??= HostProcessFailure.Launch;
                        owner.#startup.failed(
                            new HostOperationError(
                                ConnectorHostErrorCode.OperationFailed,
                                'The Windows job launcher lost its control connection before confirming process creation',
                                false,
                            ),
                        );
                        owner.#stopChanged.resolve(undefined);
                        owner.changes.advance();
                    }
                },
                (): void => {
                    if (owner !== null) {
                        owner.#treeRunning = null;
                        owner.#stopChanged.resolve(undefined);
                        owner.changes.advance();
                    }
                },
                (): void => {
                    if (owner !== null) {
                        owner.#startup.started();
                        owner.#admitted();
                    }
                },
                (result: HostProcessWindowsRejectedFrame): void => {
                    if (owner !== null) {
                        owner.#rejected(result);
                    }
                },
            );
        }
        try {
            owner = new HostProcess(
                id,
                request,
                directory,
                launch,
                windowsLauncher,
                channel,
                expired,
            );
            created(owner);
            if (process.platform === 'win32') {
                await owner.#startup.wait();
            }
            return owner;
        } catch (caught: unknown) {
            if (owner === null) {
                await channel?.[Symbol.asyncDispose]();
            } else {
                try {
                    await owner[Symbol.asyncDispose]();
                } catch (cleanup: unknown) {
                    throw new HostOperationError(
                        ConnectorHostErrorCode.OperationFailed,
                        caught instanceof HostOperationError
                            ? caught.message + '. Process cleanup could not be confirmed.'
                            : 'Process launch failed and cleanup could not be confirmed',
                        false,
                        { cause: new AggregateError([caught, cleanup]) },
                    );
                }
            }
            throw caught;
        }
    }

    /** Each snapshot carries independent byte cursors for stdout and stderr. */
    public snapshot(
        stdoutOffset: bigint,
        stderrOffset: bigint,
        maximum: number,
    ): HostProcessSnapshot {
        HostWorkspaceValidation.count(maximum, 1, HostWorkspaceLimits.chunkBytes);
        return {
            processId: this.id,
            running: this.#running,
            treeRunning: this.#treeRunning,
            outputComplete: !this.#running && this.#output.complete,
            stdoutFinalBytes: this.#output.stdoutFinalBytes,
            stderrFinalBytes: this.#output.stderrFinalBytes,
            exitCode: this.#exitCode,
            signal: this.#signal,
            failure: this.#failure,
            stdout: this.#output.stdout(stdoutOffset, maximum),
            stderr: this.#output.stderr(stderrOffset, maximum),
        };
    }

    /** A bounded write awaits the OS stream callback; overlapping writes cannot accumulate an unbounded queue. */
    public async input(bytes: Buffer, end: boolean): Promise<void> {
        if (
            !Buffer.isBuffer(bytes) ||
            bytes.length > HostWorkspaceLimits.chunkBytes ||
            typeof end !== 'boolean'
        ) {
            throw new Error('Invalid host process input');
        }
        if (
            !this.#running ||
            this.#stopping ||
            this.#child.stdin.destroyed ||
            this.#child.stdin.writableEnded ||
            this.#inputPending
        ) {
            throw new Error('Host process input is closed or busy');
        }
        this.#inputPending = true;
        const written: Promise<void> = new Promise<void>(
            (resolve: () => void, reject: (error: Error) => void): void => {
                this.#child.stdin.write(bytes, (error: Error | null | undefined): void => {
                    if (error !== null && error !== undefined) {
                        reject(error);
                    } else {
                        resolve();
                    }
                });
            },
        );
        let deadline: NodeJS.Timeout | undefined;
        const expired: Promise<never> = new Promise<never>(
            (_resolve: (value: never) => void, reject: (error: Error) => void): void => {
                deadline = setTimeout((): void => {
                    this.#failureChanged(this.#failure ?? HostProcessFailure.Timeout);
                    reject(
                        new Error(
                            'Host process input timed out; some bytes may have been delivered',
                        ),
                    );
                }, HostWorkspaceLimits.inputWriteMs);
            },
        );
        try {
            await Promise.race([written, expired]);
            if (end) {
                this.#child.stdin.end();
            }
        } catch (caught: unknown) {
            await this.#terminate();
            await Promise.allSettled([written]);
            throw caught;
        } finally {
            clearTimeout(deadline);
            this.#inputPending = false;
        }
    }

    /** Cancellation is an observation of a potentially effectful command, never an automatic retry signal. */
    public async stop(): Promise<void> {
        this.#failureChanged(
            this.#failure ??
                (this.#running || (process.platform === 'win32' && this.#treeRunning !== false)
                    ? HostProcessFailure.Cancelled
                    : null),
        );
        await this.#terminate();
    }

    /** Disposal closes its live group owner even when the initial executable already exited. */
    public async [Symbol.asyncDispose](): Promise<void> {
        await this.stop();
        clearTimeout(this.#retentionTimer);
        this.changes[Symbol.dispose]();
    }

    /**
     * The finite lifetime and optional retention deadline begin at native admission.
     *
     * @remarks
     * POSIX admits at construction. Windows admits only after the broker acknowledges creation
     * inside the owned Job, so broker startup latency cannot cancel or consume the command's
     * lifetime; admission keeps its own bounded startup deadline. A stop that began before
     * admission is never followed by a new lifetime timer.
     */
    #admitted(): void {
        if (!this.#stopping) {
            this.#timer = setTimeout((): void => {
                this.#failureChanged(
                    this.#failure ??
                        (this.#running ||
                        (process.platform === 'win32' && this.#treeRunning !== false)
                            ? HostProcessFailure.Timeout
                            : null),
                );
                void this.#terminate().catch((): void => undefined);
            }, this.#timeoutMs);
        }
        const retention: number | undefined = this.#retentionAfterTimeoutMs;
        if (retention !== undefined) {
            this.#retentionTimer = setTimeout((): void => {
                void this.#expire(this.#expired);
            }, this.#timeoutMs + retention);
        }
    }

    static #piped(child: ChildProcess): child is ChildProcessWithoutNullStreams {
        return child.stdin !== null && child.stdout !== null && child.stderr !== null;
    }

    #message(raw: unknown): void {
        try {
            this.#result(HostProcessReportCodec.decode(raw));
        } catch {
            this.#failureChanged(HostProcessFailure.Launch);
            void this.#terminate().catch((): void => undefined);
        }
    }

    #result(result: HostProcessReport): void {
        if (!this.#startup.confirmed && result.launchFailed) {
            this.#startup.failed(
                new HostOperationError(
                    ConnectorHostErrorCode.OperationFailed,
                    'The job launcher reported a failure before confirming process creation',
                    false,
                ),
            );
        }
        this.#output.accept(result);
        this.#targetClosed.resolve(undefined);
        this.#running = false;
        this.#treeRunning = result.treeRunning;
        if (result.treeRunning === false) {
            this.#stopChanged.resolve(undefined);
        }
        this.#exitCode = result.exitCode;
        this.#signal = result.signal;
        this.#failure ??= result.launchFailed
            ? HostProcessFailure.Launch
            : result.signal !== null
              ? HostProcessFailure.Signal
              : null;
    }

    #failureChanged(failure: HostProcessFailure | null): void {
        if (failure !== this.#failure) {
            this.#failure = failure;
            this.changes.advance();
        }
    }

    #rejected(result: HostProcessWindowsRejectedFrame): void {
        this.#startup.failed(
            new HostOperationError(
                result.errorCode,
                'Windows rejected process creation' +
                    (result.nativeError === null
                        ? ''
                        : ' (Win32 ' + result.nativeError.toString() + ')'),
                true,
            ),
        );
        this.#result({
            exitCode: null,
            signal: null,
            launchFailed: true,
            treeRunning: false,
            stdoutFinalBytes: 0n,
            stderrFinalBytes: 0n,
        });
    }

    async #terminate(): Promise<void> {
        this.#stopping = true;
        const stopping: Promise<void> = this.#stop ?? this.#kill();
        this.#stop = stopping;
        try {
            await stopping;
        } finally {
            if (this.#stop === stopping) {
                this.#stop = null;
            }
        }
    }

    async #expire(expired: (process: HostProcess) => void): Promise<void> {
        try {
            await this[Symbol.asyncDispose]();
            expired(this);
        } catch {
            /** Unknown ownership keeps its bounded cell; expiry never invents quiescence. */
        }
    }

    async #stopWindows(): Promise<void> {
        if (this.#treeStopped()) {
            return;
        }
        if (!this.#ownerRunning || this.#channel === null) {
            throw new Error('Windows host process tree shutdown is unconfirmed');
        }
        this.#stopChanged = Promise.withResolvers<undefined>();
        const changed: Promise<undefined> = this.#stopChanged.promise;
        let timer: NodeJS.Timeout | undefined;
        const deadline: Promise<undefined> = new Promise<undefined>(
            (resolve: (value: undefined) => void): void => {
                timer = setTimeout((): void => resolve(undefined), 25000);
            },
        );
        try {
            let delivered: boolean = false;
            await Promise.race([
                (async (): Promise<void> => {
                    await this.#channel?.stop();
                    delivered = true;
                })(),
                changed,
                deadline,
            ]);
            if (this.#treeStopped()) {
                return;
            }
            if (delivered) {
                await Promise.race([changed, deadline]);
            }
            if (!this.#treeStopped()) {
                throw new Error(
                    'Windows host process tree shutdown is unconfirmed; ownership was retained',
                );
            }
        } finally {
            clearTimeout(timer);
        }
    }

    #treeStopped(): boolean {
        return this.#treeRunning === false;
    }

    async #reapTarget(): Promise<void> {
        let timer: NodeJS.Timeout | undefined;
        const deadline: Promise<undefined> = new Promise<undefined>(
            (resolve: (value: undefined) => void): void => {
                timer = setTimeout((): void => resolve(undefined), 500);
            },
        );
        try {
            this.#child.send({ operation: 'stop' }, (): void => undefined);
            await Promise.race([this.#targetClosed.promise, deadline]);
        } finally {
            clearTimeout(timer);
        }
    }

    async #kill(): Promise<void> {
        clearTimeout(this.#timer);
        if (process.platform === 'win32') {
            await this.#stopWindows();
        }
        const pid: number | undefined = this.#child.pid;
        if (pid !== undefined && this.#ownerRunning) {
            if (process.platform === 'win32') {
                /** The native job was observed empty before its broker can be closed. */
                this.#child.kill();
            } else {
                if (this.#running && this.#child.connected) {
                    await this.#reapTarget();
                }
                try {
                    if (this.#ownerRunning) {
                        process.kill(-pid, 'SIGKILL');
                    }
                } catch (caught: unknown) {
                    if (
                        !(caught instanceof Error) ||
                        !('code' in caught) ||
                        caught.code !== 'ESRCH'
                    ) {
                        throw caught;
                    }
                }
            }
        }
        this.#child.stdin.destroy();
        this.#child.stdout.destroy();
        this.#child.stderr.destroy();
        await this.#channel?.[Symbol.asyncDispose]();
        await this.#closed.promise;
    }
}
