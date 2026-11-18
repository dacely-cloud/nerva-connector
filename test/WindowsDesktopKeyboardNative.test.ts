// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';
import { Boundary } from 'nerva-connector-protocol/protocol/Boundary.js';
import { ConnectorWindowsCompiler } from '../script/ConnectorWindowsCompiler.ts';

it.skipIf(
    process.platform !== 'win32' && !(process.platform === 'linux' && existsSync('/usr/bin/mcs')),
)(
    'actual native key plans fail closed on target denial and release only injected prefixes without desktop access',
    async (): Promise<void> => {
        const directory: string = await mkdtemp(resolve('build/desktop-keyboard-test-'));
        try {
            const executable: string = join(directory, 'keyboard-fixture.exe');
            await ConnectorWindowsCompiler.compile({
                sources: [
                    'native/windows/HostDesktopWindow.cs',
                    'native/windows/HostDesktopKeyboard.cs',
                    'test/support/WindowsDesktopKeyboardFixture.cs',
                ].map((path: string): string => resolve(path)),
                entrypoint: 'WindowsDesktopKeyboardFixture',
                destination: executable,
            });
            const output: Awaited<ReturnType<typeof execFile.__promisify__>> = await promisify(
                execFile,
            )(
                process.platform === 'win32' ? executable : '/usr/bin/mono',
                process.platform === 'win32' ? [] : [executable],
                { timeout: 15000, maxBuffer: 8192 },
            );
            const raw: unknown = JSON.parse(output.stdout.toString());
            const value: Readonly<Record<string, unknown>> = Boundary.record(raw, [
                'checks',
                'chordBatches',
                'unicodeBatches',
                'deniedBatches',
            ]);
            expect(value['checks']).toBeGreaterThanOrEqual(60);
            expect(value['chordBatches']).toBe(1);
            expect(value['unicodeBatches']).toBe(1);
            expect(value['deniedBatches']).toBe(0);
            expect(output.stderr.toString()).toBe('');
        } finally {
            await rm(directory, { recursive: true, force: true });
        }
    },
);
