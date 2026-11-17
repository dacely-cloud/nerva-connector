// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

import { execFile, type ExecException } from 'node:child_process';
import { access, constants } from 'node:fs/promises';
import { delimiter, join } from 'node:path';
import { HostDesktopLimits } from './HostDesktopTypes.js';
import { HostDesktopError } from './HostDesktopError.js';

/** Fixed installed desktop tools run without shell interpretation and with bounded buffered output. */
export class HostDesktopCommand {
    /** Resolve an installed tool in the actual session PATH; never install dependencies implicitly. */
    public static async installed(
        program: string,
        environment: NodeJS.ProcessEnv,
    ): Promise<boolean> {
        const paths: readonly string[] = (environment['PATH'] ?? '').split(delimiter);
        for (const path of paths) {
            if (path === '') {
                continue;
            }
            try {
                await access(join(path, program), constants.X_OK);
                return true;
            } catch {
                /** Missing or inaccessible candidates are not an available desktop tool. */
            }
        }
        return false;
    }

    /** Bounded input drains through an owned pipe; failures join subprocess closure before returning. */
    public static async run(
        program: string,
        arguments_: readonly string[],
        environment: NodeJS.ProcessEnv,
        maximum: number,
        input?: string,
    ): Promise<Buffer> {
        if (
            !Number.isSafeInteger(maximum) ||
            maximum < 1 ||
            maximum > HostDesktopLimits.imageBytes ||
            (input !== undefined && Buffer.byteLength(input) > HostDesktopLimits.inputBytes)
        ) {
            throw new Error('Desktop command exceeds pipe limits');
        }
        return await new Promise<Buffer>(
            (resolve: (bytes: Buffer) => void, reject: (error: Error) => void): void => {
                let inputFailure: Error | null = null;
                let inputFinished: boolean = false;
                const child: ReturnType<typeof execFile> = execFile(
                    program,
                    arguments_,
                    {
                        env: environment,
                        encoding: 'buffer',
                        timeout: HostDesktopLimits.timeoutMs,
                        killSignal: 'SIGKILL',
                        maxBuffer: maximum,
                        windowsHide: true,
                    },
                    (error: ExecException | null, stdout: Buffer, stderr: Buffer): void => {
                        if (inputFailure !== null) {
                            reject(inputFailure);
                        } else if (error !== null) {
                            const failure: Error =
                                error instanceof Error
                                    ? error
                                    : new Error('Desktop command execution failed');
                            reject(
                                arguments_.includes('--desktop')
                                    ? HostDesktopError.read(stderr, error.killed === true)
                                    : failure,
                            );
                        } else if (!inputFinished) {
                            reject(new Error('Desktop input pipe closed before completion'));
                        } else {
                            resolve(stdout);
                        }
                    },
                );
                if (child.stdin === null) {
                    inputFailure = new Error('Desktop input pipe unavailable');
                    child.kill('SIGKILL');
                    return;
                }
                child.stdin.once('error', (error: Error): void => {
                    inputFailure = new Error('Desktop input pipe failed; effect may be partial', {
                        cause: error,
                    });
                    child.kill('SIGKILL');
                });
                child.stdin.once('finish', (): void => {
                    inputFinished = true;
                });
                /** An inputless command needs EOF only; even an empty chunk can race a closed child pipe. */
                if (input === undefined) {
                    child.stdin.end();
                } else {
                    child.stdin.end(input);
                }
            },
        );
    }
}
