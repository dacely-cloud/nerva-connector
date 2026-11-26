// SPDX-FileCopyrightText: 2026 Dacely <business@dacely.com>
// SPDX-License-Identifier: LicenseRef-Proprietary

import { join } from 'node:path';
import { ConnectorSetupStore } from './ConnectorSetupStore.js';
import { ConnectorLogout } from './ConnectorLogout.js';
import { hostname, homedir } from 'node:os';
import { ProtectedFiles } from '../local/ProtectedFiles.js';
import { SignatureSuite } from 'nerva-connector-protocol/identity/IdentityFormat.js';
import { ConnectorInstallation } from '../install/ConnectorInstallation.js';
import { ConnectorCloudAuthority } from './ConnectorCloudAuthority.js';
import { WindowsStateOwner } from '../windows/WindowsStateOwner.js';
import {
    WindowsStateOperation,
    WindowsStateError,
    WindowsStateFailure,
    type WindowsStateResponse,
} from '../windows/WindowsStateProtocol.js';
import {
    ConnectorClientConfiguration,
    type ConnectorClientIdentity,
} from './ConnectorClientConfiguration.js';
import { ConnectorAuthorityPin, type ConnectorTrustedAuthority } from './ConnectorAuthorityPin.js';
import {
    ConnectorPairConfiguration,
    type ConnectorPairIdentity,
    type ConnectorPairSettings,
} from './ConnectorPairConfiguration.js';
import {
    ConnectorDirectoryPurpose,
    ConnectorPrivateDirectory,
} from './ConnectorPrivateDirectory.js';

/** Source and standalone app startup install public cloud settings without borrowing any controller credential. */
export class ConnectorCloudConfiguration {
    /** Windows uses its verified Known Folder; an existing identity at the former failed setup location is never abandoned. */
    public static async defaultDirectory(): Promise<string> {
        if (process.platform !== 'win32') {
            return join(homedir(), '.local/share/nerva-connector');
        }
        const result: WindowsStateResponse = await WindowsStateOwner.request(
            WindowsStateOperation.Root,
        );
        if (result.path === null) {
            throw new WindowsStateError(WindowsStateFailure.Invalid);
        }
        return result.path;
    }
    /** Existing signed installations retain their exact trust; incomplete or changed state is rejected rather than reset. */
    public static async prepare(directory: string, signal: AbortSignal): Promise<string> {
        signal.throwIfAborted();
        await ProtectedFiles.createDirectory(directory);
        await using owner: ConnectorPrivateDirectory = await ConnectorPrivateDirectory.open(
            directory,
            ConnectorDirectoryPurpose.Installation,
        );
        if (await owner.exists('ready.json')) {
            return (await ConnectorInstallation.read(directory, signal)).pairingFile;
        }
        const allowed: ReadonlySet<string> = new Set([
            'authority-public.json',
            'authority-public.json.partial',
            'pairing.json',
            'pairing.json.partial',
            'state',
            'preferences',
        ]);
        if (
            (await owner.list()).some(
                (name: string): boolean =>
                    !allowed.has(name) && !/^identity-[a-f0-9]{64}$/u.test(name),
            )
        ) {
            throw new Error('Existing connector installation is incomplete or unrecognized');
        }
        const paired: boolean = await owner.exists('pairing.json');
        const authorityExists: boolean = await owner.exists('authority-public.json');
        if (paired && !authorityExists) {
            throw new Error('Existing connector authority is missing');
        }
        const stateDirectory: string = join(directory, 'state');
        if (!paired) {
            await ProtectedFiles.createDirectory(stateDirectory);
            if ((await ProtectedFiles.listDirectory(stateDirectory)).length !== 0) {
                throw new Error(
                    'Existing device history requires its original pairing configuration',
                );
            }
        }
        if (authorityExists) {
            const authority: ConnectorTrustedAuthority = await ConnectorAuthorityPin.load(
                ConnectorCloudAuthority.id,
                owner.file('authority-public.json'),
            );
            if (authority.publicKey !== ConnectorCloudAuthority.publicKey) {
                throw new Error('Existing cloud connector authority changed');
            }
        } else {
            await owner.cleanPartial('authority-public.json', 16384);
            await owner.write(
                'authority-public.json',
                Buffer.from(
                    JSON.stringify({
                        suite: SignatureSuite.MlDsa44Ed25519,
                        publicKey: ConnectorCloudAuthority.publicKey,
                    }),
                ),
                16384,
                true,
            );
        }
        const pairingFile: string = owner.file('pairing.json');
        if (!paired) {
            const settings: ConnectorPairSettings = {
                authorityId: ConnectorCloudAuthority.id,
                authorityPublicKeyFile: owner.file('authority-public.json'),
                stateDirectory,
                endpoints: [ConnectorCloudAuthority.endpoint],
                verificationUri: ConnectorCloudAuthority.verificationUri,
                deviceName:
                    (await ConnectorSetupStore.load(directory))?.name ??
                    (hostname().slice(0, 128) || 'My computer'),
                serverCaFile: null,
                files: null,
                execution: null,
            };
            await owner.cleanPartial('pairing.json', 16384);
            signal.throwIfAborted();
            await owner.write('pairing.json', Buffer.from(JSON.stringify(settings)), 16384, true);
        }
        const active: ConnectorPairIdentity = await this.#read(directory, signal);
        signal.throwIfAborted();
        return active.settings.stateDirectory === stateDirectory
            ? pairingFile
            : join(active.settings.stateDirectory, 'pairing.json');
    }

    /** Local status never starts pairing or claims current connectivity; verified revocation may retire its saved identity. */
    public static async status(directory: string, signal: AbortSignal): Promise<string> {
        try {
            await ProtectedFiles.directory(directory);
        } catch (caught: unknown) {
            if (caught instanceof Error && 'code' in caught && caught.code === 'ENOENT') {
                return 'Not set up. Run nexa connector to link this machine.\n';
            }
            throw caught;
        }
        if (await this.#exists(join(directory, 'ready.json'))) {
            const enrolled: boolean = (await ConnectorInstallation.read(directory, signal))
                .enrolled;
            return enrolled
                ? this.#linked()
                : 'Machine is not linked. Run nexa connector to pair it.\n';
        }
        const pairing: ConnectorPairIdentity = await this.#read(directory, signal);
        const runtimeFile: string = join(pairing.settings.stateDirectory, 'device.json');
        if (!(await this.#exists(runtimeFile))) {
            return 'Machine is not linked. Run nexa connector to pair it.\n';
        }
        const runtime: ConnectorClientIdentity =
            await ConnectorClientConfiguration.load(runtimeFile);
        using resources: DisposableStack = new DisposableStack();
        resources.use(runtime.key);
        if (
            runtime.authority.publicKey !== pairing.authority.publicKey ||
            runtime.settings.authorityId !== pairing.settings.authorityId ||
            runtime.settings.authorityPublicKeyFile !== pairing.settings.authorityPublicKeyFile ||
            runtime.settings.privateKeyFile !==
                join(pairing.settings.stateDirectory, 'device-key.json') ||
            JSON.stringify(runtime.settings.endpoints) !==
                JSON.stringify(pairing.settings.endpoints)
        ) {
            throw new Error('Existing cloud runtime configuration changed');
        }
        signal.throwIfAborted();
        return this.#linked();
    }

    static async #read(directory: string, signal: AbortSignal): Promise<ConnectorPairIdentity> {
        const identity: ConnectorPairIdentity = await ConnectorPairConfiguration.load(
            join(directory, 'pairing.json'),
        );
        const settings: ConnectorPairSettings = identity.settings;
        if (
            settings.authorityId !== ConnectorCloudAuthority.id ||
            settings.authorityPublicKeyFile !== join(directory, 'authority-public.json') ||
            identity.authority.publicKey !== ConnectorCloudAuthority.publicKey ||
            settings.stateDirectory !== join(directory, 'state') ||
            settings.endpoints.length !== 1 ||
            settings.endpoints[0] !== ConnectorCloudAuthority.endpoint ||
            settings.verificationUri !== ConnectorCloudAuthority.verificationUri ||
            settings.serverCaFile !== null ||
            settings.files !== null ||
            settings.execution !== null
        ) {
            throw new Error('Existing cloud connector configuration changed');
        }
        return await ConnectorPairConfiguration.load(
            await ConnectorLogout.resolve(join(directory, 'pairing.json'), signal),
        );
    }

    static #linked(): string {
        return 'Machine linked. Enrollment is saved; connectivity is confirmed when the connector runs.\n';
    }

    static async #exists(path: string): Promise<boolean> {
        return await ProtectedFiles.exists(path);
    }
}
