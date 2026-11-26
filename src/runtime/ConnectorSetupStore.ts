// SPDX-FileCopyrightText: 2026 Dacely <business@dacely.com>
// SPDX-License-Identifier: LicenseRef-Proprietary

import type { BigIntStats } from 'node:fs';
import { lstat, mkdir, realpath, rmdir } from 'node:fs/promises';
import { dirname, join, basename } from 'node:path';
import {
    ConnectorPairConfiguration,
    type ConnectorPairIdentity,
} from './ConnectorPairConfiguration.js';
import { ProtectedFiles } from '../local/ProtectedFiles.js';
import { ConnectorSetupCodec } from './ConnectorSetupCodec.js';
import type { ConnectorSetupPreferences, ConnectorSetupProfile } from './ConnectorSetupProfile.js';
import {
    ConnectorPrivateDirectory,
    ConnectorDirectoryPurpose,
} from './ConnectorPrivateDirectory.js';

/** Protected setup persistence reuses the existing Linux lock and Windows SID/DACL native state owner. */
export class ConnectorSetupStore {
    static readonly #file: string = 'setup.json';
    static readonly #maximumBytes: number = 65536;

    /** Read-only inspection creates no directory, file, grant or device identity. */
    public static async load(directory: string): Promise<ConnectorSetupProfile | null> {
        const path: string = join(directory, 'preferences', this.#file);
        if (!(await ProtectedFiles.exists(path))) {
            return null;
        }
        const profile: ConnectorSetupProfile = ConnectorSetupCodec.read(
            JSON.parse(
                new TextDecoder('utf-8', { fatal: true }).decode(
                    await ProtectedFiles.readPrivate(path, this.#maximumBytes),
                ),
            ),
        );
        ConnectorSetupCodec.distinct(profile.tasksDirectory, directory);
        return profile;
    }

    /** Only a reviewed local save creates the task folder; interrupted setup removes its own empty partial directories. */
    public static async save(
        directory: string,
        preferences: ConnectorSetupPreferences,
        expectedRevision: bigint,
        signal: AbortSignal,
    ): Promise<ConnectorSetupProfile> {
        signal.throwIfAborted();
        const profile: ConnectorSetupProfile = ConnectorSetupCodec.read(
            JSON.parse(
                ConnectorSetupCodec.encode({ ...preferences, revision: expectedRevision + 1n }),
            ),
        );
        ConnectorSetupCodec.distinct(profile.tasksDirectory, directory);
        const taskPath: string = await this.#canonical(profile.tasksDirectory);
        if (taskPath !== profile.tasksDirectory) {
            throw new Error(
                'Task directory resolves through a symbolic link; choose its actual path',
            );
        }
        const preferencesDirectory: string = join(directory, 'preferences');
        const firstCreatedPreferences: string | null =
            await this.#firstMissing(preferencesDirectory);
        let createdTasks: string | undefined;
        try {
            await ProtectedFiles.createDirectory(preferencesDirectory);
            await using owner: ConnectorPrivateDirectory = await ConnectorPrivateDirectory.open(
                preferencesDirectory,
                ConnectorDirectoryPurpose.Installation,
            );
            const previous: ConnectorSetupProfile | null = (await owner.exists(this.#file))
                ? ConnectorSetupCodec.read(
                      JSON.parse(
                          new TextDecoder('utf-8', { fatal: true }).decode(
                              await owner.read(this.#file, this.#maximumBytes),
                          ),
                      ),
                  )
                : null;
            if ((previous?.revision ?? 0n) !== expectedRevision) {
                throw new Error('Connector setup changed; reopen /settings before saving');
            }
            signal.throwIfAborted();
            createdTasks = await mkdir(profile.tasksDirectory, { recursive: true, mode: 0o700 });
            const status: BigIntStats = await lstat(profile.tasksDirectory, { bigint: true });
            if (
                !status.isDirectory() ||
                (await realpath(profile.tasksDirectory)) !== profile.tasksDirectory
            ) {
                throw new Error('The chosen task directory is unavailable or changed');
            }
            await owner.cleanPartial(this.#file, this.#maximumBytes);
            signal.throwIfAborted();
            await owner.write(
                this.#file,
                Buffer.from(ConnectorSetupCodec.encode(profile)),
                this.#maximumBytes,
                previous === null,
            );
            return profile;
        } catch (caught: unknown) {
            let saved: ConnectorSetupProfile | null;
            try {
                saved = await this.load(directory);
            } catch {
                throw caught;
            }
            if (
                createdTasks !== undefined &&
                (saved?.revision !== profile.revision ||
                    saved.tasksDirectory !== profile.tasksDirectory)
            ) {
                await this.#removeEmpty(profile.tasksDirectory, createdTasks);
            }
            if (firstCreatedPreferences !== null) {
                await this.#removeEmpty(preferencesDirectory, firstCreatedPreferences);
            }
            throw caught;
        }
    }

    /** A chosen name applies only before the first pairing request; retained linking and enrolled identities remain unchanged. */
    public static async applyPairingName(
        pairingFile: string,
        name: string,
        signal: AbortSignal,
    ): Promise<void> {
        const identity: ConnectorPairIdentity = await ConnectorPairConfiguration.load(pairingFile);
        if (
            (await ProtectedFiles.exists(
                join(identity.settings.stateDirectory, 'pairing-state'),
            )) ||
            (await ProtectedFiles.exists(join(identity.settings.stateDirectory, 'device.json'))) ||
            identity.settings.deviceName === name
        ) {
            return;
        }
        await using owner: ConnectorPrivateDirectory = await ConnectorPrivateDirectory.open(
            dirname(pairingFile),
            ConnectorDirectoryPurpose.Installation,
        );
        const current: ConnectorPairIdentity = await ConnectorPairConfiguration.load(pairingFile);
        if (
            (await ProtectedFiles.exists(join(current.settings.stateDirectory, 'pairing-state'))) ||
            (await ProtectedFiles.exists(join(current.settings.stateDirectory, 'device.json')))
        ) {
            return;
        }
        signal.throwIfAborted();
        await owner.cleanPartial(basename(pairingFile), 16384);
        await owner.write(
            basename(pairingFile),
            Buffer.from(JSON.stringify({ ...current.settings, deviceName: name })),
            16384,
            false,
        );
    }

    static async #firstMissing(path: string): Promise<string | null> {
        try {
            await lstat(path);
            return null;
        } catch (caught: unknown) {
            if (!(caught instanceof Error) || !('code' in caught) || caught.code !== 'ENOENT') {
                throw caught;
            }
            return (await this.#firstMissing(dirname(path))) ?? path;
        }
    }

    static async #canonical(path: string): Promise<string> {
        try {
            return await realpath(path);
        } catch (caught: unknown) {
            if (!(caught instanceof Error) || !('code' in caught) || caught.code !== 'ENOENT') {
                throw caught;
            }
            const parent: string = dirname(path);
            return join(
                await this.#canonical(parent),
                path.slice(parent.length + (parent.endsWith('/') || parent.endsWith('\\') ? 0 : 1)),
            );
        }
    }

    static async #removeEmpty(path: string, firstCreated: string): Promise<void> {
        let current: string = path;
        while (true) {
            try {
                await rmdir(current);
            } catch {
                return;
            }
            if (current === firstCreated) {
                return;
            }
            current = dirname(current);
        }
    }
}
