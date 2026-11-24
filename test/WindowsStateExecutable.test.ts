// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

import { ConnectorWindowsSources } from '../script/ConnectorWindowsSources.ts';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, rm, symlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { expect, it } from 'vitest';
import { WindowsStateExecutable } from '../src/windows/WindowsStateExecutable.js';
import { WindowsStateBuild } from '../src/windows/WindowsStateBuild.js';
import { WindowsStateFailure } from '../src/windows/WindowsStateProtocol.js';
import type { WindowsStateArtifact } from '../src/windows/WindowsStateArtifact.js';
import { ConnectorWindowsBuild } from '../script/ConnectorWindowsBuild.ts';
import { ConnectorWindowsCompiler } from '../script/ConnectorWindowsCompiler.ts';
import { ConnectorReleaseLimits } from '../src/install/ConnectorReleaseLimits.js';

it('state bootstrap uses a compiled helper without runtime compilation or embedded helper source', async (): Promise<void> => {
    const artifact: Buffer = await readFile('build/nerva-connector.mjs');
    expect(artifact.byteLength).toBeLessThanOrEqual(ConnectorReleaseLimits.applicationBytes);
    for (const forbidden of ['Add-Type', 'GZipStream', 'NexaConnectorStateOwner']) {
        expect(artifact.toString('utf8').includes(forbidden)).toBe(false);
    }
    expect(artifact.toString('utf8')).not.toContain('../../native/windows/StateOwner.cs');
    for (const module of [
        'src/windows/WindowsStateOwner.ts',
        'src/windows/WindowsStateExecutable.ts',
        'src/system/WindowsGpuInventory.ts',
    ]) {
        const source: string = await readFile(module, 'utf8');
        expect(source.includes('powershell.exe')).toBe(false);
        expect(source.includes('-EncodedCommand')).toBe(false);
    }
});

it.skipIf(process.platform !== 'win32')(
    'qualifies protected storage and legacy identity detection beneath shared Windows folders',
    async (): Promise<void> => {
        const directory: string = await mkdtemp(join(homedir(), '.nerva-windows-storage-'));
        try {
            const executable: string = join(directory, 'storage.exe');
            await ConnectorWindowsCompiler.compile({
                sources: [
                    ...ConnectorWindowsSources.state,
                    resolve('test/support/WindowsStateProfileFixture.cs'),
                ],
                entrypoint: 'WindowsStateProfileFixture',
                destination: executable,
            });
            const output: Awaited<ReturnType<typeof execFile.__promisify__>> = await promisify(
                execFile,
            )(executable, [], { timeout: 30000, maxBuffer: 16384, windowsHide: true });
            expect(output.stdout.toString().trim()).toBe('windows-state-profile-qualified');
            const target: string = join(directory, 'junction-target');
            const junction: string = join(directory, '.local');
            await mkdir(target);
            await symlink(target, junction, 'junction');
            try {
                const rejected: Awaited<ReturnType<typeof execFile.__promisify__>> =
                    await promisify(execFile)(executable, [directory], {
                        timeout: 30000,
                        maxBuffer: 16384,
                        windowsHide: true,
                    });
                expect(rejected.stdout.toString().trim()).toBe('windows-state-junction-rejected');
            } finally {
                await rm(junction);
            }
        } finally {
            await rm(directory, { recursive: true, force: true });
        }
    },
    60000,
);

it.skipIf(process.platform !== 'linux' || !existsSync('/usr/bin/mcs')).each([
    ['WindowsStatePolicyFixture', /windows-state-policy-checks=\d+/u],
    ['WindowsStateProtocolFixture', /windows-state-protocol-checks=\d+/u],
] as const)(
    'actual C#5 %s rejects unsafe input without invoking Windows APIs',
    async (entrypoint: string, expected: RegExp): Promise<void> => {
        const directory: string = await mkdtemp(join(homedir(), '.nerva-windows-policy-'));
        try {
            const executable: string = join(directory, 'policy.exe');
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
                    '-main:' + entrypoint,
                    '-r:System.Security',
                    '-r:System.Web.Extensions',
                    '-out:' + executable,
                    ...ConnectorWindowsSources.state,
                    resolve('test/support', entrypoint + '.cs'),
                ],
                options,
            );
            const output: Awaited<ReturnType<typeof execFile.__promisify__>> = await promisify(
                execFile,
            )('/usr/bin/mono', [executable], options);
            expect(output.stdout.toString()).toMatch(expected);
            expect(output.stderr.toString()).toBe('');
        } finally {
            await rm(directory, { recursive: true, force: true });
        }
    },
);

it.skipIf(process.platform !== 'win32' && !existsSync('/usr/bin/mcs'))(
    'build-time compilation creates a pinned ordinary Windows executable and reuses it without stale output',
    async (): Promise<void> => {
        const directory: string = await mkdtemp(join(homedir(), '.nerva-windows-build-'));
        try {
            const artifact: WindowsStateArtifact = await ConnectorWindowsBuild.build(directory);
            const executable: string = join(directory, 'nerva-connector-state.exe');
            const bytes: Buffer = await readFile(executable);
            expect(bytes.subarray(0, 2).toString()).toBe('MZ');
            const pe: number = bytes.readUInt32LE(0x3c);
            expect(bytes.subarray(pe, pe + 4)).toEqual(Buffer.from([0x50, 0x45, 0, 0]));
            expect(createHash('sha256').update(bytes).digest('hex')).toBe(artifact.sha256);
            expect(artifact.bytes).toBe(bytes.byteLength);
            expect(
                await WindowsStateBuild.read(join(directory, 'nerva-connector-state.json')),
            ).toEqual(artifact);
            await WindowsStateExecutable.verify(executable, artifact);
            expect(await ConnectorWindowsBuild.build(directory)).toEqual(artifact);
            const entry: string = join(directory, 'nerva-connector.mjs');
            await promisify(execFile)(
                process.execPath,
                [resolve('script/build-connector.ts'), '--windows', '--output', entry],
                {
                    timeout: 30000,
                    maxBuffer: 16384,
                    env: { ...process.env, NODE_OPTIONS: '' },
                },
            );
            const bundled: string = await readFile(entry, 'utf8');
            const packaged: WindowsStateArtifact | null = await WindowsStateBuild.read(
                join(directory, 'nerva-connector-state.json'),
            );
            if (packaged === null) {
                throw new Error('Published Windows helper metadata required');
            }
            expect(bundled).toContain(packaged.sha256);
            await WindowsStateExecutable.verify(executable, packaged);
            expect(bundled).toContain('./nerva-connector-state.exe');
            expect(bundled).not.toContain('Add-Type');
            const host: WindowsStateArtifact | null = await WindowsStateBuild.read(
                join(directory, 'nerva-connector-host.json'),
            );
            if (host === null) {
                throw new Error('Published host broker metadata required');
            }
            expect(bundled.includes(host.sha256)).toBe(true);
            await WindowsStateExecutable.verify(join(directory, 'nerva-connector-host.exe'), host);
            await expect(
                WindowsStateExecutable.verify(executable, { ...artifact, sha256: '0'.repeat(64) }),
            ).rejects.toMatchObject({ failure: WindowsStateFailure.HelperUntrusted });
            await expect(
                WindowsStateExecutable.verify(join(directory, 'missing.exe'), artifact),
            ).rejects.toMatchObject({ failure: WindowsStateFailure.HelperMissing });
        } finally {
            await rm(directory, { recursive: true, force: true });
        }
    },
);
