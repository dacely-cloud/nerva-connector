// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { win32 } from 'node:path';

/** Raw bytes are decoded strictly after the finite native child exits. */
interface NvidiaCommandOutput {
    readonly stdout: Buffer;
    readonly stderr: Buffer;
}

/** The fixed read-only NVIDIA query executable, run without a shell or inherited environment. */
export class NvidiaSmi {
    /**
     * Runs one CSV query against the first installed NVIDIA executable for this platform.
     *
     * @remarks
     * Returns null when no NVIDIA tool is installed. Any other failure, including a timeout or a
     * nonzero exit, is thrown so callers keep their own unavailable-inventory handling.
     */
    public static async query(
        fields: readonly string[],
        signal: AbortSignal,
    ): Promise<string | null> {
        const platform: NodeJS.Platform = process.platform;
        const environment: Readonly<Record<string, string>> | null = this.#environment(platform);
        if (environment === null) {
            return null;
        }
        for (const path of this.paths(platform)) {
            signal.throwIfAborted();
            try {
                const result: NvidiaCommandOutput = await promisify(execFile)(
                    path,
                    ['--query-gpu=' + fields.join(','), '--format=csv,noheader,nounits'],
                    {
                        signal,
                        timeout: 2000,
                        killSignal: 'SIGKILL',
                        maxBuffer: 16384,
                        encoding: 'buffer',
                        windowsHide: true,
                        env: environment,
                    },
                );
                return new TextDecoder('utf-8', { fatal: true }).decode(result.stdout);
            } catch (caught: unknown) {
                signal.throwIfAborted();
                if (!(caught instanceof Error) || !('code' in caught) || caught.code !== 'ENOENT') {
                    throw caught;
                }
            }
        }
        return null;
    }

    /** Candidate executables in lookup order; Windows falls back to the legacy driver folder. */
    public static paths(platform: NodeJS.Platform): readonly string[] {
        if (platform === 'linux') {
            return ['/usr/bin/nvidia-smi'];
        }
        const root: string | undefined = this.#systemRoot();
        if (platform !== 'win32' || root === undefined) {
            return [];
        }
        const paths: string[] = [win32.join(root, 'System32', 'nvidia-smi.exe')];
        const programFiles: string | undefined =
            process.env['ProgramW6432'] ?? process.env['ProgramFiles'];
        if (
            programFiles !== undefined &&
            /^[A-Za-z]:\\/u.test(programFiles) &&
            win32.resolve(programFiles) === programFiles
        ) {
            paths.push(win32.join(programFiles, 'NVIDIA Corporation', 'NVSMI', 'nvidia-smi.exe'));
        }
        return paths;
    }

    static #environment(platform: NodeJS.Platform): Readonly<Record<string, string>> | null {
        if (platform !== 'win32') {
            return { LANG: 'C', LC_ALL: 'C' };
        }
        const root: string | undefined = this.#systemRoot();
        return root === undefined ? null : { SystemRoot: root, LANG: 'C', LC_ALL: 'C' };
    }

    static #systemRoot(): string | undefined {
        const root: string | undefined = process.env['SystemRoot'];
        return root !== undefined && /^[A-Za-z]:\\/u.test(root) && win32.resolve(root) === root
            ? root
            : undefined;
    }
}
