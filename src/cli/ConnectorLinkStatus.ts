// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

import { join } from 'node:path';
import { ProtectedFiles } from '../local/ProtectedFiles.js';
import {
    ConnectorPairConfiguration,
    type ConnectorPairIdentity,
} from '../runtime/ConnectorPairConfiguration.js';

/** Public facts about one local pairing identity; no keys, proofs or request IDs. */
export interface ConnectorLinkView {
    /** An approved account link has a published device configuration. */
    readonly linked: boolean;
    /** The name this computer registers with, as configured locally. */
    readonly deviceName: string;
}

/** Read-only check that decides whether the linking screen is needed; it creates no state. */
export class ConnectorLinkStatus {
    /** Reads the pairing configuration and checks for its published device configuration. */
    public static async inspect(pairingFile: string): Promise<ConnectorLinkView> {
        const identity: ConnectorPairIdentity = await ConnectorPairConfiguration.load(pairingFile);
        return {
            linked: await ProtectedFiles.exists(
                join(identity.settings.stateDirectory, 'device.json'),
            ),
            deviceName: identity.settings.deviceName,
        };
    }
}
