// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

import { dirname } from 'node:path';
import {
    ConnectorClientConfiguration,
    type ConnectorClientIdentity,
} from './ConnectorClientConfiguration.js';
import {
    ConnectorPrivateDirectory,
    ConnectorDirectoryPurpose,
} from './ConnectorPrivateDirectory.js';
import { ConnectorMigrationPlatform } from './ConnectorMigrationPlatform.js';

/** Stopped preparation and conversion share the same installation, pairing and execution-container locks. */
export class ConnectorMigrationInstallation implements AsyncDisposable {
    readonly #resources: AsyncDisposableStack;
    private constructor(
        resources: AsyncDisposableStack,
        public readonly identity: ConnectorClientIdentity,
        public readonly runtime: ConnectorPrivateDirectory,
    ) {
        this.#resources = resources;
    }

    /** No policy, native command, profile, network session or replacement journal is initialized. */
    public static async open(path: string): Promise<ConnectorMigrationInstallation> {
        const resources: AsyncDisposableStack = new AsyncDisposableStack();
        try {
            const identity: ConnectorClientIdentity = await ConnectorClientConfiguration.load(path);
            resources.use(identity.key);
            ConnectorMigrationPlatform.validate(process.platform, identity.settings);
            const runtime: ConnectorPrivateDirectory = resources.use(
                await ConnectorPrivateDirectory.open(
                    dirname(identity.settings.privateKeyFile),
                    ConnectorDirectoryPurpose.Runtime,
                ),
            );
            resources.use(
                await ConnectorPrivateDirectory.open(
                    dirname(identity.settings.privateKeyFile),
                    ConnectorDirectoryPurpose.Pairing,
                ),
            );
            const current: ConnectorClientIdentity = await ConnectorClientConfiguration.load(path);
            resources.use(current.key);
            if (
                identity.publicKey !== current.publicKey ||
                identity.authority.publicKey !== current.authority.publicKey ||
                JSON.stringify(identity.settings) !== JSON.stringify(current.settings) ||
                identity.settings.slot !== 0
            ) {
                throw new Error('Stopped migration installation changed while acquiring ownership');
            }
            if (identity.settings.execution !== null) {
                resources.use(
                    await ConnectorPrivateDirectory.open(
                        identity.settings.execution.stateDirectory,
                        ConnectorDirectoryPurpose.Execution,
                    ),
                );
            }
            return new ConnectorMigrationInstallation(resources, identity, runtime);
        } catch (caught: unknown) {
            await resources[Symbol.asyncDispose]();
            throw caught;
        }
    }

    /** Every configured journal stays locked until preparation or conversion has completely joined. */
    public own<T extends AsyncDisposable>(resource: T): T {
        return this.#resources.use(resource);
    }

    /** All keys and kernel locks outlive the finite migration operation and close together. */
    public async [Symbol.asyncDispose](): Promise<void> {
        await this.#resources[Symbol.asyncDispose]();
    }
}
