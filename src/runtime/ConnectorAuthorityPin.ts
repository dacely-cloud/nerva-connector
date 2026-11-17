// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

import { IdentityCodec } from 'nerva-connector-protocol/identity/IdentityCodec.js';
import { SignatureSuite } from 'nerva-connector-protocol/identity/IdentityFormat.js';
import { Boundary } from 'nerva-connector-protocol/protocol/Boundary.js';
import { ProtectedFiles } from '../local/ProtectedFiles.js';

/** Deployment identity and both verification keys come from installation, never public transport responses. */
export interface ConnectorTrustedAuthority {
    readonly authorityId: string;
    readonly publicKey: string;
}

/** Pairing and file permits use the same strict composite public identity descriptor. */
export class ConnectorAuthorityPin {
    /** Only a protected explicitly named trusted descriptor may supply either verification key. */
    public static async load(
        authorityId: string,
        path: string,
    ): Promise<ConnectorTrustedAuthority> {
        const id: string = Boundary.id(authorityId);
        const bytes: Buffer = await ProtectedFiles.readTrusted(path, 16384, false);
        const value: Readonly<Record<string, unknown>> = Boundary.record(
            JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)),
            ['suite', 'publicKey'],
        );
        if (value['suite'] !== SignatureSuite.MlDsa44Ed25519) {
            throw new Error(
                'Connector authority requires its complete separately installed composite public identity',
            );
        }
        return Object.freeze({
            authorityId: id,
            publicKey: IdentityCodec.publicKey(value['publicKey']).toString('base64url'),
        });
    }
}
