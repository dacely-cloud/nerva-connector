// SPDX-FileCopyrightText: 2026 Dacely <business@dacely.com>
// SPDX-License-Identifier: LicenseRef-Proprietary

import { ConnectorWindowsSources } from './ConnectorWindowsSources.ts';
import type { WindowsStateArtifact } from '../src/windows/WindowsStateArtifact.ts';
import { ConnectorWindowsNativeBuild } from './ConnectorWindowsNativeBuild.ts';

/** Build the Windows host-user Job Object broker without shipping a compiler or source loader. */
export class ConnectorHostWindowsBuild {
    /** Source changes replace the same stable output and retain no compilation intermediates. */
    public static async build(directory: string): Promise<WindowsStateArtifact> {
        return await ConnectorWindowsNativeBuild.build({
            directory,
            stem: 'nerva-connector-host',
            entrypoint: 'NexaConnectorHostProcess',
            sources: ConnectorWindowsSources.host,
        });
    }
}
