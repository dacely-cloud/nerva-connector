// SPDX-FileCopyrightText: 2026 Dacely <business@dacely.com>
// SPDX-License-Identifier: LicenseRef-Proprietary

import { join } from 'node:path';
import { ConnectorEnrollmentCodec } from 'nerva-connector-protocol/protocol/ConnectorEnrollmentCodec.js';
import {
    SignatureSuite,
    type PublicIdentityRecord,
} from 'nerva-connector-protocol/identity/IdentityFormat.js';
import { ProtectedFiles } from '../local/ProtectedFiles.js';
import { ConnectorCloudConfiguration } from '../runtime/ConnectorCloudConfiguration.js';
import { ConnectorDeviceKey } from '../runtime/ConnectorDeviceKey.js';
import {
    ConnectorPairConfiguration,
    type ConnectorPairIdentity,
} from '../runtime/ConnectorPairConfiguration.js';
import { ConnectorSetupCodec } from '../runtime/ConnectorSetupCodec.js';
import { ConnectorSetupStore } from '../runtime/ConnectorSetupStore.js';
import {
    ConnectorSetupAccess,
    type ConnectorSetupPreferences,
    type ConnectorSetupProfile,
} from '../runtime/ConnectorSetupProfile.js';

/** Unattended answers to the setup questions; an omitted answer keeps the saved or default choice. */
export interface ConnectorSetupRequest {
    readonly name?: string;
    readonly folder?: string;
    readonly access?: ConnectorSetupAccess;
}

/**
 * The setup wizard's choices as command-line options, for installs that have no terminal to answer it.
 *
 * @remarks
 * Saves the name, task folder and access choice, prepares the cloud link configuration and creates the
 * device key, then reports only that key's public identity. It never pairs, opens a network connection,
 * prompts or grants access: the saved access level is a preference, exactly as after the wizard, and full
 * computer access still needs the separate `host-access` approval once the computer is linked. Repeating
 * the command with the same answers changes nothing and reports the same key.
 */
export class ConnectorSetupCommand {
    /** Each option appears at most once; files-only access needs a signed Linux installation and is refused here. */
    public static parse(args: readonly string[]): ConnectorSetupRequest {
        const values: Map<string, string> = new Map();
        for (let index: number = 1; index < args.length; index += 2) {
            const option: string | undefined = args[index];
            const value: string | undefined = args[index + 1];
            if (
                value === undefined ||
                option === undefined ||
                !['--name', '--folder', '--access'].includes(option) ||
                values.has(option)
            ) {
                throw new Error('Unknown, repeated or incomplete setup option');
            }
            values.set(option, value);
        }
        const name: string | undefined = values.get('--name');
        const folder: string | undefined = values.get('--folder');
        const access: ConnectorSetupAccess | undefined = [
            ConnectorSetupAccess.PairingOnly,
            ConnectorSetupAccess.FullComputer,
        ].find((choice: ConnectorSetupAccess): boolean => choice === values.get('--access'));
        if (values.has('--access') && access === undefined) {
            throw new Error('Setup access is pairing-only or full-computer');
        }
        return {
            ...(name === undefined ? {} : { name: ConnectorEnrollmentCodec.name(name) }),
            ...(folder === undefined ? {} : { folder: ConnectorSetupCodec.tasksDirectory(folder) }),
            ...(access === undefined ? {} : { access }),
        };
    }

    /**
     * Saves the answers and prepares an unlinked cloud identity in `directory`.
     *
     * @param directory - The connector's cloud state directory, as used by `nexa connector`
     * @returns The device's public identity; the private key never leaves its protected file
     */
    public static async run(
        directory: string,
        request: ConnectorSetupRequest,
        signal: AbortSignal,
    ): Promise<PublicIdentityRecord> {
        signal.throwIfAborted();
        await ProtectedFiles.createDirectory(directory);
        const previous: ConnectorSetupProfile | null = await ConnectorSetupStore.load(directory);
        const base: ConnectorSetupPreferences = previous ?? ConnectorSetupCodec.defaults();
        const preferences: ConnectorSetupPreferences = {
            name: request.name ?? base.name,
            tasksDirectory: request.folder ?? base.tasksDirectory,
            localInstructions: base.localInstructions,
            access: request.access ?? base.access,
        };
        if (
            previous === null ||
            previous.name !== preferences.name ||
            previous.tasksDirectory !== preferences.tasksDirectory ||
            previous.access !== preferences.access
        ) {
            await ConnectorSetupStore.save(
                directory,
                preferences,
                previous?.revision ?? 0n,
                signal,
            );
        }
        const pairingFile: string = await ConnectorCloudConfiguration.prepare(directory, signal);
        await ConnectorSetupStore.applyPairingName(pairingFile, preferences.name, signal);
        const pairing: ConnectorPairIdentity = await ConnectorPairConfiguration.load(pairingFile);
        signal.throwIfAborted();
        const publicKey: string = await ConnectorDeviceKey.initialize(
            join(pairing.settings.stateDirectory, 'device-key.json'),
        );
        return { suite: SignatureSuite.MlDsa44Ed25519, publicKey };
    }
}
