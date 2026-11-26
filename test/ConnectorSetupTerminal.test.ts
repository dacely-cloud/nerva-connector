// SPDX-FileCopyrightText: 2026 Dacely <business@dacely.com>
// SPDX-License-Identifier: LicenseRef-Proprietary

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, it } from 'vitest';

/** A terminal probe prints only its fixed success marker; all reviewed state stays inside its owned home. */
interface SetupTerminalOutput {
    readonly stdout: string;
    readonly stderr: string;
}

it.skipIf(process.platform !== 'linux')(
    'the built setup TUI renders colors, edits and goes back, validates, selects with arrows, resizes and restores terminal state without granting or writing on cancellation',
    async (): Promise<void> => {
        const directory: string = await mkdtemp(join(homedir(), '.nerva-setup-terminal-'));
        try {
            const result: SetupTerminalOutput = await promisify(execFile)(
                '/usr/bin/python3',
                [
                    '-I',
                    '-B',
                    resolve('test/support/ConnectorSetupTerminalProbe.py'),
                    process.execPath,
                    resolve('build/nerva-connector.mjs'),
                    directory,
                ],
                {
                    env: { PATH: process.env['PATH'] },
                    timeout: 65000,
                    maxBuffer: 32768,
                    encoding: 'utf8',
                },
            );
            expect(result.stdout).toContain('real-terminal-setup-tui-verified');
        } finally {
            await rm(directory, { recursive: true, force: true });
        }
    },
    70000,
);
