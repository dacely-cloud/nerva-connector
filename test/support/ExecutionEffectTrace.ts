// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

import { ChildProcess } from 'node:child_process';
import { subscribe, unsubscribe } from 'node:diagnostics_channel';
import { ExecutionSetupFailure } from '../../src/execution/ExecutionTypes.js';

/** Fixed observer milestones distinguish wrapper assertions from the native launch path. */
export enum ExecutionFreshPhase {
    NotStarted = 'not-started',
    Dispatch = 'dispatch',
    JournalCommit = 'journal-commit',
    JournalDecode = 'journal-decode',
    Group = 'group-empty',
    Root = 'root-untouched',
    Observed = 'root-observed',
    Returned = 'dispatch-return',
}
/** Only safe operating-system error classes cross the qualification output boundary. */
export enum ExecutionTraceErrno {
    Permission = 'EPERM',
    Access = 'EACCES',
    Missing = 'ENOENT',
    Io = 'EIO',
    Invalid = 'EINVAL',
    Memory = 'ENOMEM',
    Busy = 'EBUSY',
    Limit = 'EMFILE',
    Other = 'other',
}
/** No underlying stderr text is returned, including filenames embedded in loader errors. */
export enum ExecutionTraceStderr {
    None = 'none',
    Native = 'native-setup',
    BwrapNamespace = 'bwrap-namespace',
    BwrapPermission = 'bwrap-permission',
    Bwrap = 'bwrap-other',
    Loader = 'loader',
    Permission = 'permission',
    Other = 'other',
}
/** Unexpected signals remain a fixed class rather than unchecked strings. */
export enum ExecutionTraceSignal {
    Kill = 'SIGKILL',
    Abort = 'SIGABRT',
    Terminate = 'SIGTERM',
    Segfault = 'SIGSEGV',
    Syscall = 'SIGSYS',
    Bus = 'SIGBUS',
    Other = 'other',
}
/** Bounded passive observations contain neither process identity nor executable or command data. */
export interface ExecutionFreshTrace {
    readonly phase: ExecutionFreshPhase;
    readonly failedPhase: ExecutionFreshPhase | null;
    readonly errno: ExecutionTraceErrno | null;
    readonly observed: boolean;
    readonly spawned: boolean;
    readonly spawnError: ExecutionTraceErrno | null;
    readonly exitCode: number | null;
    readonly signal: ExecutionTraceSignal | null;
    readonly stdoutSeen: boolean;
    readonly stderrBytes: number;
    readonly stderrClass: ExecutionTraceStderr;
    readonly nativeSetupFailure: ExecutionSetupFailure | null;
    readonly truncated: boolean;
}
/** Every handler installed on a particular owned observation is removable without affecting the production runner's handlers. */
interface ExecutionTraceListeners {
    readonly child: ChildProcess;
    readonly spawn: () => void;
    readonly error: (caught: Error) => void;
    readonly close: (code: number | null, signal: NodeJS.Signals | null) => void;
    readonly stdout: (bytes: unknown) => void;
    readonly stderr: (bytes: unknown) => void;
}
/** Public Node process diagnostics are observed without changing process creation, signals, stdin or production listeners. */
export class ExecutionEffectTrace implements Disposable {
    readonly #listeners: Map<ChildProcess, ExecutionTraceListeners> = new Map();
    readonly #bytes: Buffer = Buffer.alloc(4096);
    #size: number = 0;
    #observed: boolean = false;
    #spawned: boolean = false;
    #spawnError: ExecutionTraceErrno | null = null;
    #exitCode: number | null = null;
    #signal: ExecutionTraceSignal | null = null;
    #stdout: boolean = false;
    #stderrBytes: number = 0;
    #truncated: boolean = false;
    #failedPhase: ExecutionFreshPhase | null = null;
    #errno: ExecutionTraceErrno | null = null;
    #closed: boolean = false;
    /** Milestones are fixed labels supplied solely by the finite qualification wrapper. */
    public phase: ExecutionFreshPhase = ExecutionFreshPhase.NotStarted;
    readonly #message: (message: unknown) => void = (message: unknown): void => {
        try {
            if (typeof message !== 'object' || message === null || !('process' in message)) {
                return;
            }
            const child: unknown = Reflect.get(message, 'process');
            if (child instanceof ChildProcess) {
                this.#observe(child);
            }
        } catch {
            this.#truncated = true;
        }
    };
    /** Node publishes the process before spawn; handlers wait for spawn before inspecting its final argument vector. */
    public constructor() {
        subscribe('child_process', this.#message);
    }
    /** Exceptions contribute only one fixed phase and an allowlisted errno class. */
    public failure(caught: unknown): void {
        this.#failedPhase ??= this.phase;
        this.#errno ??= ExecutionEffectTrace.#parseErrno(caught);
    }
    /** Snapshot classifies retained private stderr, without copying it into the report. */
    public snapshot(): ExecutionFreshTrace {
        const text: string = this.#bytes.subarray(0, this.#size).toString('utf8');
        const native: ExecutionSetupFailure | null =
            Object.values(ExecutionSetupFailure).find(
                (stage: ExecutionSetupFailure): boolean =>
                    text === 'NERVA_EXEC_SETUP ' + stage + '\n',
            ) ?? null;
        const category: ExecutionTraceStderr =
            this.#size === 0
                ? ExecutionTraceStderr.None
                : native !== null
                  ? ExecutionTraceStderr.Native
                  : text.includes('error while loading shared libraries:')
                    ? ExecutionTraceStderr.Loader
                    : text.includes('bwrap:')
                      ? text.includes('namespace')
                          ? ExecutionTraceStderr.BwrapNamespace
                          : /Permission denied|Operation not permitted/u.test(text)
                            ? ExecutionTraceStderr.BwrapPermission
                            : ExecutionTraceStderr.Bwrap
                      : /Permission denied|Operation not permitted/u.test(text)
                        ? ExecutionTraceStderr.Permission
                        : ExecutionTraceStderr.Other;
        return {
            phase: this.phase,
            failedPhase: this.#failedPhase,
            errno: this.#errno,
            observed: this.#observed,
            spawned: this.#spawned,
            spawnError: this.#spawnError,
            exitCode: this.#exitCode,
            signal: this.#signal,
            stdoutSeen: this.#stdout,
            stderrBytes: this.#stderrBytes,
            stderrClass: category,
            nativeSetupFailure: native,
            truncated: this.#truncated,
        };
    }
    #matches(child: ChildProcess): boolean {
        return child.spawnargs.length === 2 && child.spawnargs[1] === '--launch';
    }
    #observe(child: ChildProcess): void {
        if (this.#closed || this.#listeners.has(child)) {
            return;
        }
        if (this.#listeners.size >= 16) {
            this.#truncated = true;
            return;
        }
        const listeners: ExecutionTraceListeners = {
            child,
            spawn: (): void => {
                if (!this.#matches(child)) {
                    this.#remove(child);
                    return;
                }
                this.#observed = true;
                this.#spawned = true;
                child.stdout?.on('data', listeners.stdout);
                child.stderr?.on('data', listeners.stderr);
            },
            error: (caught: Error): void => {
                if (this.#matches(child)) {
                    this.#observed = true;
                    this.#spawnError = ExecutionEffectTrace.#parseErrno(caught);
                }
            },
            close: (code: number | null, signal: NodeJS.Signals | null): void => {
                if (this.#matches(child)) {
                    this.#observed = true;
                    this.#exitCode =
                        code !== null && Number.isInteger(code) && code >= 0 && code <= 255
                            ? code
                            : null;
                    this.#signal =
                        signal === null ? null : ExecutionEffectTrace.#parseSignal(signal);
                }
                this.#remove(child);
            },
            stdout: (bytes: unknown): void => {
                if (Buffer.isBuffer(bytes) && bytes.byteLength > 0) {
                    this.#stdout = true;
                }
            },
            stderr: (bytes: unknown): void => {
                if (!Buffer.isBuffer(bytes)) {
                    this.#truncated = true;
                    return;
                }
                this.#stderrBytes = Math.min(65536, this.#stderrBytes + bytes.byteLength);
                const length: number = Math.min(
                    this.#bytes.byteLength - this.#size,
                    bytes.byteLength,
                );
                bytes.copy(this.#bytes, this.#size, 0, length);
                this.#size += length;
                if (length !== bytes.byteLength) {
                    this.#truncated = true;
                }
            },
        };
        this.#listeners.set(child, listeners);
        child.once('spawn', listeners.spawn);
        child.once('error', listeners.error);
        child.once('close', listeners.close);
    }
    #remove(child: ChildProcess): void {
        const listeners: ExecutionTraceListeners | undefined = this.#listeners.get(child);
        if (listeners === undefined) {
            return;
        }
        child.off('spawn', listeners.spawn);
        child.off('error', listeners.error);
        child.off('close', listeners.close);
        child.stdout?.off('data', listeners.stdout);
        child.stderr?.off('data', listeners.stderr);
        this.#listeners.delete(child);
    }
    static #parseSignal(signal: NodeJS.Signals): ExecutionTraceSignal {
        switch (signal) {
            case 'SIGKILL':
                return ExecutionTraceSignal.Kill;
            case 'SIGABRT':
                return ExecutionTraceSignal.Abort;
            case 'SIGTERM':
                return ExecutionTraceSignal.Terminate;
            case 'SIGSEGV':
                return ExecutionTraceSignal.Segfault;
            case 'SIGSYS':
                return ExecutionTraceSignal.Syscall;
            case 'SIGBUS':
                return ExecutionTraceSignal.Bus;
            default:
                return ExecutionTraceSignal.Other;
        }
    }
    static #parseErrno(caught: unknown): ExecutionTraceErrno {
        const code: unknown =
            typeof caught === 'object' && caught !== null && 'code' in caught
                ? Reflect.get(caught, 'code')
                : null;
        return (
            Object.values(ExecutionTraceErrno).find(
                (value: ExecutionTraceErrno): boolean => value === code,
            ) ?? ExecutionTraceErrno.Other
        );
    }
    /** Unsubscribing and removing only these listeners leaves the runner's resource ownership untouched. */
    public [Symbol.dispose](): void {
        if (!this.#closed) {
            this.#closed = true;
            unsubscribe('child_process', this.#message);
            for (const child of this.#listeners.keys()) {
                this.#remove(child);
            }
            this.#bytes.fill(0);
        }
    }
}
