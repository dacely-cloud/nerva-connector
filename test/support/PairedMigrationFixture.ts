// SPDX-FileCopyrightText: 2026 Dacely <business@dacely.com>
// SPDX-License-Identifier: LicenseRef-Proprietary

import { randomUUID } from 'node:crypto';
import { lstat, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { BigIntStats } from 'node:fs';
import { SigningKey } from '../../src/identity/SigningKey.js';
import { SignatureSuite } from 'nerva-connector-protocol/identity/IdentityFormat.js';
import { ProtectedFiles } from '../../src/local/ProtectedFiles.js';
import { ConnectorDeviceKey } from '../../src/runtime/ConnectorDeviceKey.js';
import {
    ConnectorClientConfiguration,
    type ConnectorClientIdentity,
} from '../../src/runtime/ConnectorClientConfiguration.js';
import type { ConnectorClientSettings } from '../../src/runtime/ConnectorClientSettings.js';
import {
    ConnectorPrivateDirectory,
    ConnectorDirectoryPurpose,
} from '../../src/runtime/ConnectorPrivateDirectory.js';
import { WindowsStateOwner } from '../../src/windows/WindowsStateOwner.js';
import {
    WindowsStateOperation,
    type WindowsStateResponse,
} from '../../src/windows/WindowsStateProtocol.js';

/** Finite test identity uses the actual native Windows DPAPI owner or Linux directory owner, with no local operation grants. */
export class PairedMigrationFixture implements AsyncDisposable {
    readonly #resources: AsyncDisposableStack;

    private constructor(
        resources: AsyncDisposableStack,
        public readonly directory: ConnectorPrivateDirectory,
        public readonly identity: ConnectorClientIdentity,
        public readonly authority: SigningKey,
    ) {
        this.#resources = resources;
    }

    /** Separate synthetic device/authority keys cannot exercise real backend fencing or grant access to any customer machine. */
    public static async create(): Promise<PairedMigrationFixture> {
        await using resources: AsyncDisposableStack = new AsyncDisposableStack();
        let parent: string = homedir();
        if (process.platform === 'win32') {
            const root: WindowsStateResponse = await WindowsStateOwner.request(
                WindowsStateOperation.Root,
            );
            if (root.path === null) {
                throw new Error('Native Windows state root required');
            }
            parent = root.path;
        }
        const path: string = join(parent, '.nerva-paired-migration-' + randomUUID());
        await ProtectedFiles.createDirectory(path);
        const captured: BigIntStats = await lstat(path, { bigint: true });
        resources.defer(async (): Promise<void> => {
            const current: BigIntStats = await lstat(path, { bigint: true });
            if (
                !current.isDirectory() ||
                current.dev !== captured.dev ||
                current.ino !== captured.ino
            ) {
                throw new Error('Owned paired-migration fixture directory changed');
            }
            await rm(path, { recursive: true, force: false });
        });
        const directory: ConnectorPrivateDirectory = resources.use(
            await ConnectorPrivateDirectory.open(path, ConnectorDirectoryPurpose.Installation),
        );
        const authority: SigningKey = resources.use(SigningKey.generate());
        const privateKeyFile: string = directory.file('device-key.json');
        await ConnectorDeviceKey.initialize(privateKeyFile);
        await directory.write(
            'authority.json',
            Buffer.from(
                JSON.stringify({
                    suite: SignatureSuite.MlDsa44Ed25519,
                    publicKey: authority.publicKey,
                }),
            ),
            16384,
            true,
        );
        const settings: ConnectorClientSettings = {
            authorityId: 'paired-migration-fixture',
            authorityPublicKeyFile: directory.file('authority.json'),
            environmentId: 'paired-migration-environment',
            enrollmentId: 'conn_' + 'a'.repeat(64),
            slot: 0,
            endpoints: ['wss://paired-migration.invalid/v1/connector/tunnel'],
            privateKeyFile,
            serverCaFile: null,
            files: null,
            execution: null,
        };
        const configurationFile: string = directory.file('device.json');
        await directory.write('device.json', Buffer.from(JSON.stringify(settings)), 16384, true);
        const identity: ConnectorClientIdentity =
            await ConnectorClientConfiguration.load(configurationFile);
        resources.use(identity.key);
        return new PairedMigrationFixture(resources.move(), directory, identity, authority);
    }

    /** Loaded keys and native locks close before the captured fixture directory is removed. */
    public async [Symbol.asyncDispose](): Promise<void> {
        await this.#resources[Symbol.asyncDispose]();
    }
}
