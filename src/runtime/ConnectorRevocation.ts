// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

import { dirname } from 'node:path';
import { SigningKey } from '../identity/SigningKey.js';
import { SignaturePurpose } from 'nerva-connector-protocol/identity/IdentityFormat.js';
import {
    ConnectorUnpairCodec,
    type ConnectorUnpair,
} from 'nerva-connector-protocol/protocol/ConnectorUnpair.js';
import type { ConnectorTrustedAuthority } from './ConnectorAuthorityPin.js';
import type { ConnectorClientIdentity } from './ConnectorClientConfiguration.js';
import {
    ConnectorPrivateDirectory,
    ConnectorDirectoryPurpose,
} from './ConnectorPrivateDirectory.js';

/** Only a pinned authority's permanent revocation can retire a computer's saved pairing. */
export class ConnectorRevocation {
    /** The receipt's target and both signature components must match the installed identity. */
    public static verify(
        authority: ConnectorTrustedAuthority,
        publicKey: string,
        raw: unknown,
    ): ConnectorUnpair {
        const receipt: ConnectorUnpair = ConnectorUnpairCodec.read(raw);
        if (
            receipt.authorityId !== authority.authorityId ||
            receipt.publicKey !== publicKey ||
            !SigningKey.verify(
                SignaturePurpose.DeviceUnpaired,
                authority.publicKey,
                Buffer.from(ConnectorUnpairCodec.payload(receipt)),
                receipt.signature,
            )
        ) {
            throw new Error('Connector revocation authority proof rejected');
        }
        return Object.freeze(receipt);
    }

    /** Retains the verified retirement before the runtime releases its last local owners. */
    public static async record(
        identity: ConnectorClientIdentity,
        receipt: ConnectorUnpair,
    ): Promise<void> {
        const confirmed: ConnectorUnpair = this.verify(
            identity.authority,
            identity.publicKey,
            receipt,
        );
        await using owner: ConnectorPrivateDirectory = await ConnectorPrivateDirectory.open(
            dirname(identity.settings.privateKeyFile),
            ConnectorDirectoryPurpose.Pairing,
        );
        if (await owner.exists('revoked-state')) {
            this.verify(
                identity.authority,
                identity.publicKey,
                JSON.parse((await owner.read('revoked-state', 16384)).toString('utf8')),
            );
            return;
        }
        await owner.cleanPartial('revoked-state', 16384);
        await owner.write('revoked-state', Buffer.from(JSON.stringify(confirmed)), 16384, true);
    }
}
