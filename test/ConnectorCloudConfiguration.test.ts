// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

import { mkdtemp, readFile, readdir, rm, writeFile, mkdir, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { expect, it } from 'vitest';
import { ConnectorCloudConfiguration } from '../src/runtime/ConnectorCloudConfiguration.js';
import { ConnectorCloudAuthority } from '../src/runtime/ConnectorCloudAuthority.js';
import {
    ConnectorPairConfiguration,
    type ConnectorPairIdentity,
} from '../src/runtime/ConnectorPairConfiguration.js';
import { ConnectorDeviceKey } from '../src/runtime/ConnectorDeviceKey.js';
import { SigningKey } from '../src/identity/SigningKey.js';
import { SignatureSuite } from 'nerva-connector-protocol/identity/IdentityFormat.js';

/** Every cloud bootstrap test owns one private directory and never connects to a public endpoint. */
class CloudFixture implements AsyncDisposable {
    private constructor(public readonly directory: string) {}
    /** State is isolated beneath the trusted user home, avoiding world-writable temporary ancestry. */
    public static async create(): Promise<CloudFixture> {
        return new CloudFixture(await mkdtemp(join(homedir(), '.nerva-cloud-test-')));
    }
    /** Only this test's private files are removed. */
    public async [Symbol.asyncDispose](): Promise<void> {
        await rm(this.directory, { recursive: true, force: true });
    }
}

it('first cloud startup supplies compiled dual trust and fixed endpoints without granting access or creating duplicate device identity', async (): Promise<void> => {
    await using fixture: CloudFixture = await CloudFixture.create();
    const path: string = await ConnectorCloudConfiguration.prepare(
        fixture.directory,
        AbortSignal.timeout(5000),
    );
    const identity: ConnectorPairIdentity = await ConnectorPairConfiguration.load(path);
    expect(identity.authority).toEqual({
        authorityId: ConnectorCloudAuthority.id,
        publicKey: ConnectorCloudAuthority.publicKey,
    });
    expect(identity.settings.endpoints).toEqual(['wss://ai.dacely.com/v1/connector/tunnel']);
    expect(identity.settings.verificationUri).toBe('https://nervalabs.com/chat/connectors');
    expect(identity.settings.files).toBeNull();
    expect(identity.settings.execution).toBeNull();
    expect((await lstat(path)).mode & 0o777).toBe(0o600);
    expect((await lstat(identity.settings.stateDirectory)).mode & 0o777).toBe(0o700);
    expect(await readdir(identity.settings.stateDirectory)).toEqual([]);
    const beforeStatus: readonly string[] = await readdir(fixture.directory);
    expect(
        await ConnectorCloudConfiguration.status(fixture.directory, AbortSignal.timeout(5000)),
    ).toContain('not linked');
    expect(await readdir(fixture.directory)).toEqual(beforeStatus);
    await ConnectorDeviceKey.initialize(join(identity.settings.stateDirectory, 'device-key.json'));
    const original: Buffer = await readFile(
        join(identity.settings.stateDirectory, 'device-key.json'),
    );
    await writeFile(join(identity.settings.stateDirectory, 'pairing-state'), 'original-history', {
        mode: 0o600,
    });
    expect(
        await ConnectorCloudConfiguration.prepare(fixture.directory, AbortSignal.timeout(5000)),
    ).toBe(path);
    expect(await readFile(join(identity.settings.stateDirectory, 'device-key.json'))).toEqual(
        original,
    );
    expect(await readFile(join(identity.settings.stateDirectory, 'pairing-state'), 'utf8')).toBe(
        'original-history',
    );
});

it('substituting either public identity or deployment settings fails without repairing or resetting retained device state', async (): Promise<void> => {
    await using fixture: CloudFixture = await CloudFixture.create();
    const path: string = await ConnectorCloudConfiguration.prepare(
        fixture.directory,
        AbortSignal.timeout(5000),
    );
    const identity: ConnectorPairIdentity = await ConnectorPairConfiguration.load(path);
    const keyFile: string = join(identity.settings.stateDirectory, 'device-key.json');
    await ConnectorDeviceKey.initialize(keyFile);
    const original: Buffer = await readFile(keyFile);
    const originalPin: Buffer = await readFile(identity.settings.authorityPublicKeyFile);
    using replacement: SigningKey = SigningKey.generate();
    const changedPin: string = JSON.stringify({
        suite: SignatureSuite.MlDsa44Ed25519,
        publicKey: replacement.publicKey,
    });
    await writeFile(identity.settings.authorityPublicKeyFile, changedPin, { mode: 0o600 });
    await expect(
        ConnectorCloudConfiguration.prepare(fixture.directory, AbortSignal.timeout(5000)),
    ).rejects.toThrow('authority changed');
    expect(await readFile(identity.settings.authorityPublicKeyFile, 'utf8')).toBe(changedPin);
    await writeFile(identity.settings.authorityPublicKeyFile, originalPin, { mode: 0o600 });
    const changedConfiguration: string = JSON.stringify({
        ...identity.settings,
        endpoints: ['wss://attacker.example/v1/connector/tunnel'],
    });
    await writeFile(path, changedConfiguration, { mode: 0o600 });
    await expect(
        ConnectorCloudConfiguration.prepare(fixture.directory, AbortSignal.timeout(5000)),
    ).rejects.toThrow('configuration changed');
    await expect(
        ConnectorCloudConfiguration.status(fixture.directory, AbortSignal.timeout(5000)),
    ).rejects.toThrow('configuration changed');
    expect(await readFile(path, 'utf8')).toBe(changedConfiguration);
    expect(await readFile(keyFile)).toEqual(original);
});

it('an incomplete signed installation cannot become a fresh cloud enrollment', async (): Promise<void> => {
    await using fixture: CloudFixture = await CloudFixture.create();
    await writeFile(join(fixture.directory, 'release.json'), 'incomplete-installation', {
        mode: 0o600,
    });
    await expect(
        ConnectorCloudConfiguration.prepare(fixture.directory, AbortSignal.timeout(5000)),
    ).rejects.toThrow('incomplete');
    expect(await readdir(fixture.directory)).toEqual(['release.json']);
});

it('existing identity history without its original configuration cannot be adopted by automatic cloud setup', async (): Promise<void> => {
    await using fixture: CloudFixture = await CloudFixture.create();
    const state: string = join(fixture.directory, 'state');
    await mkdir(state, { mode: 0o700 });
    await ConnectorDeviceKey.initialize(join(state, 'device-key.json'));
    const original: Buffer = await readFile(join(state, 'device-key.json'));
    await expect(
        ConnectorCloudConfiguration.prepare(fixture.directory, AbortSignal.timeout(5000)),
    ).rejects.toThrow('original pairing configuration');
    expect(await readdir(fixture.directory)).toEqual(['state']);
    expect(await readFile(join(state, 'device-key.json'))).toEqual(original);
});
