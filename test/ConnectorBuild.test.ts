// SPDX-FileCopyrightText: 2026 Dacely <business@dacely.com>
// SPDX-License-Identifier: LicenseRef-Proprietary

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, chmod, readFile, readdir, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { expect, it } from 'vitest';
import { ProtectedFiles } from '../src/local/ProtectedFiles.js';

it('build output works under temporary and shared development directories without relaxing private credential rules', async (): Promise<void> => {
    const directory: string = await mkdtemp(join(tmpdir(), 'nerva-connector-build-'));
    try {
        await chmod(directory, 0o770);
        const destination: string = join(directory, 'connector.mjs');
        const result: Awaited<ReturnType<typeof execFile.__promisify__>> = await promisify(
            execFile,
        )(process.execPath, ['script/build-connector.ts', '--output', destination], {
            env: { ...process.env, NODE_OPTIONS: '' },
            timeout: 15000,
            maxBuffer: 8192,
        });
        expect(result.stderr.toString()).toBe('');
        expect(
            (await readFile(destination)).equals(
                await readFile(resolve('build/nerva-connector.mjs')),
            ),
        ).toBe(true);
        expect((await readdir(directory)).toSorted()).toEqual([
            'THIRD-PARTY-NOTICES.txt',
            'connector.mjs',
            'nerva-connector-host-worker.mjs',
        ]);
        const help: Awaited<ReturnType<typeof execFile.__promisify__>> = await promisify(execFile)(
            process.execPath,
            [destination, '--help'],
            {
                cwd: directory,
                env: { PATH: process.env['PATH'], NODE_OPTIONS: '' },
                timeout: 5000,
                maxBuffer: 8192,
            },
        );
        expect(help.stdout.toString()).toContain('Nerva Connector');
        await expect(ProtectedFiles.readTrusted(destination, 1048576, false)).rejects.toThrow(
            'Private connector file ancestry is untrusted',
        );
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});
