// SPDX-FileCopyrightText: 2026 Dacely <business@dacely.com>
// SPDX-License-Identifier: LicenseRef-Proprietary

import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import {
    readdir,
    readFile,
    mkdir,
    copyFile,
    writeFile,
    chmod,
    chown,
    symlink,
    rm,
} from 'node:fs/promises';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { ConnectorReleaseFixture } from './support/ConnectorReleaseFixture.js';
import {
    SignatureSuite,
    SignaturePurpose,
} from 'nerva-connector-protocol/identity/IdentityFormat.js';
import {
    ConnectorNodeRuntime,
    ConnectorRuntimeUnsupported,
} from '../src/networking/ConnectorNodeRuntime.js';
import {
    ConnectorReleaseFile,
    type ConnectorReleaseArtifact,
    type ConnectorReleaseManifest,
    type ConnectorSignedRelease,
} from '../src/install/ConnectorRelease.js';
import { ConnectorReleaseCodec } from '../src/install/ConnectorReleaseCodec.js';
import { createHash } from 'node:crypto';

/** The release preparation script of this checkout. */
const prepareRelease: string = fileURLToPath(
    new URL('../script/prepare-release.ts', import.meta.url),
);

it.skipIf(process.platform !== 'linux')(
    'standalone bootstrap refuses unsafe ancestry before staging, fetching or executing even correctly pinned fixture assets',
    async (): Promise<void> => {
        await using fixture: ConnectorReleaseFixture = await ConnectorReleaseFixture.create();
        const marker: string = join(fixture.directory, 'child-executed');
        const runtime: Buffer = Buffer.from(
            '#!/bin/sh\nprintf executed >> "$NERVA_BOOTSTRAP_MARKER"\n',
        );
        await writeFile(join(fixture.directory, 'assets', 'node'), runtime, { mode: 0o700 });
        const manifest: ConnectorReleaseManifest = {
            ...fixture.release.manifest,
            artifacts: fixture.release.manifest.artifacts.map(
                (artifact: ConnectorReleaseArtifact): ConnectorReleaseArtifact =>
                    artifact.name === ConnectorReleaseFile.Runtime
                        ? {
                              ...artifact,
                              sizeBytes: BigInt(runtime.length),
                              sha256: createHash('sha256').update(runtime).digest('hex'),
                          }
                        : artifact,
            ),
        };
        const release: ConnectorSignedRelease = {
            manifest,
            signature: fixture.key.sign(
                SignaturePurpose.Release,
                ConnectorReleaseCodec.payload(manifest),
            ),
        };
        await fixture.publish(release);
        const writable: string = join(fixture.directory, 'writable');
        const sticky: string = join(fixture.directory, 'sticky');
        await mkdir(writable);
        await chmod(writable, 0o777);
        await mkdir(sticky);
        await chmod(sticky, 0o1777);
        const link: string = join(fixture.directory, 'link');
        await symlink(fixture.directory, link);
        const destinations: string[] = [
            join(writable, 'installation'),
            join(sticky, 'installation'),
            join(link, 'installation'),
            fixture.directory + '/./installation',
            fixture.directory + '/../installation',
            fixture.directory + '/line\nbreak/installation',
            fixture.directory + '/line\rbreak/installation',
        ];
        if (process.getuid?.() === 0) {
            const foreign: string = join(fixture.directory, 'foreign');
            await mkdir(foreign, { mode: 0o700 });
            await chown(foreign, 65534, 65534);
            destinations.push(join(foreign, 'installation'));
        }
        for (const destination of destinations) {
            const outcomes: readonly PromiseSettledResult<
                Awaited<ReturnType<typeof execFile.__promisify__>>
            >[] = await Promise.allSettled([
                promisify(execFile)(
                    '/bin/sh',
                    [
                        '-x',
                        join(fixture.directory, 'install.sh'),
                        '--destination',
                        destination,
                        '--release-directory',
                        join(fixture.directory, 'assets'),
                        '--install-only',
                    ],
                    {
                        timeout: 5000,
                        maxBuffer: 32768,
                        env: { PATH: '/usr/bin:/bin', NERVA_BOOTSTRAP_MARKER: marker },
                    },
                ),
            ]);
            const outcome:
                | PromiseSettledResult<Awaited<ReturnType<typeof execFile.__promisify__>>>
                | undefined = outcomes[0];
            if (outcome?.status !== 'rejected') {
                throw new Error('Unsafe bootstrap ancestry reached its correctly pinned child');
            }
            const failure: unknown = outcome.reason;
            if (
                !(failure instanceof Error) ||
                !('stderr' in failure) ||
                typeof failure.stderr !== 'string'
            ) {
                throw failure;
            }
            expect(failure).toMatchObject({ code: 1 });
            expect(failure.stderr).not.toContain('.nerva-setup.');
            expect(failure.stderr).not.toContain('+ fetch ');
            expect(await readdir(fixture.directory)).not.toContain('child-executed');
        }
        expect(await readdir(writable)).toEqual([]);
        expect(await readdir(sticky)).toEqual([]);
    },
);

/** Automation may supply an explicit destination without any login-shell HOME environment. */
enum BootstrapEnvironment {
    Login = 'login',
    Headless = 'headless',
}

it.each(Object.values(BootstrapEnvironment))(
    'one shell script bootstraps pinned assets in %s mode, scrubs preload options and leaves no setup copies',
    async (mode: BootstrapEnvironment): Promise<void> => {
        await using fixture: ConnectorReleaseFixture = await ConnectorReleaseFixture.create(true);
        const destination: string = join(fixture.directory, 'installed');
        const args: readonly string[] = [
            join(fixture.directory, 'install.sh'),
            '--destination',
            destination,
            '--release-directory',
            join(fixture.directory, 'assets'),
            '--install-only',
            ...(mode === BootstrapEnvironment.Headless ? ['--quiet'] : []),
        ];
        const result: Awaited<ReturnType<typeof execFile.__promisify__>> = await promisify(
            execFile,
        )('/bin/sh', [...args], {
            timeout: 30000,
            maxBuffer: 8192,
            env:
                mode === BootstrapEnvironment.Headless
                    ? {
                          PATH: '/usr/bin:/bin',
                          NODE_OPTIONS: '--require=/nonexistent/untrusted-preload',
                      }
                    : { ...process.env, NODE_OPTIONS: '--require=/nonexistent/untrusted-preload' },
        });
        expect(result.stdout).toContain('"releaseId":"qualified-release"');
        expect(result.stderr).toBe('');
        if (mode === BootstrapEnvironment.Headless) {
            const output: unknown = JSON.parse(result.stdout.toString());
            expect(output).toMatchObject({ releaseId: 'qualified-release' });
        }
        const version: Awaited<ReturnType<typeof execFile.__promisify__>> = await promisify(
            execFile,
        )(join(destination, 'node'), ['--version'], { env: { NODE_OPTIONS: '' }, timeout: 5000 });
        expect(version.stdout.toString().trim()).toBe(process.version);
        const help: Awaited<ReturnType<typeof execFile.__promisify__>> = await promisify(execFile)(
            join(destination, 'node'),
            [join(destination, 'nerva-connector.mjs'), '--help'],
            { env: { NODE_OPTIONS: '' }, timeout: 5000 },
        );
        expect(help.stdout).toContain('Type /');
        expect(await readdir(fixture.directory)).not.toEqual(
            expect.arrayContaining([expect.stringMatching(/^\.nerva-setup-/u)]),
        );
        expect(JSON.parse(await readFile(join(destination, 'pairing.json'), 'utf8'))).toMatchObject(
            {
                files: null,
                execution: null,
            },
        );
    },
    45000,
);

it('the production release preparation command signs only reviewed stable assets and produces an executable installer without source or keys', async (): Promise<void> => {
    await using fixture: ConnectorReleaseFixture = await ConnectorReleaseFixture.create(true);
    const directory: string = join(fixture.directory, 'build');
    await mkdir(directory, { mode: 0o700 });
    for (const name of [
        ConnectorReleaseFile.Application,
        ConnectorReleaseFile.Files,
        ConnectorReleaseFile.Execution,
        ConnectorReleaseFile.Notices,
        ConnectorReleaseFile.HostWorker,
    ]) {
        await copyFile(join(fixture.directory, 'assets', name), join(directory, name));
    }
    const secret: Buffer = fixture.key.encode();
    try {
        await writeFile(join(fixture.directory, 'release-key.json'), secret, { mode: 0o600 });
    } finally {
        secret.fill(0);
    }
    await writeFile(
        join(fixture.directory, 'authority.json'),
        JSON.stringify({
            suite: SignatureSuite.MlDsa44Ed25519,
            publicKey: fixture.release.manifest.deployment.publicKey,
        }),
        { mode: 0o600 },
    );
    const config: string = join(fixture.directory, 'prepare.json');
    await writeFile(
        config,
        JSON.stringify({
            releaseId: 'prepared-release',
            revision: '9007199254740994',
            expiresAtMs: fixture.release.manifest.expiresAtMs.toString(),
            platform: 'linux',
            releaseKeyFile: join(fixture.directory, 'release-key.json'),
            nodeFile: join(fixture.directory, 'assets', 'node'),
            nodeLicenseFile: join(fixture.directory, 'assets', 'NODE-LICENSE'),
            authorityId: 'cloud',
            authorityPublicKeyFile: join(fixture.directory, 'authority.json'),
            endpoints: fixture.release.manifest.deployment.endpoints,
            verificationUri: fixture.release.manifest.deployment.verificationUri,
            serverCaFile: null,
            downloadBaseUrl: 'https://downloads.example.com/releases/prepared/',
            npmVersion: '0.1.0',
        }),
        { mode: 0o600 },
    );
    const configured: string = await readFile(config, 'utf8');
    await writeFile(config, configured.replace('"npmVersion":"0.1.0"', '"npmVersion":"01.0.0"'));
    await expect(
        promisify(execFile)(process.execPath, [prepareRelease, '--config', config], {
            cwd: fixture.directory,
            env: { ...process.env, NODE_OPTIONS: '' },
            timeout: 15000,
            maxBuffer: 8192,
        }),
    ).rejects.toThrow();
    expect((await readdir(directory)).sort()).toEqual([
        'THIRD-PARTY-NOTICES.txt',
        'nerva-connector-exec',
        'nerva-connector-files',
        'nerva-connector-host-worker.mjs',
        'nerva-connector.mjs',
    ]);
    await writeFile(config, configured);
    const result: Awaited<ReturnType<typeof execFile.__promisify__>> = await promisify(execFile)(
        process.execPath,
        [prepareRelease, '--config', config],
        {
            cwd: fixture.directory,
            env: { ...process.env, NODE_OPTIONS: '' },
            timeout: 30000,
            maxBuffer: 8192,
        },
    );
    expect(result.stdout).toContain('"releaseId":"prepared-release"');
    expect((await readdir(directory)).sort()).toEqual([
        'NODE-LICENSE',
        'THIRD-PARTY-NOTICES.txt',
        'install-connector.sh',
        'nerva-connector-exec',
        'nerva-connector-files',
        'nerva-connector-host-worker.mjs',
        'nerva-connector.mjs',
        'node',
        'npm',
        'release.json',
    ]);
    const installed: Awaited<ReturnType<typeof execFile.__promisify__>> = await promisify(execFile)(
        '/bin/sh',
        [
            join(directory, 'install-connector.sh'),
            '--destination',
            join(fixture.directory, 'prepared-install'),
            '--release-directory',
            directory,
            '--install-only',
        ],
        { timeout: 30000, maxBuffer: 8192 },
    );
    expect(installed.stdout).toContain('"revision":"9007199254740994"');
    const publisher: string = join(fixture.directory, 'separate-publisher');
    await mkdir(publisher, { mode: 0o700 });
    const sourceArgs: readonly string[] = [
        prepareRelease,
        '--config',
        config,
        '--output-directory',
        publisher,
        '--artifacts-directory',
        directory,
    ];
    const worker: string = join(directory, ConnectorReleaseFile.HostWorker);
    const workerBytes: Buffer = await readFile(worker);
    await rm(worker);
    await expect(
        promisify(execFile)(process.execPath, [...sourceArgs], {
            cwd: fixture.directory,
            env: { ...process.env, NODE_OPTIONS: '' },
            timeout: 15000,
            maxBuffer: 8192,
        }),
    ).rejects.toThrow();
    expect(await readdir(publisher)).toEqual([]);
    await writeFile(worker, workerBytes, { mode: 0o700 });
    const prepared: Awaited<ReturnType<typeof execFile.__promisify__>> = await promisify(execFile)(
        process.execPath,
        [...sourceArgs],
        {
            cwd: fixture.directory,
            env: { ...process.env, NODE_OPTIONS: '' },
            timeout: 30000,
            maxBuffer: 8192,
        },
    );
    expect(prepared.stdout).toContain('"releaseId":"prepared-release"');
    expect((await readdir(publisher)).toSorted()).toEqual((await readdir(directory)).toSorted());
    for (const name of [
        ConnectorReleaseFile.Application,
        ConnectorReleaseFile.Files,
        ConnectorReleaseFile.Execution,
        ConnectorReleaseFile.Notices,
        ConnectorReleaseFile.HostWorker,
    ]) {
        expect(await readFile(join(publisher, name))).toEqual(
            await readFile(join(directory, name)),
        );
    }
}, 60000);

it('bootstrap rejects a substituted app before it can execute and cleans its owned download directory', async (): Promise<void> => {
    await using fixture: ConnectorReleaseFixture = await ConnectorReleaseFixture.create(true);
    const path: string = join(fixture.directory, 'assets', 'nerva-connector.mjs');
    const marker: string = join(fixture.directory, 'must-not-execute');
    const original: Buffer = await readFile(path);
    const payload: string =
        'import {writeFileSync} from "node:fs"; writeFileSync(' +
        JSON.stringify(marker) +
        ',"executed");';
    await writeFile(path, payload.padEnd(original.byteLength, ' '));
    await expect(
        promisify(execFile)(
            '/bin/sh',
            [
                join(fixture.directory, 'install.sh'),
                '--destination',
                join(fixture.directory, 'installed'),
                '--release-directory',
                join(fixture.directory, 'assets'),
                '--install-only',
            ],
            { timeout: 30000, maxBuffer: 8192 },
        ),
    ).rejects.toMatchObject({ code: 1 });
    const names: readonly string[] = await readdir(fixture.directory);
    expect(names).not.toContain('must-not-execute');
    expect(names).not.toContain('installed');
    expect(names.some((name: string): boolean => name.startsWith('.nerva-setup.'))).toBe(false);
}, 45000);

it('only Node releases whose built-in WebSocket enforces the fragment budget can initialize device state', (): void => {
    for (const [node, parser] of [
        ['24.17.0', '7.28.0'],
        ['24.22.2', '7.30.1'],
        ['26.3.1', '8.5.0'],
        ['26.5.1', '8.9.0'],
        ['26.12.1', '8.12.2'],
    ] as const) {
        ConnectorNodeRuntime.validate(node, parser);
    }
    for (const [node, parser] of [
        ['24.16.0', '7.25.0'],
        ['24.17.0', '7.27.0'],
        ['24.22.2', '8.12.2'],
        ['25.9.0', '7.30.1'],
        ['26.3.0', '8.3.0'],
        ['26.12.1', '8.4.0'],
        ['26.12.1', '7.30.1'],
        ['26.12.1', '9.0.0'],
        ['26.12.1', ''],
        ['27.0.0', '8.12.2'],
        ['22.20.0', '6.21.3'],
    ] as const) {
        expect((): void => ConnectorNodeRuntime.validate(node, parser)).toThrow(
            ConnectorRuntimeUnsupported,
        );
    }
    expect((): void => ConnectorNodeRuntime.validate('22.20.0', '6.21.3')).toThrow(
        'Nerva Connector needs Node.js 24.17.0 or newer in the 24.x line, or 26.3.1 or newer in ' +
            'the 26.x line; this computer has Node.js 22.20.0. Install Node.js 26 LTS',
    );
    expect((): void => ConnectorNodeRuntime.validate('26.12.1', '8.4.0')).toThrow(
        'older built-in WebSocket client (Undici 8.4.0)',
    );
    expect((): void => ConnectorNodeRuntime.validate('v26\u001b[0m', '8.5.0')).toThrow(
        'this computer has an unrecognized Node.js version.',
    );
});
