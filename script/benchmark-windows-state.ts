// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { ConnectorWindowsCompiler } from './ConnectorWindowsCompiler.ts';
import { ConnectorWindowsSources } from './ConnectorWindowsSources.ts';

/** Measures the actual C#5 parser after validating normal, escaped, large and malformed requests. */
class WindowsStateBenchmark {
    /** Compiles into one task-owned directory and removes every intermediate on success or failure. */
    public static async run(): Promise<void> {
        await mkdir(resolve('build'), { recursive: true });
        const directory: string = await mkdtemp(resolve('build/.state-benchmark-'));
        try {
            const executable: string = join(directory, 'state-benchmark.exe');
            await ConnectorWindowsCompiler.compile({
                sources: [
                    ...ConnectorWindowsSources.state,
                    resolve('test/support/WindowsStateProtocolFixture.cs'),
                ],
                entrypoint: 'WindowsStateProtocolFixture',
                destination: executable,
            });
            const command: string = process.platform === 'win32' ? executable : 'mono';
            const arguments_: readonly string[] =
                process.platform === 'win32' ? ['--benchmark'] : [executable, '--benchmark'];
            const output: Awaited<ReturnType<typeof execFile.__promisify__>> = await promisify(
                execFile,
            )(command, [...arguments_], { timeout: 120000, maxBuffer: 16384 });
            process.stdout.write(output.stdout);
            process.stderr.write(output.stderr);
        } finally {
            await rm(directory, { recursive: true, force: true });
        }
    }
}

await WindowsStateBenchmark.run();
