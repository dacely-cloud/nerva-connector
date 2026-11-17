// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

import { ConnectorWindowsSources } from '../script/ConnectorWindowsSources.ts';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, it } from 'vitest';

it.skipIf(process.platform !== 'linux' || !existsSync('/usr/bin/mcs'))(
    'the actual C#5 native bootstrap validates fixed pins, bounds, full streams and cancellation without invoking Windows APIs',
    async (): Promise<void> => {
        const directory: string = await mkdtemp(
            join(homedir(), '.nerva-windows-bootstrap-native-'),
        );
        try {
            const executable: string = join(directory, 'bootstrap-fixture.exe');
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
                    '-main:WindowsBootstrapNativeFixture',
                    '-r:System.Security',
                    '-r:System.Web.Extensions',
                    '-out:' + executable,
                    ...ConnectorWindowsSources.bootstrap,
                    resolve('test/support/WindowsBootstrapNativeFixture.cs'),
                ],
                options,
            );
            const output: Awaited<ReturnType<typeof execFile.__promisify__>> = await promisify(
                execFile,
            )('/usr/bin/mono', [executable], options);
            expect(output.stdout.toString()).toMatch(/windows-bootstrap-native-checks=\d+/u);
            expect(output.stderr.toString()).toBe('');
        } finally {
            await rm(directory, { recursive: true, force: true });
        }
    },
);
