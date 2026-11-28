// SPDX-FileCopyrightText: 2026 Dacely <business@dacely.com>
// SPDX-License-Identifier: LicenseRef-Proprietary

import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import {
    SignatureSuite,
    type PublicIdentityRecord,
} from 'nerva-connector-protocol/identity/IdentityFormat.js';
import { ConnectorSetupCommand } from '../src/cli/ConnectorSetupCommand.js';
import { ConnectorCloudConfiguration } from '../src/runtime/ConnectorCloudConfiguration.js';
import { ConnectorDeviceKey } from '../src/runtime/ConnectorDeviceKey.js';
import type { SigningKey } from '../src/identity/SigningKey.js';
import {
    ConnectorPairConfiguration,
    type ConnectorPairIdentity,
} from '../src/runtime/ConnectorPairConfiguration.js';
import { ConnectorSetupStore } from '../src/runtime/ConnectorSetupStore.js';
import { ConnectorSetupAccess } from '../src/runtime/ConnectorSetupProfile.js';

/** Each unattended setup owns one private cloud directory beneath the trusted home and never connects. */
class SetupFixture implements AsyncDisposable {
    private constructor(public readonly root: string) {}
    /** A home-relative parent avoids world-writable temporary ancestry. */
    public static async create(): Promise<SetupFixture> {
        return new SetupFixture(await mkdtemp(join(homedir(), '.nerva-setup-test-')));
    }
    /** The cloud state directory the command prepares. */
    public get directory(): string {
        return join(this.root, 'connector');
    }
    /** Only this test's files are removed. */
    public async [Symbol.asyncDispose](): Promise<void> {
        await rm(this.root, { recursive: true, force: true });
    }
}

it('accepts each setup answer once and refuses unknown, repeated or files-only options', (): void => {
    expect(ConnectorSetupCommand.parse(['setup'])).toEqual({});
    expect(
        ConnectorSetupCommand.parse([
            'setup',
            '--name',
            'Build VM',
            '--folder',
            '/workspace',
            '--access',
            'full-computer',
        ]),
    ).toEqual({
        name: 'Build VM',
        folder: '/workspace',
        access: ConnectorSetupAccess.FullComputer,
    });
    for (const args of [
        ['setup', '--name'],
        ['setup', '--name', 'a', '--name', 'b'],
        ['setup', '--access', 'files-write'],
        ['setup', '--pair', 'now'],
        ['setup', '--folder', 'relative'],
        ['setup', '--name', 'bad\u0007name'],
    ]) {
        expect((): unknown => ConnectorSetupCommand.parse(args)).toThrow();
    }
});

it('prepares an unlinked cloud identity with the chosen answers and reports only its public key', async (): Promise<void> => {
    await using fixture: SetupFixture = await SetupFixture.create();
    const folder: string = join(fixture.root, 'tasks');
    const identity: PublicIdentityRecord = await ConnectorSetupCommand.run(
        fixture.directory,
        { name: 'Build VM', folder },
        AbortSignal.timeout(5000),
    );
    expect(identity.suite).toBe(SignatureSuite.MlDsa44Ed25519);
    const pairing: ConnectorPairIdentity = await ConnectorPairConfiguration.load(
        join(fixture.directory, 'pairing.json'),
    );
    expect(pairing.settings.deviceName).toBe('Build VM');
    const keyFile: string = join(pairing.settings.stateDirectory, 'device-key.json');
    using device: SigningKey = (await ConnectorDeviceKey.load(keyFile)).key;
    expect(device.publicKey).toBe(identity.publicKey);
    expect(JSON.stringify(identity)).not.toContain('private');
    expect(await readdir(pairing.settings.stateDirectory)).toEqual(['device-key.json']);
    expect(await ConnectorSetupStore.load(fixture.directory)).toMatchObject({
        name: 'Build VM',
        tasksDirectory: folder,
        access: ConnectorSetupAccess.PairingOnly,
        revision: 1n,
    });
    expect(await readdir(folder)).toEqual([]);
    expect(
        await ConnectorCloudConfiguration.status(fixture.directory, AbortSignal.timeout(5000)),
    ).toContain('not linked');

    const original: Buffer = await readFile(keyFile);
    const again: PublicIdentityRecord = await ConnectorSetupCommand.run(
        fixture.directory,
        { name: 'Build VM', folder },
        AbortSignal.timeout(5000),
    );
    expect(again).toEqual(identity);
    expect(await readFile(keyFile)).toEqual(original);
    expect((await ConnectorSetupStore.load(fixture.directory))?.revision).toBe(1n);

    const renamed: PublicIdentityRecord = await ConnectorSetupCommand.run(
        fixture.directory,
        { name: 'Renamed VM' },
        AbortSignal.timeout(5000),
    );
    expect(renamed).toEqual(identity);
    expect(
        (await ConnectorPairConfiguration.load(join(fixture.directory, 'pairing.json'))).settings
            .deviceName,
    ).toBe('Renamed VM');
    expect(await ConnectorSetupStore.load(fixture.directory)).toMatchObject({
        name: 'Renamed VM',
        tasksDirectory: folder,
        revision: 2n,
    });
});
