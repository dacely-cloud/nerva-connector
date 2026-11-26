// SPDX-FileCopyrightText: 2026 Dacely <business@dacely.com>
// SPDX-License-Identifier: LicenseRef-Proprietary

import { ConnectorWindowsSources } from '../script/ConnectorWindowsSources.ts';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';
import { ConnectorWindowsQualificationBuild } from '../script/ConnectorWindowsQualificationBuild.ts';
import type { WindowsQualificationArtifacts } from '../script/ConnectorWindowsQualificationBuild.ts';
import { ConnectorWindowsNativeBuild } from '../script/ConnectorWindowsNativeBuild.ts';
import type { WindowsStateArtifact } from '../src/windows/WindowsStateArtifact.js';

const available: boolean = process.platform === 'win32' || existsSync('/usr/bin/mcs');
const directory: string = resolve('build');

it.skipIf(!available)(
    'cross-compiles separate pinned broker and worker without changing the standalone connector or retaining compiler intermediates',
    async (): Promise<void> => {
        const entry: string = resolve(directory, 'nerva-connector.mjs');
        const before: Buffer = await readFile(entry);
        const artifacts: WindowsQualificationArtifacts =
            await ConnectorWindowsQualificationBuild.build(directory);
        for (const [name, artifact] of [
            ['nerva-connector-file-worker', artifacts.worker],
            ['nerva-connector-files-qualification', artifacts.broker],
        ] satisfies readonly (readonly [string, WindowsStateArtifact])[]) {
            const bytes: Buffer = await readFile(resolve(directory, name + '.exe'));
            expect(bytes.byteLength).toBe(artifact.bytes);
            expect(bytes.byteLength).toBeLessThanOrEqual(262144);
            expect(bytes.subarray(0, 2).toString('ascii')).toBe('MZ');
            const pe: number = bytes.readUInt32LE(0x3c);
            expect(bytes.subarray(pe, pe + 4)).toEqual(Buffer.from([80, 69, 0, 0]));
            expect(createHash('sha256').update(bytes).digest('hex')).toBe(artifact.sha256);
        }
        const worker: Buffer = await readFile(
            resolve(directory, 'nerva-connector-file-worker.exe'),
        );
        const broker: Buffer = await readFile(
            resolve(directory, 'nerva-connector-files-qualification.exe'),
        );
        expect(worker.includes(Buffer.from('NexaConnectorStateOwner'))).toBe(false);
        expect(worker.includes(Buffer.from('ProtectedData'))).toBe(false);
        expect(broker.includes(Buffer.from(artifacts.worker.sha256, 'utf16le'))).toBe(true);
        expect(worker.includes(Buffer.from('powershell', 'utf16le'))).toBe(false);
        expect(broker.includes(Buffer.from('powershell', 'utf16le'))).toBe(false);
        const modified: number = (await stat(resolve(directory, 'nerva-connector-file-worker.exe')))
            .mtimeMs;
        expect(await ConnectorWindowsQualificationBuild.build(directory)).toEqual(artifacts);
        expect((await stat(resolve(directory, 'nerva-connector-file-worker.exe'))).mtimeMs).toBe(
            modified,
        );
        expect(await readFile(entry)).toEqual(before);
        expect(
            (await readdir(directory)).filter(
                (name: string): boolean =>
                    name.includes('.partial-') &&
                    (name.startsWith('nerva-connector-file-worker.') ||
                        name.startsWith('nerva-connector-files-qualification.')),
            ),
        ).toEqual([]);
    },
);

it.skipIf(process.platform !== 'linux' || !existsSync('/usr/bin/mcs'))(
    'actual C#5 ABI, argv escaping, profile names and handle bounds pass without pretending Linux can qualify Windows confinement',
    async (): Promise<void> => {
        try {
            const artifact: WindowsStateArtifact = await ConnectorWindowsNativeBuild.build({
                directory,
                stem: 'nerva-connector-sandbox-policy-test',
                entrypoint: 'WindowsSandboxPolicyFixture',
                sources: [
                    resolve('native/windows/sandbox/SandboxNative.cs'),
                    resolve('native/windows/sandbox/SandboxPolicy.cs'),
                    resolve('native/windows/sandbox/SandboxImageIdentity.cs'),
                    ...ConnectorWindowsSources.state,
                    resolve('test/support/WindowsSandboxPolicyFixture.cs'),
                ],
            });
            expect(artifact.bytes).toBeLessThanOrEqual(262144);
            const policy: Awaited<ReturnType<typeof execFile.__promisify__>> = await promisify(
                execFile,
            )('/usr/bin/mono', [resolve(directory, 'nerva-connector-sandbox-policy-test.exe')], {
                timeout: 10000,
                maxBuffer: 4096,
            });
            expect(policy.stdout.toString()).toMatch(/^windows-sandbox-policy-checks=65\n$/u);
            expect(policy.stderr.toString()).toBe('');
            await ConnectorWindowsQualificationBuild.build(directory);
            try {
                await promisify(execFile)(
                    '/usr/bin/mono',
                    [resolve(directory, 'nerva-connector-files-qualification.exe'), '--qualify'],
                    { timeout: 10000, maxBuffer: 4096 },
                );
                throw new Error('Linux must never produce a Windows confinement success receipt');
            } catch (caught: unknown) {
                if (!(caught instanceof Error) || !('code' in caught) || !('stdout' in caught)) {
                    throw caught;
                }
                expect(caught.code).toBe(2);
                expect(caught.stdout).toBe('{"qualified":false,"phase":"windows-required"}\n');
            }
        } finally {
            await rm(resolve(directory, 'nerva-connector-sandbox-policy-test.exe'), {
                force: true,
            });
            await rm(resolve(directory, 'nerva-connector-sandbox-policy-test.json'), {
                force: true,
            });
        }
    },
);

it.skipIf(!available)(
    'a real compiler failure preserves the previous executable and metadata and removes both generated source and partial binary',
    async (): Promise<void> => {
        const stem: string = 'nerva-connector-sandbox-rejected-test-' + process.pid.toString();
        const source: string = resolve(directory, stem + '.cs');
        const executable: string = resolve(directory, stem + '.exe');
        const manifest: string = resolve(directory, stem + '.json');
        try {
            await writeFile(source, 'internal class Canary { static int Main() { return 0; } }', {
                flag: 'wx',
                mode: 0o600,
            });
            const input: Parameters<typeof ConnectorWindowsNativeBuild.build>[0] = {
                directory,
                stem,
                entrypoint: 'Canary',
                sources: [source],
                generatedSource: 'internal class BuildPin { internal const int Value = 1; }',
            };
            await ConnectorWindowsNativeBuild.build(input);
            const bytes: Buffer = await readFile(executable);
            const metadata: Buffer = await readFile(manifest);
            await writeFile(source, 'not a C sharp program');
            await expect(ConnectorWindowsNativeBuild.build(input)).rejects.toThrow();
            expect(await readFile(executable)).toEqual(bytes);
            expect(await readFile(manifest)).toEqual(metadata);
            expect(
                (await readdir(directory)).filter(
                    (name: string): boolean => name.startsWith(stem) && name.includes('.partial-'),
                ),
            ).toEqual([]);
        } finally {
            await Promise.all([
                rm(source, { force: true }),
                rm(executable, { force: true }),
                rm(manifest, { force: true }),
            ]);
        }
    },
);

it.skipIf(process.platform !== 'win32')(
    'on actual Windows, independently verified LPAC workers prove handle authority, ambient/network/child denial and job-close termination',
    async (): Promise<void> => {
        const artifacts: WindowsQualificationArtifacts =
            await ConnectorWindowsQualificationBuild.build(directory);
        const output: Awaited<ReturnType<typeof execFile.__promisify__>> = await promisify(
            execFile,
        )(resolve(directory, 'nerva-connector-files-qualification.exe'), ['--qualify'], {
            timeout: 25000,
            maxBuffer: 4096,
            windowsHide: true,
        });
        const receipt: unknown = JSON.parse(output.stdout.toString());
        expect(receipt).toEqual({
            qualified: true,
            scope: 'lpac-canaries-only',
            workerSha256: artifacts.worker.sha256,
            readHandle: true,
            writeDenied: true,
            excludedHandleDenied: true,
            ambientDenied: true,
            loopbackDenied: true,
            childDenied: true,
            killOnClose: true,
        });
        expect(output.stderr.toString()).toBe('');
    },
);
