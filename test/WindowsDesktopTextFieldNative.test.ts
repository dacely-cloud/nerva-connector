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
    'native app-field replacement is unique, bounded, private, and uncertain only after the one setter call',
    async (): Promise<void> => {
        const directory: string = await mkdtemp(resolve('build/desktop-field-test-'));
        try {
            const executable: string = join(directory, 'field-fixture.exe');
            await ConnectorWindowsCompiler.compile({
                sources: [
                    'native/windows/HostDesktopWindow.cs',
                    'native/windows/HostDesktopKeyboard.cs',
                    'native/windows/HostDesktopTextField.cs',
                    'native/windows/HostDesktopTextFieldAutomation.cs',
                    'native/windows/HostDesktopTextFieldEdit.cs',
                    'test/support/WindowsDesktopTextFieldFixture.cs',
                ].map((path: string): string => resolve(path)),
                entrypoint: 'WindowsDesktopTextFieldFixture',
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
                'backgroundWrites',
                'ambiguousWrites',
            ]);
            expect(value['checks']).toBeGreaterThanOrEqual(50);
            expect(value['backgroundWrites']).toBe(1);
            expect(value['ambiguousWrites']).toBe(0);
            expect(output.stderr.toString()).toBe('');
        } finally {
            await rm(directory, { recursive: true, force: true });
        }
    },
);
