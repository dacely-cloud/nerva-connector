// SPDX-FileCopyrightText: 2026 Dacely <business@dacely.com>
// SPDX-License-Identifier: LicenseRef-Proprietary

import { execFile, type ChildProcess } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { expect, it } from 'vitest';
import { HostDesktopWaylandPortal } from '../src/host/HostDesktopWaylandPortal.js';

/** Each scenario targets one metadata-only connection lifecycle boundary. */
const ConnectionScenario = {
    Retry: 'retry',
    Replacement: 'replacement',
    Bounce: 'bounce',
} as const;
type ConnectionScenario = (typeof ConnectionScenario)[keyof typeof ConnectionScenario];

/** Only a new isolated session bus is contacted; the fixture exports discovery metadata, never a desktop portal. */
async function connection(mode: ConnectionScenario): Promise<string> {
    const fixture: string = await readFile(
        new URL('./support/HostDesktopWaylandConnectionFixture.py', import.meta.url),
        'utf8',
    );
    return new Promise<string>(
        (resolve: (value: string) => void, reject: (error: Error) => void): void => {
            const child: ChildProcess = execFile(
                'dbus-run-session',
                ['--', 'python3', '-I', '-B', '-c', fixture],
                { timeout: 15000, maxBuffer: 16384 },
                (error: Error | null, stdout: string, stderr: string): void => {
                    if (error !== null) {
                        reject(new Error(stderr, { cause: error }));
                    } else {
                        resolve(stdout);
                    }
                },
            );
            child.stdin?.on('error', reject);
            child.stdin?.end(JSON.stringify({ source: HostDesktopWaylandPortal.source, mode }));
        },
    );
}

it.skipIf(process.platform !== 'linux')(
    'a transient portal discovery failure closes its staged bus and retries coherent metadata without consent',
    async (): Promise<void> => {
        const raw: unknown = JSON.parse(await connection(ConnectionScenario.Retry));
        expect(raw).toEqual({ ok: true, mode: 'retry', noConsent: true });
    },
    20000,
);

it.skipIf(process.platform !== 'linux')(
    'portal replacement during discovery cannot publish the obsolete still-connected unique owner',
    async (): Promise<void> => {
        const raw: unknown = JSON.parse(await connection(ConnectionScenario.Replacement));
        expect(raw).toEqual({ ok: true, mode: 'replacement', noConsent: true });
    },
    20000,
);

it.skipIf(process.platform !== 'linux')(
    'a portal owner that loses and regains its name during discovery still invalidates that setup generation',
    async (): Promise<void> => {
        const raw: unknown = JSON.parse(await connection(ConnectionScenario.Bounce));
        expect(raw).toEqual({ ok: true, mode: 'bounce', noConsent: true });
    },
    20000,
);
