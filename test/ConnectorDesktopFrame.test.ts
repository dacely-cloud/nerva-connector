// SPDX-FileCopyrightText: 2026 Dacely <business@dacely.com>
// SPDX-License-Identifier: LicenseRef-Proprietary

import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';
import { Boundary } from 'nerva-connector-protocol/protocol/Boundary.js';
import { ConnectorWindowsCompiler } from '../script/ConnectorWindowsCompiler.ts';
import { ConnectorWindowsSources } from '../script/ConnectorWindowsSources.ts';
import { HostApplication, type HostDesktopFrame } from '../src/host/HostApplication.js';

it.skipIf(
    process.platform !== 'win32' && !(process.platform === 'linux' && existsSync('/usr/bin/mcs')),
)(
    'keeps 4K desktop text at native resolution, bounds dense images and matches the Win32 INPUT ABI',
    async (): Promise<void> => {
        const directory: string = await mkdtemp(join(homedir(), 'nerva-frame-test-'));
        try {
            const executable: string = join(directory, 'frame.exe');
            await ConnectorWindowsCompiler.compile({
                sources: [
                    ...ConnectorWindowsSources.desktop,
                    resolve('test/support/WindowsDesktopFrameFixture.cs'),
                ],
                entrypoint: 'NexaConnectorDesktopFrameFixture',
                destination: executable,
            });
            const result: Awaited<ReturnType<typeof execFile.__promisify__>> = await promisify(
                execFile,
            )(
                process.platform === 'win32' ? executable : '/usr/bin/mono',
                process.platform === 'win32' ? [] : [executable],
                { timeout: 30000, maxBuffer: 2097152 },
            );
            const raw: unknown = JSON.parse(result.stdout.toString());
            const value: Readonly<Record<string, unknown>> = Boundary.record(raw, [
                'text',
                'dense',
                'inputBytes',
                'unionOffset',
                'pointerBytes',
            ]);
            const text: HostDesktopFrame = HostApplication.frame(value['text']);
            expect(text).toMatchObject({
                width: 3840,
                height: 2160,
                sourceX: -1920,
                sourceWidth: 3840,
                sourceHeight: 2160,
            });
            const dense: HostDesktopFrame = HostApplication.frame(value['dense']);
            expect(dense.width).toBeLessThan(1920);
            expect(dense.width).toBeGreaterThanOrEqual(640);
            for (const frame of [text, dense]) {
                expect(Buffer.from(frame.data, 'base64').byteLength).toBeLessThanOrEqual(640000);
            }
            expect(value['inputBytes']).toBe(value['pointerBytes'] === 8 ? 40 : 28);
            expect(value['unionOffset']).toBe(value['pointerBytes'] === 8 ? 8 : 4);
        } finally {
            await rm(directory, { recursive: true, force: true });
        }
    },
);
