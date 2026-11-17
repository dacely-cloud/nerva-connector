// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';
import { HostProcessWindowsProtocol } from '../src/host/HostProcessWindowsProtocol.js';

it.skipIf(process.platform !== 'linux' || !existsSync('/usr/bin/mcs'))(
    'actual C# creation failures preserve exact bounded Win32 codes across the private TypeScript decoder',
    async (): Promise<void> => {
        const directory: string = await mkdtemp(join(homedir(), '.nerva-host-process-native-'));
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
                    '-r:System.Web.Extensions',
                    '-main:WindowsHostProcessFixture',
                    '-out:' + executable,
                    resolve('native/windows/HostJob.cs'),
                    resolve('native/windows/HostProcess.cs'),
                    resolve('test/support/WindowsHostProcessFixture.cs'),
                ],
                options,
            );
            const output: Awaited<ReturnType<typeof execFile.__promisify__>> = await promisify(
                execFile,
            )('/usr/bin/mono', [executable], options);
            const lines: readonly string[] = output.stdout.toString().trim().split(/\r?\n/u);
            expect(lines).toHaveLength(22);
            for (const line of lines) {
                const raw: unknown = JSON.parse(line);
                expect(
                    HostProcessWindowsProtocol.decode(raw, '00000000-0000-0000-0000-000000000000'),
                ).toMatchObject({ kind: 'launch-rejected' });
            }
            expect(output.stderr.toString()).toBe('');
        } finally {
            await rm(directory, { recursive: true, force: true });
        }
    },
);
