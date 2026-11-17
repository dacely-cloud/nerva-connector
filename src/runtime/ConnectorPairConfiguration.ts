// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

import { ConnectorAuthorityPin, type ConnectorTrustedAuthority } from './ConnectorAuthorityPin.js';
import { createHash } from 'node:crypto';
import { Boundary } from 'nerva-connector-protocol/protocol/Boundary.js';
import { ConnectorEnrollmentCodec } from 'nerva-connector-protocol/protocol/ConnectorEnrollmentCodec.js';
import { ProtectedFiles } from '../local/ProtectedFiles.js';
import { ConnectorConnectionConfiguration } from './ConnectorConnectionConfiguration.js';
import type { ConnectorLocalCapabilitySettings } from './ConnectorClientSettings.js';

/** The installer supplies reviewed cloud/enterprise endpoints and UI URI, never account credentials or a human-generated bearer secret. */
export interface ConnectorPairSettings {
    readonly authorityId: string;
    readonly authorityPublicKeyFile: string;
    readonly stateDirectory: string;
    readonly endpoints: readonly string[];
    readonly verificationUri: string;
    readonly deviceName: string;
    readonly serverCaFile: string | null;
    readonly files: ConnectorLocalCapabilitySettings | null;
    readonly execution: ConnectorLocalCapabilitySettings | null;
}
/** Loaded trust and stable canonical configuration commitment are retained only by the local pairing owner. */
export interface ConnectorPairIdentity {
    readonly settings: ConnectorPairSettings;
    readonly configurationSha256: string;
    readonly ca: Buffer | undefined;
    readonly authority: ConnectorTrustedAuthority;
}
/** One current bootstrap configuration prints a trusted UI URI and cannot target a caller-selected private account or host. */
export class ConnectorPairConfiguration {
    /** All external fields are decoded before key generation, state publication or network access. */
    public static async load(path: string): Promise<ConnectorPairIdentity> {
        const raw: unknown = JSON.parse(
            new TextDecoder('utf-8', { fatal: true }).decode(
                await ProtectedFiles.readPrivate(path, 16384),
            ),
        );
        const value: Readonly<Record<string, unknown>> = Boundary.record(raw, [
            'authorityId',
            'authorityPublicKeyFile',
            'stateDirectory',
            'endpoints',
            'verificationUri',
            'deviceName',
            'serverCaFile',
            'files',
            'execution',
        ]);
        const uri: URL = new URL(Boundary.text(value['verificationUri']));
        if (
            uri.protocol !== 'https:' ||
            uri.username !== '' ||
            uri.password !== '' ||
            uri.search !== '' ||
            uri.hash !== ''
        ) {
            throw new Error(
                'Connector verification URI must be an explicitly trusted HTTPS UI page',
            );
        }
        const settings: ConnectorPairSettings = Object.freeze({
            authorityId: Boundary.id(value['authorityId']),
            authorityPublicKeyFile: ProtectedFiles.path(value['authorityPublicKeyFile']),
            stateDirectory: ProtectedFiles.path(value['stateDirectory']),
            endpoints: ConnectorConnectionConfiguration.endpoints(value['endpoints']),
            verificationUri: uri.href,
            deviceName: ConnectorEnrollmentCodec.name(value['deviceName']),
            serverCaFile:
                value['serverCaFile'] === null ? null : ProtectedFiles.path(value['serverCaFile']),
            files: ConnectorConnectionConfiguration.capability(value['files']),
            execution: ConnectorConnectionConfiguration.capability(value['execution']),
        });
        if (
            (process.platform === 'win32' || process.platform === 'darwin') &&
            (settings.files !== null || settings.execution !== null)
        ) {
            throw new Error('File and command capabilities require the Linux connector');
        }
        const authority: ConnectorTrustedAuthority = await ConnectorAuthorityPin.load(
            settings.authorityId,
            settings.authorityPublicKeyFile,
        );
        await ProtectedFiles.directory(settings.stateDirectory);
        return {
            settings,
            authority,
            configurationSha256: createHash('sha256')
                .update(JSON.stringify([settings, authority]))
                .digest('hex'),
            ca:
                settings.serverCaFile === null
                    ? undefined
                    : await ProtectedFiles.readTrusted(settings.serverCaFile, 65536, false),
        };
    }
}
