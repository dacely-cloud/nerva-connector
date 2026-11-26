// SPDX-FileCopyrightText: 2026 Dacely <business@dacely.com>
// SPDX-License-Identifier: LicenseRef-Proprietary

import { ConnectorWindowsSources } from '../script/ConnectorWindowsSources.ts';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';

it.skipIf(process.platform !== 'linux' || !existsSync('/usr/bin/mcs'))(
    'the C#5 bootstrap launcher preserves argument quoting and bounds its sanitized child environment without Windows APIs',
    async (): Promise<void> => {
        const directory: string = await mkdtemp(join(homedir(), '.nerva-bootstrap-process-'));
        try {
            const executable: string = join(directory, 'process-policy.exe');
            const options: Parameters<typeof execFile.__promisify__>[2] = {
                timeout: 30000,
                maxBuffer: 16384,
                env: { PATH: process.env['PATH'] },
            };
            await promisify(execFile)(
                '/usr/bin/mcs',
                [
                    '-target:exe',
                    '-langversion:5',
                    '-warnaserror',
                    '-main:WindowsBootstrapProcessFixture',
                    '-out:' + executable,
                    ...ConnectorWindowsSources.bootstrapProcess,
                    resolve('test/support/WindowsBootstrapProcessFixture.cs'),
                ],
                options,
            );
            const output: Awaited<ReturnType<typeof execFile.__promisify__>> = await promisify(
                execFile,
            )('/usr/bin/mono', [executable], options);
            expect(output.stdout.toString()).toMatch(/^windows-bootstrap-process-checks=22\r?\n$/u);
            expect(output.stderr.toString()).toBe('');
        } finally {
            await rm(directory, { recursive: true, force: true });
        }
    },
);
