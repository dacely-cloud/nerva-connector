// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

import { ConnectorUpdatePlatform } from './ConnectorUpdateProtocol.ts';

/** One file catalog defines packaging and the installed program files an updater may replace. */
export class ConnectorUpdateFiles {
    /** OS-specific native helpers remain explicit; no dependency or regeneration tree enters an installer. */
    public static names(platform: ConnectorUpdatePlatform): readonly string[] {
        return [
            'node',
            'NODE-LICENSE.txt',
            'nerva-connector.mjs',
            'nerva-connector-host-worker.mjs',
            'nerva-connector-exec',
            'THIRD-PARTY-NOTICES.txt',
            'nerva-connector',
            'nerva-connector-update.mjs',
            'nerva-connector-update',
            ...(platform === ConnectorUpdatePlatform.Linux
                ? ['nerva-connector-files', 'nerva-connector-logo.png', '.nerva-installation']
                : []),
        ];
    }
}
