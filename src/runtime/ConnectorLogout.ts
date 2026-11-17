// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { ProtectedFiles } from '../local/ProtectedFiles.js';
import {
    SignaturePurpose,
    IdentityLengths,
} from 'nerva-connector-protocol/identity/IdentityFormat.js';
import { SigningKey } from '../identity/SigningKey.js';
import { Boundary } from 'nerva-connector-protocol/protocol/Boundary.js';
import { ConnectorEnrollmentCodec } from 'nerva-connector-protocol/protocol/ConnectorEnrollmentCodec.js';
import {
    ConnectorPairConfiguration,
    type ConnectorPairIdentity,
    type ConnectorPairSettings,
} from './ConnectorPairConfiguration.js';
import { ConnectorUnpairTransport } from './ConnectorUnpairTransport.js';
import { ConnectorRevocation } from './ConnectorRevocation.js';
import { ConnectorDeviceKey, type ConnectorDeviceIdentity } from './ConnectorDeviceKey.js';
import {
    ConnectorPrivateDirectory,
    ConnectorDirectoryPurpose,
} from './ConnectorPrivateDirectory.js';

enum ConnectorLogoutVersion {
    Current = 1,
}

/** A local signed retirement selects a fresh identity without rewriting the old operation journals or permissions. */
interface ConnectorLogoutRecord {
    readonly version: ConnectorLogoutVersion;
    readonly configurationSha256: string;
    readonly nextDirectory: string;
    readonly nextConfigurationSha256: string;
    readonly nextPublicKey: string;
    readonly signature: string;
}

/** Normal startup must never reuse a deliberately logged-out identity, including through an old explicit runtime path. */
export class ConnectorLoggedOut extends Error {
    public constructor() {
        super('This connector identity is logged out. Run nexa connector to pair again.');
    }
}

/** Logout removes the server pairing before selecting a fresh local identity, preserving retired journals. */
export class ConnectorLogout {
    /** Signed successor references are bounded and cannot change the deployment or inherit old capabilities. */
    public static async resolve(initial: string, signal: AbortSignal): Promise<string> {
        let current: string = initial;
        const visited: Set<string> = new Set();
        for (let count: number = 0; count < 1024; count++) {
            signal.throwIfAborted();
            const configuration: ConnectorPairIdentity =
                await ConnectorPairConfiguration.load(current);
            const directory: string = configuration.settings.stateDirectory;
            if (visited.has(directory)) {
                throw new Error('Connector logout history contains a cycle');
            }
            visited.add(directory);
            if (
                !(await ProtectedFiles.exists(join(directory, 'logout-state'))) &&
                (await ProtectedFiles.exists(join(directory, 'revoked-state')))
            ) {
                await this.#retireRevoked(configuration, signal);
            }
            if (!(await ProtectedFiles.exists(join(directory, 'logout-state')))) {
                return current;
            }
            await using owner: ConnectorPrivateDirectory = await ConnectorPrivateDirectory.open(
                directory,
                ConnectorDirectoryPurpose.Pairing,
            );
            const record: ConnectorLogoutRecord = this.#record(
                JSON.parse((await owner.read('logout-state', 16384)).toString('utf8')),
            );
            const identity: ConnectorDeviceIdentity = await ConnectorDeviceKey.load(
                join(directory, 'device-key.json'),
            );
            using key: SigningKey = identity.key;
            if (
                record.configurationSha256 !== configuration.configurationSha256 ||
                record.nextDirectory !== this.#next(configuration, key.publicKey) ||
                !SigningKey.verify(
                    SignaturePurpose.DeviceLogout,
                    key.publicKey,
                    this.#payload(record),
                    record.signature,
                )
            ) {
                throw new Error('Connector logout history changed its signed identity');
            }
            const nextFile: string = join(dirname(directory), record.nextDirectory, 'pairing.json');
            const next: ConnectorPairIdentity = await ConnectorPairConfiguration.load(nextFile);
            const nextKey: ConnectorDeviceIdentity = await ConnectorDeviceKey.load(
                join(next.settings.stateDirectory, 'device-key.json'),
            );
            using nextOwner: SigningKey = nextKey.key;
            if (
                next.configurationSha256 !== record.nextConfigurationSha256 ||
                nextOwner.publicKey !== record.nextPublicKey ||
                JSON.stringify(next.settings) !==
                    JSON.stringify(
                        this.#settings(
                            configuration,
                            join(dirname(directory), record.nextDirectory),
                        ),
                    )
            ) {
                throw new Error('Connector logout successor changed its deployment or permissions');
            }
            current = nextFile;
        }
        throw new Error('Connector logout history exceeds its inspection bound');
    }

    /** Acquire the same runtime and pairing owners as normal execution; a live service must stop before logout can commit. */
    public static async run(initial: string, signal: AbortSignal): Promise<string> {
        await using resources: AsyncDisposableStack = new AsyncDisposableStack();
        resources.use(
            await ConnectorPrivateDirectory.open(
                dirname(initial),
                ConnectorDirectoryPurpose.Installation,
            ),
        );
        const active: string = await this.resolve(initial, signal);
        const configuration: ConnectorPairIdentity = await ConnectorPairConfiguration.load(active);
        const source: string = configuration.settings.stateDirectory;
        resources.use(
            await ConnectorPrivateDirectory.open(source, ConnectorDirectoryPurpose.Runtime),
        );
        await using pairing: ConnectorPrivateDirectory = await ConnectorPrivateDirectory.open(
            source,
            ConnectorDirectoryPurpose.Pairing,
        );
        resources.use(
            await ConnectorPrivateDirectory.open(source, ConnectorDirectoryPurpose.Identity),
        );
        signal.throwIfAborted();
        const hasHistory: boolean =
            (await pairing.exists('pairing-state')) || (await pairing.exists('device.json'));
        if (!hasHistory) {
            return active;
        }
        if (!(await pairing.exists('device-key.json'))) {
            throw new Error(
                'Restore the saved connector identity before retiring its pairing history',
            );
        }
        await this.requireActive(source);
        const identity: ConnectorDeviceIdentity = await ConnectorDeviceKey.load(
            join(source, 'device-key.json'),
        );
        using key: SigningKey = identity.key;
        await ConnectorUnpairTransport.run(configuration, key, signal);
        return await this.#successor(configuration, pairing, key, signal);
    }

    static async #retireRevoked(
        configuration: ConnectorPairIdentity,
        signal: AbortSignal,
    ): Promise<void> {
        const source: string = configuration.settings.stateDirectory;
        await using resources: AsyncDisposableStack = new AsyncDisposableStack();
        resources.use(
            await ConnectorPrivateDirectory.open(source, ConnectorDirectoryPurpose.Runtime),
        );
        resources.use(
            await ConnectorPrivateDirectory.open(source, ConnectorDirectoryPurpose.Identity),
        );
        await using pairing: ConnectorPrivateDirectory = await ConnectorPrivateDirectory.open(
            source,
            ConnectorDirectoryPurpose.Pairing,
        );
        const device: ConnectorDeviceIdentity = await ConnectorDeviceKey.load(
            join(source, 'device-key.json'),
        );
        using key: SigningKey = device.key;
        ConnectorRevocation.verify(
            configuration.authority,
            key.publicKey,
            JSON.parse((await pairing.read('revoked-state', 16384)).toString('utf8')),
        );
        await this.#successor(configuration, pairing, key, signal);
    }

    static async #successor(
        configuration: ConnectorPairIdentity,
        pairing: ConnectorPrivateDirectory,
        key: SigningKey,
        signal: AbortSignal,
    ): Promise<string> {
        const source: string = configuration.settings.stateDirectory;
        signal.throwIfAborted();
        const nextDirectory: string = this.#next(configuration, key.publicKey);
        const destination: string = join(dirname(source), nextDirectory);
        await ProtectedFiles.createDirectory(destination);
        await using next: ConnectorPrivateDirectory = await ConnectorPrivateDirectory.open(
            destination,
            ConnectorDirectoryPurpose.Pairing,
        );
        const settings: ConnectorPairSettings = this.#settings(configuration, destination);
        const nextFile: string = next.file('pairing.json');
        await next.cleanPartial('pairing.json', 16384);
        if (!(await next.exists('pairing.json'))) {
            await next.write('pairing.json', Buffer.from(JSON.stringify(settings)), 16384, true);
        }
        const prepared: ConnectorPairIdentity = await ConnectorPairConfiguration.load(nextFile);
        if (JSON.stringify(prepared.settings) !== JSON.stringify(settings)) {
            throw new Error('Prepared logout successor changed its original intent');
        }
        const publicKey: string = await ConnectorDeviceKey.initialize(
            join(destination, 'device-key.json'),
        );
        const unsigned: Omit<ConnectorLogoutRecord, 'signature'> = {
            version: ConnectorLogoutVersion.Current,
            configurationSha256: configuration.configurationSha256,
            nextDirectory,
            nextConfigurationSha256: prepared.configurationSha256,
            nextPublicKey: publicKey,
        };
        const record: ConnectorLogoutRecord = {
            ...unsigned,
            signature: key.sign(SignaturePurpose.DeviceLogout, this.#payload(unsigned)),
        };
        signal.throwIfAborted();
        await pairing.cleanPartial('logout-state', 16384);
        await pairing.write('logout-state', Buffer.from(JSON.stringify(record)), 16384, true);
        return nextFile;
    }

    /** Existence is a fail-closed guard even when a retired record is corrupt or cannot be decoded. */
    public static async requireActive(directory: string): Promise<void> {
        if (
            (await ProtectedFiles.exists(join(directory, 'logout-state'))) ||
            (await ProtectedFiles.exists(join(directory, 'revoked-state')))
        ) {
            throw new ConnectorLoggedOut();
        }
    }

    static #next(configuration: ConnectorPairIdentity, publicKey: string): string {
        return (
            'identity-' +
            createHash('sha256')
                .update(
                    JSON.stringify([
                        configuration.configurationSha256,
                        publicKey,
                        SignaturePurpose.DeviceLogout,
                    ]),
                )
                .digest('hex')
        );
    }

    static #settings(
        configuration: ConnectorPairIdentity,
        directory: string,
    ): ConnectorPairSettings {
        return {
            ...configuration.settings,
            stateDirectory: directory,
            files: null,
            execution: null,
        };
    }

    static #payload(record: Omit<ConnectorLogoutRecord, 'signature'>): Buffer {
        return Buffer.from(
            JSON.stringify([
                record.version,
                record.configurationSha256,
                record.nextDirectory,
                record.nextConfigurationSha256,
                record.nextPublicKey,
            ]),
        );
    }

    static #record(raw: unknown): ConnectorLogoutRecord {
        const value: Readonly<Record<string, unknown>> = Boundary.record(raw, [
            'version',
            'configurationSha256',
            'nextDirectory',
            'nextConfigurationSha256',
            'nextPublicKey',
            'signature',
        ]);
        const directory: string = Boundary.id(value['nextDirectory']);
        if (
            value['version'] !== ConnectorLogoutVersion.Current ||
            !/^identity-[a-f0-9]{64}$/u.test(directory)
        ) {
            throw new Error('Invalid connector logout record');
        }
        return {
            version: ConnectorLogoutVersion.Current,
            configurationSha256: ConnectorEnrollmentCodec.digest(value['configurationSha256']),
            nextDirectory: directory,
            nextConfigurationSha256: ConnectorEnrollmentCodec.digest(
                value['nextConfigurationSha256'],
            ),
            nextPublicKey: ConnectorEnrollmentCodec.binary(
                value['nextPublicKey'],
                IdentityLengths.publicKey,
            ),
            signature: ConnectorEnrollmentCodec.binary(
                value['signature'],
                IdentityLengths.signature,
            ),
        };
    }
}
