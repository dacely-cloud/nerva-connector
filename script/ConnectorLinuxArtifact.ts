// SPDX-FileCopyrightText: 2026 Dacely <business@dacely.com>
// SPDX-License-Identifier: LicenseRef-Proprietary

import type { Plugin } from 'rolldown';
import { resolve } from 'node:path';
import type { HostLinuxArtifact } from '../src/host/HostLinuxArtifact.ts';

/** A standalone app embeds one reviewed Linux helper pin and never trusts mutable runtime metadata. */
export class ConnectorLinuxArtifact {
    /** Build-time replacement retains a fixed adjacent executable instead of a publisher's source-tree path. */
    public static plugin(artifact: HostLinuxArtifact | null): Plugin {
        const entry: string = resolve('src/host/HostLinuxBuild.ts');
        const generated = '\0connector-linux-terminal-artifact';
        return {
            name: 'connector-linux-terminal-artifact',
            resolveId(source: string, importer?: string): string | null {
                if (
                    importer !== undefined &&
                    source.endsWith('/HostLinuxBuild.js') &&
                    resolve(importer, '..', source.replace(/\.js$/u, '.ts')) === entry
                ) {
                    return generated;
                }
                return null;
            },
            load(id: string): string | null {
                return id === generated
                    ? "import {fileURLToPath} from 'node:url';export class HostLinuxBuild{static async read(){return " +
                          JSON.stringify(artifact) +
                          ";}static executable(){return fileURLToPath(new URL('./nerva-connector-exec',import.meta.url));}}"
                    : null;
            },
        };
    }
}
