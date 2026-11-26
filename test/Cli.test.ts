// SPDX-FileCopyrightText: 2026 Dacely <business@dacely.com>
// SPDX-License-Identifier: LicenseRef-Proprietary

import { execFile } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { promisify } from 'node:util';
import { mkdtemp, rm, readFile, lstat, readdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, it } from 'vitest';
import { SigningKey } from '../src/identity/SigningKey.js';
import { ConnectorLogout } from '../src/runtime/ConnectorLogout.js';
import { ConnectorCloudConfiguration } from '../src/runtime/ConnectorCloudConfiguration.js';
import {
    ConnectorPairConfiguration,
    type ConnectorPairIdentity,
} from '../src/runtime/ConnectorPairConfiguration.js';
import {
    ConnectorDeviceKey,
    type ConnectorDeviceIdentity,
} from '../src/runtime/ConnectorDeviceKey.js';
import { ConnectorPairState } from '../src/runtime/ConnectorPairState.js';
import { SignatureSuite } from 'nerva-connector-protocol/identity/IdentityFormat.js';
import { Boundary } from 'nerva-connector-protocol/protocol/Boundary.js';

/** Runs the actual package executable from an unrelated empty directory, without source or dependencies beside it. */
class CliFixture implements AsyncDisposable {
    private constructor(public readonly directory: string) {}
    /** Every test owns and removes its working directory after child exit. */
    public static async create(): Promise<CliFixture> {
        return new CliFixture(await mkdtemp(join(homedir(), '.nerva-cli-test-')));
    }
    /** Only fixed command arguments enter the executable; no shell evaluates them. */
    public async run(args: readonly string[]): Promise<string> {
        const result: Awaited<ReturnType<typeof execFile.__promisify__>> = await promisify(
            execFile,
        )(resolve('build/nerva-connector.mjs'), args, {
            cwd: this.directory,
            env: { PATH: process.env['PATH'], NODE_OPTIONS: '', HOME: this.directory },
            timeout: 5000,
            maxBuffer: 16384,
        });
        expect(result.stderr).toBe('');
        return result.stdout.toString();
    }
    /** Removes only this fixture's local files. */
    public async [Symbol.asyncDispose](): Promise<void> {
        await rm(this.directory, { recursive: true, force: true });
    }
}

it.skipIf(process.platform !== 'linux')(
    'the actual logout command preserves pairing when server revocation cannot be confirmed',
    async (): Promise<void> => {
        await using fixture: CliFixture = await CliFixture.create();
        const file: string = await ConnectorCloudConfiguration.prepare(
            join(fixture.directory, 'installation'),
            new AbortController().signal,
        );
        const raw: unknown = JSON.parse((await readFile(file)).toString('utf8'));
        if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
            throw new Error('Missing pairing');
        }
        await writeFile(
            file,
            JSON.stringify({ ...raw, endpoints: ['wss://127.0.0.1:1/v1/connector/tunnel'] }),
            { mode: 0o600 },
        );
        const pairing: ConnectorPairIdentity = await ConnectorPairConfiguration.load(file);
        await ConnectorDeviceKey.initialize(
            join(pairing.settings.stateDirectory, 'device-key.json'),
        );
        const identity: ConnectorDeviceIdentity = await ConnectorDeviceKey.load(
            join(pairing.settings.stateDirectory, 'device-key.json'),
        );
        using key: typeof identity.key = identity.key;
        {
            await using state: ConnectorPairState = await ConnectorPairState.open(
                pairing.settings.stateDirectory,
                identity,
                pairing.configurationSha256,
            );
            expect(state.snapshot.publicKey).toBe(key.publicKey);
        }
        try {
            await fixture.run(['connector', 'logout', '--config', file]);
            throw new Error('An offline unpair must fail');
        } catch (caught: unknown) {
            if (
                !(caught instanceof Error) ||
                !('stderr' in caught) ||
                typeof caught.stderr !== 'string'
            ) {
                throw caught;
            }
            expect(caught.stderr).toContain(
                'Unpairing is not confirmed. Your pairing is preserved.',
            );
        }
        expect(await ConnectorLogout.resolve(file, new AbortController().signal)).toBe(file);
    },
);

it('package bin is an executable CLI and help creates no local state', async (): Promise<void> => {
    await using fixture: CliFixture = await CliFixture.create();
    const raw: unknown = JSON.parse(await readFile('package.json', 'utf8'));
    const manifest: Readonly<Record<string, unknown>> = Boundary.record(raw, [
        'name',
        'version',
        'private',
        'type',
        'license',
        'engines',
        'files',
        'scripts',
        'dependencies',
        'devDependencies',
        'bin',
        'madge',
    ]);
    const bin: Readonly<Record<string, unknown>> = Boundary.record(manifest['bin'], ['nexa']);
    expect(bin['nexa']).toBe('build/nerva-connector.mjs');
    expect((await lstat('build/nerva-connector.mjs')).mode & 0o100).toBe(0o100);
    const help: string = await fixture.run(['--help']);
    expect(help).toContain('nexa connector');
    expect(help).toContain('Type /');
    expect(help).toContain('system-info');
    expect(help).toContain(
        'nexa connector inspect-workspace --config <runtimeFile> --file-root <id> --execution-root <id>',
    );
    expect(help).not.toContain('connect --config');
    const artifact: string = await readFile('build/nerva-connector.mjs', 'utf8');
    expect(await readFile('build/THIRD-PARTY-NOTICES.txt', 'utf8')).toBe(
        (await readFile('native/THIRD-PARTY-NOTICES.txt', 'utf8')).replaceAll('\r\n', '\n'),
    );
    expect(artifact).toContain('@dacely/noble-post-quantum license:');
    expect(artifact).toContain('@noble/hashes license:');
    expect(artifact).toContain('@noble/curves license:');
    expect(await fixture.run([])).toBe(help);
    expect(await fixture.run(['connector', '--help'])).toBe(help);
    expect(await fixture.run(['connector', 'status'])).toContain('Not set up');
    expect(await readdir(fixture.directory)).toEqual([]);
});

it('standalone system-info returns exact memory and bounded CPU/GPU inventory', async (): Promise<void> => {
    await using fixture: CliFixture = await CliFixture.create();
    const raw: unknown = JSON.parse(await fixture.run(['system-info']));
    const result: Readonly<Record<string, unknown>> = Boundary.record(raw, [
        'observedAtMs',
        'platform',
        'architecture',
        'osRelease',
        'cpuModel',
        'logicalCpuCount',
        'totalMemoryBytes',
        'availableMemoryBytes',
        'gpuState',
        'gpus',
        'usage',
    ]);
    expect(result['logicalCpuCount']).toBeGreaterThan(0);
    expect(result['totalMemoryBytes']).toMatch(/^[1-9][0-9]*$/u);
    expect(Array.isArray(result['gpus'])).toBe(true);
    expect(await readdir(fixture.directory)).toEqual([]);
});

it('invalid commands and missing configuration fail without creating an identity', async (): Promise<void> => {
    await using fixture: CliFixture = await CliFixture.create();
    for (const args of [
        ['exec', 'touch', 'unexpected'],
        ['run', '--config', join(fixture.directory, 'missing.json')],
        ['--config', join(fixture.directory, 'missing.json')],
        ['pair'],
    ]) {
        await expect(fixture.run(args)).rejects.toThrow();
    }
    expect(await readdir(fixture.directory)).toEqual([]);
});

it('pairing rejects a retired identity before generating a replacement or opening a network connection', async (): Promise<void> => {
    await using fixture: CliFixture = await CliFixture.create();
    using authority: SigningKey = SigningKey.generate();
    const pin: string = join(fixture.directory, 'authority-public.json');
    await writeFile(
        pin,
        JSON.stringify({ suite: SignatureSuite.MlDsa44Ed25519, publicKey: authority.publicKey }),
        { mode: 0o600 },
    );
    const retired: string = join(fixture.directory, 'device-key.pem');
    const configuration: string = join(fixture.directory, 'pairing.json');
    const bytes: Buffer = Buffer.from(
        generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' }),
    );
    try {
        await writeFile(retired, bytes, { mode: 0o600 });
        await writeFile(
            configuration,
            JSON.stringify({
                authorityId: 'test-authority',
                authorityPublicKeyFile: pin,
                stateDirectory: fixture.directory,
                endpoints: ['wss://example.invalid/v1/connector/tunnel'],
                verificationUri: 'https://ui.example.invalid/dashboard/connectors/link',
                deviceName: 'Existing machine',
                serverCaFile: null,
                files: null,
                execution: null,
            }),
            { mode: 0o600 },
        );
        await expect(fixture.run(['pair', '--config', configuration])).rejects.toThrow();
        expect(await readFile(retired)).toEqual(bytes);
        await expect(lstat(join(fixture.directory, 'device-key.json'))).rejects.toThrow();
        expect((await readdir(fixture.directory)).sort()).toEqual([
            'authority-public.json',
            'device-key.pem',
            'pairing.json',
        ]);
    } finally {
        bytes.fill(0);
    }
});
