// SPDX-FileCopyrightText: 2026 Dacely <business@dacely.com>
// SPDX-License-Identifier: LicenseRef-Proprietary

import { ConnectorWindowsSources } from './ConnectorWindowsSources.ts';
import type { WindowsStateArtifact } from '../src/windows/WindowsStateArtifact.ts';
import { ConnectorWindowsNativeBuild } from './ConnectorWindowsNativeBuild.ts';

/** Build-time compilation produces an ordinary Windows CLR executable; the customer runtime launches no compiler. */
export class ConnectorWindowsBuild {
    /** Stable outputs are reused only when their exact source and binary hashes still match. */
    public static async build(directory: string): Promise<WindowsStateArtifact> {
        return await ConnectorWindowsNativeBuild.build({
            directory,
            stem: 'nerva-connector-state',
            entrypoint: 'NexaConnectorStateOwner',
            sources: ConnectorWindowsSources.state,
        });
    }
}
