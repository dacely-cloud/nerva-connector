// SPDX-FileCopyrightText: 2026 Dacely <business@dacely.com>
// SPDX-License-Identifier: LicenseRef-Proprietary

import { HostByteRing } from './HostByteRing.js';
import { HostReadRevision } from './HostReadRevision.js';
import { HostProcessLaunch, type HostProcessLaunchOptions } from './HostProcessLaunch.js';
import {
    HostShell,
    HostProcessFailure,
    HostWorkspaceLimits,
    type HostProcessOutput,
} from './HostWorkspaceTypes.js';
import { HostWorkspaceValidation } from './HostWorkspaceValidation.js';
import { HostTerminalBackend } from './HostTerminalBackend.js';
import { HostTerminalStopProof } from './HostTerminalStopProof.js';
import {
    HostTerminalReportKind,
    type HostTerminalReport,
    type HostTerminalStateReport,
} from './HostTerminalReport.js';
import {
    HostTerminalControlKind,
    HostTerminalLimits,
    type HostTerminalControl,
    type HostTerminalRequest,
    type HostTerminalSnapshot,
} from './HostTerminalTypes.js';

/** A finite native-input waiter never substitutes Node pipe buffering for actual PTY delivery. */
interface HostTerminalInputWaiter {
    readonly target: bigint;
    readonly result: PromiseWithResolvers<undefined>;
}

/** An explicitly authorized terminal owns native startup, binary I/O, retained output and independently joined cleanup. */
export class HostTerminal implements AsyncDisposable {
    /** This revision belongs to the actual retained terminal and carries no stream bytes or completion assertion. */
    public readonly changes: HostReadRevision = new HostReadRevision();
    /** The terminal's program and every process it started have exited, or the backend can no longer tell. */
    public get ended(): boolean {
        return !(this.#state?.running ?? !this.#backend.ended) && this.#state?.treeRunning !== true;
    }
    readonly #backend: HostTerminalBackend;
    readonly #output: HostByteRing = new HostByteRing();
    readonly #ready: PromiseWithResolvers<undefined> = Promise.withResolvers<undefined>();
    readonly #startup: AbortController = new AbortController();
    readonly #timeoutMs: number;
    readonly #retentionAfterTimeoutMs: number | undefined;
    readonly #expired: (terminal: HostTerminal) => void;
    #timer: NodeJS.Timeout | undefined = undefined;
    #retention: NodeJS.Timeout | undefined = undefined;
    #starting: Promise<void> | null = null;
    #stopAttempt: Promise<void> | null = null;
    #state: HostTerminalStateReport | null = null;
    #readySeen: boolean = false;
    #stopping: boolean = false;
    #stoppedProof: boolean = false;
    #inputPending: boolean = false;
    #submitted: bigint = 0n;
    #accepted: bigint = 0n;
    #inputWaiter: HostTerminalInputWaiter | null = null;
    #failure: HostProcessFailure | null = null;
    #cols: number;
    #rows: number;

    private constructor(
        public readonly id: string,
        request: HostTerminalRequest,
        expired: (terminal: HostTerminal) => void,
    ) {
        this.#cols = request.cols;
        this.#rows = request.rows;
        this.#timeoutMs = request.timeoutMs;
        this.#retentionAfterTimeoutMs = request.retentionAfterTimeoutMs;
        this.#expired = expired;
        this.#backend = new HostTerminalBackend({
            report: (report: HostTerminalReport, control: HostTerminalControl | null): void =>
                this.#report(report, control),
            output: (bytes: Buffer): void => {
                try {
                    this.#output.append(bytes);
                    if (bytes.length !== 0) {
                        this.changes.advance();
                    }
                    if (
                        this.#state?.outputFinalBytes !== null &&
                        this.#state?.outputFinalBytes !== undefined &&
                        this.#output.endOffset > this.#state.outputFinalBytes
                    ) {
                        throw new Error('Terminal output exceeded its committed EOF');
                    }
                } catch (error: unknown) {
                    this.#failed(
                        error instanceof Error ? error : new Error('Terminal output failed'),
                    );
                }
            },
            failed: (error: Error, closed: boolean = false): void => this.#failed(error, closed),
            closed: (): void => {
                this.#inputWaiter?.result.reject(
                    new Error('Terminal closed before input delivery was confirmed'),
                );
                if (!this.#readySeen) {
                    this.#ready.reject(new Error('Terminal closed before native readiness'));
                }
                if (this.#state?.running !== false || this.#state.outputFinalBytes === null) {
                    this.#failure ??= HostProcessFailure.Launch;
                }
                this.changes.advance();
            },
        });
        void this.#watchClose();
    }

    /** The callback registers this exact owner before startup can create any native resource. */
    public static async create(
        id: string,
        request: HostTerminalRequest,
        directory: string,
        windowsLauncher?: string,
        expired: (terminal: HostTerminal) => void = (): void => undefined,
        created: (terminal: HostTerminal) => void = (): void => undefined,
    ): Promise<HostTerminal> {
        HostWorkspaceValidation.process(request);
        HostWorkspaceValidation.count(request.cols, 2, 500);
        HostWorkspaceValidation.count(request.rows, 1, 200);
        HostWorkspaceValidation.directory(directory);
        let launch: HostProcessLaunchOptions = HostProcessLaunch.prepare(request);
        if (request.shell === HostShell.PowerShell || request.shell === HostShell.Pwsh) {
            launch = {
                ...launch,
                arguments: launch.arguments.filter(
                    (value: string): boolean => value !== '-NonInteractive',
                ),
            };
        }
        const owner: HostTerminal = new HostTerminal(id, request, expired);
        const ready: Promise<void> = HostTerminalDeadline.wait(
            owner.#ready.promise,
            HostTerminalLimits.readyMs,
            'Terminal native readiness timed out',
        );
        try {
            created(owner);
            owner.#starting = owner.#backend.start(
                {
                    launch,
                    directory,
                    environment: request.environment,
                    cols: request.cols,
                    rows: request.rows,
                    windowsLauncher,
                },
                owner.#startup.signal,
            );
            await Promise.all([owner.#starting, ready]);
            return owner;
        } catch (error: unknown) {
            owner.#ready.reject(error);
            await Promise.allSettled([ready]);
            owner.#failureChanged(owner.#failure ?? HostProcessFailure.Launch);
            try {
                await owner.stop();
            } catch {
                /* The registered exact owner remains available for explicit cleanup retry. */
            }
            throw error;
        }
    }

    /** A capability probe executes only the pinned helper's native probe mode. */
    public static async available(windowsLauncher?: string): Promise<boolean> {
        return await HostTerminalBackend.available(windowsLauncher);
    }

    /** Output stays a newest-four-MiB window with explicit historical truncation and exact cumulative counts. */
    public snapshot(offset: bigint, maximum: number): HostTerminalSnapshot {
        HostWorkspaceValidation.count(maximum, 1, HostWorkspaceLimits.chunkBytes);
        const output: HostProcessOutput = this.#output.read(offset, maximum);
        const finalOutputBytes: bigint | null = this.#state?.outputFinalBytes ?? null;
        return {
            processId: this.id,
            running: this.#state?.running ?? !this.#backend.ended,
            treeRunning: this.#state?.treeRunning ?? null,
            cols: this.#cols,
            rows: this.#rows,
            outputComplete:
                finalOutputBytes !== null && this.#output.endOffset === finalOutputBytes,
            finalOutputBytes,
            exitCode: this.#state?.exitCode ?? null,
            signal: this.#state?.signal ?? null,
            failure: this.#failure,
            output,
        };
    }

    /** Binary chunks are serialized and each waits for the native cumulative delivery acknowledgment. */
    public async input(bytes: Buffer): Promise<void> {
        if (
            !Buffer.isBuffer(bytes) ||
            bytes.length > HostWorkspaceLimits.chunkBytes ||
            this.#inputPending ||
            this.#stopping ||
            this.#backend.ended
        ) {
            throw new Error('Terminal input is closed, busy or exceeds its bound');
        }
        this.#inputPending = true;
        try {
            for (let offset: number = 0; offset < bytes.length; offset += 32768) {
                const chunk: Buffer = bytes.subarray(offset, offset + 32768);
                this.#submitted += BigInt(chunk.length);
                if (this.#submitted > 9223372036854775807n) {
                    throw new Error('Terminal input exceeds its exact counter bound');
                }
                const result: PromiseWithResolvers<undefined> = Promise.withResolvers<undefined>();
                this.#inputWaiter = { target: this.#submitted, result };
                try {
                    await HostTerminalDeadline.wait(
                        Promise.all([this.#backend.input(chunk), result.promise]),
                        HostTerminalLimits.inputMs,
                        'Terminal input delivery was not confirmed; some bytes may have reached the program',
                    );
                } finally {
                    this.#inputWaiter = null;
                }
            }
        } catch (error: unknown) {
            this.#backend.stopInput();
            await this.stop();
            throw error;
        } finally {
            this.#inputPending = false;
        }
    }

    /** A resize is effective only after the matching native acknowledgment. */
    public async resize(cols: number, rows: number): Promise<void> {
        HostWorkspaceValidation.count(cols, 2, 500);
        HostWorkspaceValidation.count(rows, 1, 200);
        if (this.#stopping || this.#backend.ended) {
            throw new Error('Terminal is stopped');
        }
        await this.#backend.control(HostTerminalControlKind.Resize, cols, rows);
    }

    /** Failed cleanup keeps this original owner and permits a later explicit same-owner retry. */
    public async stop(): Promise<void> {
        this.#stopping = true;
        this.#startup.abort();
        clearTimeout(this.#timer);
        this.#failureChanged(
            this.#failure ?? (this.#state?.running === false ? null : HostProcessFailure.Cancelled),
        );
        this.#stopAttempt ??= this.#stop();
        const attempt: Promise<void> = this.#stopAttempt;
        try {
            await attempt;
        } finally {
            if (this.#stopAttempt === attempt) {
                this.#stopAttempt = null;
            }
        }
    }

    public async [Symbol.asyncDispose](): Promise<void> {
        await this.stop();
        clearTimeout(this.#retention);
        this.changes[Symbol.dispose]();
    }

    async #stop(): Promise<void> {
        try {
            await this.#starting;
        } catch {
            /* Startup may fail after native creation; the registered backend still owns cleanup. */
        }
        if (!this.#backend.spawned) {
            await this.#backend.closeControl();
            await this.#backend.closed;
            return;
        }
        this.#backend.pause(false);
        if (
            !this.#stoppedProof &&
            process.platform === 'win32' &&
            HostTerminalStopProof.known(this.#state)
        ) {
            this.#stoppedProof = true;
        }
        if (!this.#stoppedProof) {
            if (this.#backend.ended) {
                throw new Error('Terminal native shutdown ownership is unconfirmed');
            }
            await this.#backend.control(HostTerminalControlKind.Stop);
            HostTerminalStopProof.require(this.#state);
            this.#stoppedProof = true;
        }
        await this.#backend.closeControl();
        await HostTerminalDeadline.wait(
            this.#backend.closed,
            HostTerminalLimits.stopMs,
            'Terminal native shutdown was not joined',
        );
        if (this.#state?.outputFinalBytes !== this.#output.endOffset) {
            throw new Error('Terminal output delivery did not match its exact native EOF');
        }
    }

    /**
     * The finite lifetime and optional retention deadline begin at native readiness.
     *
     * @remarks
     * Pin verification, helper or broker launch and pseudoconsole creation have their own bounded
     * readiness deadline, so startup latency neither consumes nor cancels the requested lifetime.
     * A stop that began before readiness is never followed by a new lifetime timer. A terminal that
     * never becomes ready is disposed or retained by its creator rather than by these timers.
     */
    #admitted(): void {
        if (!this.#stopping) {
            this.#timer = setTimeout((): void => {
                this.#failureChanged(this.#failure ?? HostProcessFailure.Timeout);
                void this.#backgroundStop();
            }, this.#timeoutMs);
        }
        const retention: number | undefined = this.#retentionAfterTimeoutMs;
        if (retention !== undefined) {
            this.#retention = setTimeout((): void => {
                void this.#expire(this.#expired);
            }, this.#timeoutMs + retention);
        }
    }

    #report(report: HostTerminalReport, control: HostTerminalControl | null): void {
        if (report.kind === HostTerminalReportKind.Ready) {
            if (this.#readySeen || report.cols !== this.#cols || report.rows !== this.#rows) {
                throw new Error('Terminal readiness changed');
            }
            this.#readySeen = true;
            this.#admitted();
            this.#ready.resolve(undefined);
        } else if (report.kind === HostTerminalReportKind.Input) {
            if (report.acceptedBytes < this.#accepted || report.acceptedBytes > this.#submitted) {
                throw new Error('Terminal input acknowledgment changed');
            }
            this.#accepted = report.acceptedBytes;
            if (this.#inputWaiter !== null && this.#accepted >= this.#inputWaiter.target) {
                this.#inputWaiter.result.resolve(undefined);
            }
        } else if (report.kind === HostTerminalReportKind.State) {
            if (
                !this.#readySeen ||
                (this.#state?.running === false &&
                    (report.running ||
                        report.exitCode !== this.#state.exitCode ||
                        report.signal !== this.#state.signal)) ||
                (this.#state?.treeRunning === false && report.treeRunning !== false) ||
                (this.#state?.outputFinalBytes !== null &&
                    this.#state?.outputFinalBytes !== undefined &&
                    report.outputFinalBytes !== this.#state.outputFinalBytes) ||
                (report.outputFinalBytes !== null &&
                    report.outputFinalBytes < this.#output.endOffset)
            ) {
                throw new Error('Terminal native completion evidence changed');
            }
            const changed: boolean =
                this.#state === null ||
                this.#state.running !== report.running ||
                this.#state.treeRunning !== report.treeRunning ||
                this.#state.outputFinalBytes !== report.outputFinalBytes;
            this.#state = report;
            if (report.signal !== null) {
                this.#failure ??= HostProcessFailure.Signal;
            }
            if (changed) {
                this.changes.advance();
            }
        } else if (
            report.kind === HostTerminalReportKind.Control &&
            report.ok &&
            control?.operation === HostTerminalControlKind.Stop
        ) {
            HostTerminalStopProof.require(this.#state);
            this.#stoppedProof = true;
        } else if (
            report.kind === HostTerminalReportKind.Control &&
            report.ok &&
            control?.operation === HostTerminalControlKind.Resize &&
            control.cols !== null &&
            control.rows !== null
        ) {
            const changed: boolean = this.#cols !== control.cols || this.#rows !== control.rows;
            this.#cols = control.cols;
            this.#rows = control.rows;
            if (changed) {
                this.changes.advance();
            }
        }
    }

    #failed(error: Error, closed: boolean = false): void {
        if (closed && this.#state?.running === false && this.#state.outputFinalBytes !== null) {
            return;
        }
        this.#failureChanged(this.#failure ?? HostProcessFailure.Launch);
        this.#ready.reject(error);
        this.#inputWaiter?.result.reject(error);
        void this.#backgroundStop();
    }

    #failureChanged(failure: HostProcessFailure | null): void {
        if (failure !== this.#failure) {
            this.#failure = failure;
            this.changes.advance();
        }
    }

    async #backgroundStop(): Promise<void> {
        try {
            await this.stop();
        } catch {
            /* Failed shutdown retains the owner and pool cell for explicit recovery. */
        }
    }
    async #watchClose(): Promise<void> {
        try {
            await this.#backend.closed;
        } catch (error: unknown) {
            this.#failed(
                error instanceof Error ? error : new Error('Terminal resource closure failed'),
            );
        }
    }
    async #expire(expired: (terminal: HostTerminal) => void): Promise<void> {
        try {
            await this[Symbol.asyncDispose]();
            expired(this);
        } catch {
            /* Expiry grants no authority to forget an unconfirmed original. */
        }
    }
}

/**
 * Timers bound observation without replaying or abandoning the underlying original.
 *
 * @remarks
 * An expired deadline rejects with a `TimeoutError`, which reports `canceled` with its effect still uncertain, as
 * an unconfirmed process launch does.
 */
class HostTerminalDeadline {
    public static async wait<T>(
        work: Promise<T>,
        milliseconds: number,
        message: string,
    ): Promise<T> {
        let timer: NodeJS.Timeout | undefined;
        const deadline: Promise<never> = new Promise<never>(
            (_resolve: (value: never) => void, reject: (error: Error) => void): void => {
                timer = setTimeout((): void => {
                    const error: Error = new Error(message);
                    error.name = 'TimeoutError';
                    reject(error);
                }, milliseconds);
            },
        );
        try {
            return await Promise.race([work, deadline]);
        } finally {
            clearTimeout(timer);
        }
    }
}
