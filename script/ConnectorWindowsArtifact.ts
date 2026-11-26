// SPDX-FileCopyrightText: 2026 Dacely <business@dacely.com>
// SPDX-License-Identifier: LicenseRef-Proprietary

import { resolve } from 'node:path';
import type { Plugin } from 'rolldown';
import type { WindowsStateArtifact } from '../src/windows/WindowsStateArtifact.ts';

/** The standalone app pins a fixed sidecar and its build digest, without embedding executable source or a runtime loader. */
export class ConnectorWindowsArtifact {
    /** Only the metadata provider is substituted; runtime file verification remains part of the ordinary app graph. */
    public static plugin(
        artifact: WindowsStateArtifact | null,
        hostArtifact: WindowsStateArtifact | null = null,
    ): Plugin {
        const moduleFile: string = resolve('src/windows/WindowsStateBuild.ts');
        const hostModule: string = resolve('src/host/HostWindowsBuild.ts');
        return {
            name: 'connector-compiled-windows-state-artifact',
            load(id: string): string | null {
                if (resolve(id) === hostModule) {
                    return (
                        'import {fileURLToPath} from "node:url";' +
                        'import {WindowsStateArtifactFile} from ' +
                        JSON.stringify(resolve('src/windows/WindowsStateArtifactFile.ts')) +
                        ';' +
                        'export class HostWindowsBuild {' +
                        'static async read(){return ' +
                        JSON.stringify(hostArtifact) +
                        ';}' +
                        'static executable(){return fileURLToPath(new URL("./nerva-connector-host.exe",import.meta.url));}' +
                        'static async verifiedExecutable(){const artifact=await this.read();if(artifact===null){throw new Error("Windows full-computer access requires a Windows connector build");}const path=this.executable();await WindowsStateArtifactFile.verify(path,artifact);return path;}}'
                    );
                }
                if (resolve(id) !== moduleFile) {
                    return null;
                }
                return (
                    'import {fileURLToPath} from "node:url";export class WindowsStateBuild {' +
                    'static async read(){return ' +
                    JSON.stringify(artifact) +
                    ';}' +
                    'static executable(){return fileURLToPath(new URL("./nerva-connector-state.exe",import.meta.url));}}'
                );
            },
        };
    }
}
