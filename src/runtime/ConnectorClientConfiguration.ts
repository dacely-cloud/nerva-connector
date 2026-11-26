// SPDX-FileCopyrightText: 2026 Dacely <business@dacely.com>
// SPDX-License-Identifier: LicenseRef-Proprietary

import { ConnectorAuthorityPin, type ConnectorTrustedAuthority } from './ConnectorAuthorityPin.js';
import type { SigningKey } from '../identity/SigningKey.js';
import { Boundary } from 'nerva-connector-protocol/protocol/Boundary.js';
import { ConnectorDeviceCodec } from 'nerva-connector-protocol/protocol/ConnectorDeviceCodec.js';
import { ConnectorEnrollmentCodec } from 'nerva-connector-protocol/protocol/ConnectorEnrollmentCodec.js';
import { ConnectorConnectionConfiguration } from './ConnectorConnectionConfiguration.js';
import { ProtectedFiles } from '../local/ProtectedFiles.js';
import { ConnectorDeviceKey, type ConnectorDeviceIdentity } from './ConnectorDeviceKey.js';
import type { ConnectorClientSettings } from './ConnectorClientSettings.js';

/** Loaded device identity and local references remain in this standalone process. */
export interface ConnectorClientIdentity {
    readonly configurationFile: string;
    readonly settings: ConnectorClientSettings;
    readonly key: SigningKey;
    readonly publicKey: string;
    readonly ca: Buffer | undefined;
    readonly authority: ConnectorTrustedAuthority;
}

/** One current protected configuration supplies only device-held identity, outbound endpoints and explicit local grants. */
export class ConnectorClientConfiguration {
    /** Parse and validate all external fields before opening a socket or file capability. */
    public static async load(path: string): Promise<ConnectorClientIdentity> {
        const raw: unknown = JSON.parse(
            new TextDecoder('utf-8', { fatal: true }).decode(
                await ProtectedFiles.readPrivate(path, 16384),
            ),
        );
        const value: Readonly<Record<string, unknown>> = Boundary.record(raw, [
            'authorityId',
            'authorityPublicKeyFile',
            'environmentId',
            'enrollmentId',
            'slot',
            'endpoints',
            'privateKeyFile',
            'serverCaFile',
            'files',
            'execution',
        ]);
        const endpoints: readonly string[] = ConnectorConnectionConfiguration.endpoints(
            value['endpoints'],
        );
        const settings: ConnectorClientSettings = {
            authorityId: Boundary.id(value['authorityId']),
            authorityPublicKeyFile: ProtectedFiles.path(value['authorityPublicKeyFile']),
            environmentId: Boundary.id(value['environmentId']),
            enrollmentId: ConnectorEnrollmentCodec.id(value['enrollmentId']),
            slot: ConnectorDeviceCodec.slot(value['slot']),
            endpoints,
            privateKeyFile: ProtectedFiles.path(value['privateKeyFile']),
            serverCaFile:
                value['serverCaFile'] === null ? null : ProtectedFiles.path(value['serverCaFile']),
            files: ConnectorConnectionConfiguration.capability(value['files']),
            execution: ConnectorConnectionConfiguration.capability(value['execution']),
        };
        if (
            (process.platform === 'win32' || process.platform === 'darwin') &&
            (settings.files !== null || settings.execution !== null)
        ) {
            throw new Error('File and command capabilities require the Linux connector');
        }
        if ((settings.files !== null || settings.execution !== null) && settings.slot !== 0) {
            throw new Error('Connector capabilities require the dedicated slot zero');
        }
        const ca: Buffer | undefined =
            settings.serverCaFile === null
                ? undefined
                : await ProtectedFiles.readTrusted(settings.serverCaFile, 65536, false);
        const authority: ConnectorTrustedAuthority = await ConnectorAuthorityPin.load(
            settings.authorityId,
            settings.authorityPublicKeyFile,
        );
        const identity: ConnectorDeviceIdentity = await ConnectorDeviceKey.load(
            settings.privateKeyFile,
        );
        Object.freeze(settings.endpoints);
        Object.freeze(settings.files);
        Object.freeze(settings.execution);
        Object.freeze(settings);
        return {
            configurationFile: path,
            settings,
            key: identity.key,
            publicKey: identity.publicKey,
            ca,
            authority,
        };
    }
}
