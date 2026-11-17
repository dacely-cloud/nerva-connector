// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

import { spawn, type ChildProcess } from 'node:child_process';
import { Boundary } from 'nerva-connector-protocol/protocol/Boundary.js';
import { HostProcessReportCodec, type HostProcessReport } from './HostProcessReport.ts';

/** Private worker startup contract is delivered over the owned IPC channel, never interpreted as source. */
export interface HostProcessWorkerInput {
    readonly executable: string;
    readonly arguments: readonly string[];
    readonly directory: string;
    readonly environment: Readonly<Record<string, string | undefined>>;
}

/** A private process group leader stays alive after target exit, keeping group identity pinned until disposal. */
class HostProcessWorker {
    #started: boolean = false;
    #child: ChildProcess | null = null;
    #stdoutBytes: bigint = 0n;
    #stderrBytes: bigint = 0n;
    #stdoutEnd: boolean = false;
    #stderrEnd: boolean = false;
    #result: HostProcessReport | null = null;
    #reportedExit: boolean = false;
    #reportedComplete: boolean = false;

    /** The worker admits exactly one validated private launch message. */
    public async run(): Promise<void> {
        if (process.platform === 'win32' || typeof process.send !== 'function') {
            throw new Error('Host process group worker requires POSIX and private IPC');
        }
        process.stdout.on('error', (): void => {
            process.kill(-process.pid, 'SIGKILL');
        });
        process.stderr.on('error', (): void => {
            process.kill(-process.pid, 'SIGKILL');
        });
        process.on('error', (): void => {
            process.kill(-process.pid, 'SIGKILL');
        });
        process.on('disconnect', (): void => {
            process.kill(-process.pid, 'SIGKILL');
        });
        process.on('message', (raw: unknown): void => {
            if (this.#started) {
                const control: Readonly<Record<string, unknown>> = Boundary.record(raw, [
                    'operation',
                ]);
                if (control['operation'] !== 'stop') {
                    process.kill(-process.pid, 'SIGKILL');
                    return;
                }
                this.#child?.kill('SIGKILL');
                return;
            }
            this.#started = true;
            try {
                const input: HostProcessWorkerInput = this.#decode(raw);
                const child: ChildProcess = spawn(input.executable, input.arguments, {
                    cwd: input.directory,
                    env: input.environment,
                    stdio: ['inherit', 'pipe', 'pipe'],
                    detached: false,
                });
                this.#child = child;
                if (child.stdout === null || child.stderr === null) {
                    child.kill('SIGKILL');
                    throw new Error('Host process output pipes unavailable');
                }
                child.stdout.on('error', (): void => {
                    process.kill(-process.pid, 'SIGKILL');
                });
                child.stderr.on('error', (): void => {
                    process.kill(-process.pid, 'SIGKILL');
                });
                child.stdout.on('data', (bytes: Buffer): void => {
                    this.#stdoutBytes += BigInt(bytes.length);
                });
                child.stderr.on('data', (bytes: Buffer): void => {
                    this.#stderrBytes += BigInt(bytes.length);
                });
                child.stdout.once('end', (): void => {
                    this.#stdoutEnd = true;
                    this.#publish();
                });
                child.stderr.once('end', (): void => {
                    this.#stderrEnd = true;
                    this.#publish();
                });
                child.stdout.pipe(process.stdout, { end: false });
                child.stderr.pipe(process.stderr, { end: false });
                let failed: boolean = false;
                child.once('error', (): void => {
                    failed = true;
                });
                child.once(
                    'exit',
                    (exitCode: number | null, signal: NodeJS.Signals | null): void => {
                        this.#result = {
                            exitCode,
                            signal,
                            launchFailed: failed,
                            treeRunning: null,
                            stdoutFinalBytes: null,
                            stderrFinalBytes: null,
                        };
                        this.#publish();
                    },
                );
                child.once('close', (): void => {
                    if (failed) {
                        this.#stdoutEnd = true;
                        this.#stderrEnd = true;
                        this.#result = {
                            exitCode: null,
                            signal: null,
                            launchFailed: true,
                            treeRunning: null,
                            stdoutFinalBytes: null,
                            stderrFinalBytes: null,
                        };
                        this.#publish();
                    }
                });
            } catch {
                this.#result = {
                    exitCode: null,
                    signal: null,
                    launchFailed: true,
                    treeRunning: null,
                    stdoutFinalBytes: null,
                    stderrFinalBytes: null,
                };
                this.#publish();
            }
        });
        await new Promise<never>((): void => undefined);
    }

    #publish(): void {
        if (this.#result === null) {
            return;
        }
        const complete: boolean = this.#stdoutEnd && this.#stderrEnd;
        if (this.#reportedExit && (!complete || this.#reportedComplete)) {
            return;
        }
        const report: HostProcessReport = {
            ...this.#result,
            stdoutFinalBytes: complete ? this.#stdoutBytes : null,
            stderrFinalBytes: complete ? this.#stderrBytes : null,
        };
        this.#reportedExit = true;
        this.#reportedComplete = complete;
        process.send?.(HostProcessReportCodec.encode(report));
    }

    #decode(raw: unknown): HostProcessWorkerInput {
        const value: Readonly<Record<string, unknown>> = Boundary.record(raw, [
            'executable',
            'arguments',
            'directory',
            'environment',
        ]);
        const executable: unknown = value['executable'];
        const directory: unknown = value['directory'];
        if (
            typeof executable !== 'string' ||
            executable.length === 0 ||
            executable.includes('\0') ||
            typeof directory !== 'string' ||
            directory.length === 0 ||
            directory.includes('\0')
        ) {
            throw new Error('Invalid private host worker launch');
        }
        const arguments_: readonly string[] = Boundary.array(value['arguments'], 1024).map(
            (argument: unknown): string => {
                if (
                    typeof argument !== 'string' ||
                    argument.includes('\0') ||
                    argument.length > 32767
                ) {
                    throw new Error('Invalid private host worker argument');
                }
                return argument;
            },
        );
        const environment: Readonly<Record<string, unknown>> = Boundary.record(
            value['environment'],
            Object.keys(value['environment'] ?? {}),
        );
        const selected: NodeJS.ProcessEnv = Object.create(null) as NodeJS.ProcessEnv;
        for (const [key, entry] of Object.entries(environment)) {
            if (
                !/^[^=\0]{1,256}$/u.test(key) ||
                (entry !== undefined && (typeof entry !== 'string' || entry.includes('\0')))
            ) {
                throw new Error('Invalid private host worker environment');
            }
            selected[key] = entry;
        }
        return { executable, arguments: arguments_, directory, environment: selected };
    }
}

try {
    await new HostProcessWorker().run();
} catch {
    process.exitCode = 70;
}
