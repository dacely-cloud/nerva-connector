// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

import { resolve } from 'node:path';
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
            sources: [
                resolve('native/windows/HostProcess.cs'),
                resolve('native/windows/HostDesktop.cs'),
                resolve('native/windows/HostJob.cs'),
                resolve('native/windows/HostTerminal.cs'),
                resolve('native/windows/HostTerminalConsole.cs'),
                resolve('native/windows/HostTerminalProtocol.cs'),
            ],
        });
    }
}
