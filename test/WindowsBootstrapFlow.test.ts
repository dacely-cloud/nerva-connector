// SPDX-FileCopyrightText: 2026 Dacely <business@dacely.com>
// SPDX-License-Identifier: LicenseRef-Proprietary

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { readFile, writeFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve, isAbsolute } from 'node:path';
import { createHash } from 'node:crypto';
import { expect, it } from 'vitest';
import { ProtectedFiles } from '../src/local/ProtectedFiles.js';
import {
    ConnectorAuthorityPin,
    type ConnectorTrustedAuthority,
} from '../src/runtime/ConnectorAuthorityPin.js';
import { ConnectorReleaseCodec } from '../src/install/ConnectorReleaseCodec.js';
import {
    ConnectorReleasePlatform,
    type ConnectorSignedRelease,
} from '../src/install/ConnectorRelease.js';
import {
    ConnectorWindowsBootstrap,
    type ConnectorWindowsBootstrapConfiguration,
} from '../src/install/ConnectorWindowsBootstrap.js';
import { ConnectorInstallation } from '../src/install/ConnectorInstallation.js';
import { WindowsStateOwner } from '../src/windows/WindowsStateOwner.js';
import {
    WindowsStateOperation,
    type WindowsStateResponse,
} from '../src/windows/WindowsStateProtocol.js';
import { WindowsStateBuild } from '../src/windows/WindowsStateBuild.js';
import type { WindowsStateArtifact } from '../src/windows/WindowsStateArtifact.js';
import { WindowsStateExecutable } from '../src/windows/WindowsStateExecutable.js';

/** Real Windows qualification deliberately uses an administrator-prepared, signed complete release. */
interface BootstrapFlowResult {
    readonly code: number | null;
    readonly stdout: string;
    readonly stderr: string;
    readonly uncertain: boolean;
}

/** The native process owns child cancellation; a timeout requests graceful cancellation before reporting uncertain recovery. */
async function bootstrap(
    executable: string,
    configuration: ConnectorWindowsBootstrapConfiguration,
): Promise<BootstrapFlowResult> {
    const child: ChildProcessWithoutNullStreams = spawn(executable, [], {
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        env: { ...process.env, NODE_OPTIONS: '', NODE_PATH: '', NODE_EXTRA_CA_CERTS: '' },
    });
    let stdout: string = '';
    let stderr: string = '';
    let force: NodeJS.Timeout | undefined;
    let failure: Error | null = null;
    let closed: boolean = false;
    let forced: boolean = false;
    const cancel: () => void = (): void => {
        if (closed || force !== undefined) {
            return;
        }
        if (!child.stdin.destroyed) {
            child.stdin.write('cancel\n');
        }
        force = setTimeout((): void => {
            forced = true;
            child.kill();
        }, 15000);
    };
    const timer: NodeJS.Timeout = setTimeout(cancel, 180000);
    try {
        return await new Promise<BootstrapFlowResult>(
            (
                complete: (value: BootstrapFlowResult) => void,
                fail: (error: Error) => void,
            ): void => {
                child.once('error', (error: Error): void => {
                    failure = error;
                    cancel();
                });
                child.stdin.on('error', (error: Error): void => {
                    failure ??= error;
                    cancel();
                });
                child.stdout.on('data', (bytes: Buffer): void => {
                    if (Buffer.byteLength(stdout) + bytes.length > 65536) {
                        failure ??= new Error('Bootstrap qualification output exceeded its bound');
                        cancel();
                        return;
                    }
                    stdout += bytes.toString('utf8');
                });
                child.stderr.on('data', (bytes: Buffer): void => {
                    if (Buffer.byteLength(stderr) + bytes.length > 65536) {
                        failure ??= new Error(
                            'Bootstrap qualification diagnostics exceeded their bound',
                        );
                        cancel();
                        return;
                    }
                    stderr += bytes.toString('utf8');
                });
                child.once('close', (code: number | null): void => {
                    closed = true;
                    if (failure !== null) {
                        fail(failure);
                        return;
                    }
                    complete({
                        code,
                        stdout,
                        stderr,
                        uncertain:
                            forced || stderr.includes('could not confirm installer shutdown'),
                    });
                });
                child.stdin.write(JSON.stringify({ ...configuration, control: 'stdin-v1' }) + '\n');
            },
        );
    } finally {
        clearTimeout(timer);
        clearTimeout(force);
        child.stdin.destroy();
    }
}

it.skipIf(process.platform !== 'win32' || process.env['NERVA_WINDOWS_BOOTSTRAP_SMOKE'] !== '1')(
    'actual Windows bootstrap performs an offline first install, exact repeat, noninteractive status and tamper refusal while preserving the device key',
    async (): Promise<void> => {
        const source: string | undefined = process.env['NERVA_WINDOWS_BOOTSTRAP_RELEASE_DIRECTORY'];
        const publicFile: string | undefined =
            process.env['NERVA_WINDOWS_BOOTSTRAP_RELEASE_PUBLIC_KEY_FILE'];
        if (
            source === undefined ||
            publicFile === undefined ||
            !isAbsolute(source) ||
            !isAbsolute(publicFile)
        ) {
            throw new Error(
                'Windows bootstrap qualification requires absolute prepared release directory and public-key file inputs',
            );
        }
        const authority: ConnectorTrustedAuthority = await ConnectorAuthorityPin.load(
            'connector-release',
            publicFile,
        );
        const release: ConnectorSignedRelease = ConnectorReleaseCodec.read(
            JSON.parse(
                (
                    await ProtectedFiles.readTrusted(join(source, 'release.json'), 131072, false)
                ).toString('utf8'),
            ),
            authority.publicKey,
            BigInt(Date.now()),
        );
        expect(release.manifest.platform).toBe(ConnectorReleasePlatform.Windows);
        const artifact: WindowsStateArtifact | null = await WindowsStateBuild.read(
            new URL('../build/nerva-connector-bootstrap.json', import.meta.url),
        );
        if (artifact === null) {
            throw new Error('Build the current Windows bootstrap before qualification');
        }
        const executable: string = resolve('build/nerva-connector-bootstrap.exe');
        await WindowsStateExecutable.verify(executable, artifact);
        const root: WindowsStateResponse = await WindowsStateOwner.request(
            WindowsStateOperation.Root,
        );
        if (root.path === null) {
            throw new Error('Verified Windows connector root required');
        }
        const destination: string = join(
            root.path,
            'qualification-bootstrap-' + crypto.randomUUID(),
        );
        const configuration: ConnectorWindowsBootstrapConfiguration =
            ConnectorWindowsBootstrap.configuration(
                release,
                authority.publicKey,
                'https://qualification.invalid/releases/',
            );
        let completed: boolean = false;
        let cleanupSafe: boolean = false;
        const invoke: (
            value: ConnectorWindowsBootstrapConfiguration,
        ) => Promise<BootstrapFlowResult> = async (
            value: ConnectorWindowsBootstrapConfiguration,
        ): Promise<BootstrapFlowResult> => {
            cleanupSafe = false;
            const result: BootstrapFlowResult = await bootstrap(executable, value);
            if (result.uncertain) {
                throw new Error(
                    'Windows bootstrap quiescence was not confirmed; qualification destination was preserved',
                );
            }
            cleanupSafe = true;
            return result;
        };
        try {
            const install: ConnectorWindowsBootstrapConfiguration = {
                ...configuration,
                argumentsJson: JSON.stringify([
                    'install',
                    '--directory',
                    destination,
                    '--release-directory',
                    source,
                ]),
            };
            const first: BootstrapFlowResult = await invoke(install);
            expect(first.code, first.stderr).toBe(0);
            completed = true;
            await ConnectorInstallation.read(destination, AbortSignal.timeout(30000));
            const key: string = join(destination, 'state', 'device-key.json');
            const before: string = createHash('sha256')
                .update(await readFile(key))
                .digest('hex');
            expect((await invoke(install)).code).toBe(0);
            const status: BootstrapFlowResult = await invoke({
                ...configuration,
                argumentsJson: JSON.stringify(['status', '--directory', destination]),
            });
            expect(status.code, status.stderr).toBe(0);
            expect(
                createHash('sha256')
                    .update(await readFile(key))
                    .digest('hex'),
            ).toBe(before);
            const marker: string = join(destination, 'qualification-untrusted-execution');
            await writeFile(
                join(destination, 'nerva-connector.mjs'),
                "import{writeFileSync}from'node:fs';writeFileSync(" +
                    JSON.stringify(marker) +
                    ",'unexpected');\n",
            );
            expect(
                (
                    await invoke({
                        ...configuration,
                        argumentsJson: JSON.stringify(['status', '--directory', destination]),
                    })
                ).code,
            ).not.toBe(0);
            expect(existsSync(marker)).toBe(false);
            expect(
                createHash('sha256')
                    .update(await readFile(key))
                    .digest('hex'),
            ).toBe(before);
        } finally {
            await WindowsStateOwner.close();
            if (
                completed &&
                cleanupSafe &&
                !existsSync(join(root.path, 'bootstrap-pending.json'))
            ) {
                await rm(destination, { recursive: true, force: true });
            }
        }
    },
    300000,
);
