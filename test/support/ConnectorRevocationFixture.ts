// SPDX-FileCopyrightText: 2026 Dacely <business@dacely.com>
// SPDX-License-Identifier: LicenseRef-Proprietary

import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
    SignatureSuite,
    SignaturePurpose,
} from 'nerva-connector-protocol/identity/IdentityFormat.js';
import {
    ConnectorUnpairCodec,
    type ConnectorUnpair,
} from 'nerva-connector-protocol/protocol/ConnectorUnpair.js';
import {
    ConnectorPrivateDirectory,
    ConnectorDirectoryPurpose,
} from '../../src/runtime/ConnectorPrivateDirectory.js';
import { ProtectedFiles } from '../../src/local/ProtectedFiles.js';
import {
    ConnectorPairConfiguration,
    type ConnectorPairSettings,
} from '../../src/runtime/ConnectorPairConfiguration.js';
import type { ConnectorClientIdentity } from '../../src/runtime/ConnectorClientConfiguration.js';
import { ConnectorSessionFixture } from './ConnectorSessionFixture.js';

/** Generated composite identities and actual private storage contain no production authority. */
export class ConnectorRevocationFixture implements AsyncDisposable {
    #receipt: ConnectorUnpair | null = null;
    public readonly session: ConnectorSessionFixture = new ConnectorSessionFixture();
    public readonly directory: string = join(homedir(), '.nerva-revocation-' + randomUUID());
    public readonly state: string = join(this.directory, 'state');
    public readonly pairingFile: string = join(this.directory, 'pairing.json');
    public identity: ConnectorClientIdentity = this.session.identity;

    /** A caller may inject its real TLS listener before any connector starts. */
    public static async create(
        endpoint: string,
        certificate: Buffer | null = null,
    ): Promise<ConnectorRevocationFixture> {
        const fixture: ConnectorRevocationFixture = new ConnectorRevocationFixture();
        try {
            await ProtectedFiles.createDirectory(fixture.directory);
            await ProtectedFiles.createDirectory(fixture.state);
            await using installation: ConnectorPrivateDirectory =
                await ConnectorPrivateDirectory.open(
                    fixture.directory,
                    ConnectorDirectoryPurpose.Installation,
                );
            await installation.write(
                'authority-public.json',
                Buffer.from(
                    JSON.stringify({
                        suite: SignatureSuite.MlDsa44Ed25519,
                        publicKey: fixture.session.authority.publicKey,
                    }),
                ),
                16384,
                true,
            );
            if (certificate !== null) {
                await installation.write('server-ca.pem', certificate, 65536, true);
            }
            const settings: ConnectorPairSettings = {
                authorityId: fixture.session.identity.settings.authorityId,
                authorityPublicKeyFile: installation.file('authority-public.json'),
                stateDirectory: fixture.state,
                endpoints: [endpoint],
                verificationUri: 'https://example.invalid/chat/connectors/link',
                deviceName: 'Revocation fixture',
                serverCaFile: certificate === null ? null : installation.file('server-ca.pem'),
                files: null,
                execution: null,
            };
            await installation.write(
                'pairing.json',
                Buffer.from(JSON.stringify(settings)),
                16384,
                true,
            );
            await using state: ConnectorPrivateDirectory = await ConnectorPrivateDirectory.open(
                fixture.state,
                ConnectorDirectoryPurpose.Pairing,
            );
            const bytes: Buffer = fixture.session.device.encode();
            try {
                await state.write('device-key.json', bytes, 16384, true);
            } finally {
                bytes.fill(0);
            }
            fixture.identity = {
                ...fixture.session.identity,
                configurationFile: state.file('device.json'),
                settings: {
                    ...fixture.session.identity.settings,
                    endpoints: settings.endpoints,
                    authorityPublicKeyFile: settings.authorityPublicKeyFile,
                    privateKeyFile: state.file('device-key.json'),
                    serverCaFile: settings.serverCaFile,
                },
                ca: certificate ?? undefined,
            };
            await state.write(
                'device.json',
                Buffer.from(JSON.stringify(fixture.identity.settings)),
                16384,
                true,
            );
            await state.write(
                'file-journal',
                Buffer.from('retained native operation evidence'),
                16384,
                true,
            );
            await ConnectorPairConfiguration.load(fixture.pairingFile);
            return fixture;
        } catch (caught: unknown) {
            await fixture[Symbol.asyncDispose]();
            throw caught;
        }
    }

    /** The same exact permanent target is used for online notification and offline reconnect. */
    public receipt(): ConnectorUnpair {
        if (this.#receipt !== null) {
            return this.#receipt;
        }
        const target: Pick<ConnectorUnpair, 'authorityId' | 'publicKey'> = {
            authorityId: this.identity.authority.authorityId,
            publicKey: this.identity.publicKey,
        };
        this.#receipt = {
            ...target,
            signature: this.session.authority.sign(
                SignaturePurpose.DeviceUnpaired,
                Buffer.from(ConnectorUnpairCodec.payload(target)),
            ),
        };
        return this.#receipt;
    }

    /** Every test removes only its own generated identities and private folders. */
    public async [Symbol.asyncDispose](): Promise<void> {
        this.session[Symbol.dispose]();
        await rm(this.directory, { recursive: true, force: true });
    }
}
