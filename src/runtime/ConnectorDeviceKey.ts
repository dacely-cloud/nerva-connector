// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

import { SigningKey } from '../identity/SigningKey.js';
import { IdentityLengths } from 'nerva-connector-protocol/identity/IdentityFormat.js';
import type { BigIntStats } from 'node:fs';
import { lstat } from 'node:fs/promises';
import { dirname, basename, resolve } from 'node:path';
import {
    ConnectorPrivateDirectory,
    ConnectorDirectoryPurpose,
} from './ConnectorPrivateDirectory.js';
import { ProtectedFiles } from '../local/ProtectedFiles.js';
import { WindowsStateError, WindowsStateFailure } from '../windows/WindowsStateProtocol.js';

/** Only the local connector process receives its loaded signing key; initialization reports public identity alone. */
export interface ConnectorDeviceIdentity {
    readonly key: SigningKey;
    readonly publicKey: string;
}

/** The persisted key is published durably before any registration request; retries never generate a replacement identity. */
export class ConnectorDeviceKey {
    /** Canonical protected single-link files contain exactly the supported private-key algorithm. */
    public static async load(path: string): Promise<ConnectorDeviceIdentity> {
        this.#windowsName(path);
        const bytes: Buffer = await ProtectedFiles.readPrivate(path, IdentityLengths.privateRecord);
        let key: SigningKey | null = null;
        try {
            key = SigningKey.decode(bytes);
            if (process.platform !== 'win32') {
                const status: BigIntStats = await lstat(path, { bigint: true });
                if (status.nlink !== 1n || !status.isFile()) {
                    throw new Error('Connector identity must be a regular single-link file');
                }
            }
            return { key, publicKey: key.publicKey };
        } catch (caught: unknown) {
            key?.[Symbol.dispose]();
            throw caught;
        } finally {
            bytes.fill(0);
        }
    }

    /** An explicit Linux, macOS or Windows installation owns one canonical private parent and kernel lock; it preserves existing valid keys and rejects corrupt identities. */
    public static async initialize(path: string): Promise<string> {
        this.#windowsName(path);
        if (
            (process.platform !== 'linux' &&
                process.platform !== 'darwin' &&
                process.platform !== 'win32') ||
            resolve(ProtectedFiles.path(path)) !== path
        ) {
            throw new Error(
                'Connector identity initialization requires a qualified canonical state owner',
            );
        }
        await using directory: ConnectorPrivateDirectory = await ConnectorPrivateDirectory.open(
            dirname(path),
            ConnectorDirectoryPurpose.Identity,
        );
        const name: string = basename(path);
        await directory.cleanPartial(name, IdentityLengths.privateRecord);
        if (!(await directory.exists(name))) {
            using key: SigningKey = SigningKey.generate();
            const bytes: Buffer = key.encode();
            try {
                await directory.write(name, bytes, IdentityLengths.privateRecord, true);
            } finally {
                bytes.fill(0);
            }
        }
        const identity: ConnectorDeviceIdentity = await this.load(path);
        using key: SigningKey = identity.key;
        return key.publicKey;
    }

    static #windowsName(path: string): void {
        if (process.platform === 'win32' && basename(path).toLowerCase() !== 'device-key.json') {
            throw new WindowsStateError(WindowsStateFailure.Invalid);
        }
    }
}
