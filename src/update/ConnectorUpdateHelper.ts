// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

import { createHash } from 'node:crypto';
import { ConnectorNativeFormat } from '../runtime/ConnectorNativeFormat.js';
import { ConnectorUpdatePaths } from './ConnectorUpdatePaths.js';
import type { ConnectorUpdateSettings } from './ConnectorUpdateProtocol.js';

/** Both locking and atomic exchanges execute only the native helper pinned into this supervisor build. */
export class ConnectorUpdateHelper {
    /** Verification uses the native operating system, architecture and complete executable digest. */
    public static async verify(path: string, settings: ConnectorUpdateSettings): Promise<void> {
        const bytes: Buffer = await ConnectorUpdatePaths.read(path, 16777216);
        if (
            !ConnectorNativeFormat.matches(bytes, settings.platform, settings.architecture) ||
            createHash('sha256').update(bytes).digest('hex') !== settings.helperSha256
        ) {
            throw new Error('Update helper differs from its native build commitment');
        }
    }
}
