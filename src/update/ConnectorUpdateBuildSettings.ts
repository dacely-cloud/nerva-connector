// SPDX-FileCopyrightText: 2026 Dacely <business@dacely.com>
// SPDX-License-Identifier: LicenseRef-Proprietary

import type { ConnectorUpdateSettings } from './ConnectorUpdateProtocol.js';

/** Standalone builds replace this module with reviewed public release settings and native helper commitments. */
export class ConnectorUpdateBuildSettings {
    /** An unpackaged source invocation cannot invent update authority or select an arbitrary program directory. */
    public static read(): ConnectorUpdateSettings {
        throw new Error('Run the installed connector launcher to use automatic updates');
    }
}
