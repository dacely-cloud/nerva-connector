// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

import { fileURLToPath } from 'node:url';
import type { WindowsStateArtifact } from '../windows/WindowsStateArtifact.js';
import { WindowsStateBuild } from '../windows/WindowsStateBuild.js';
import { WindowsStateArtifactFile } from '../windows/WindowsStateArtifactFile.js';

/** Build metadata for the host-user process broker, distinct from confined execution helpers. */
export class HostWindowsBuild {
    /** Bundles replace this source reader with their immutable compiled artifact digest. */
    public static async read(): Promise<WindowsStateArtifact | null> {
        return await WindowsStateBuild.read(
            new URL('../../build/nerva-connector-host.json', import.meta.url),
        );
    }

    /** Source execution and bundled execution both resolve one fixed build output. */
    public static executable(): string {
        return fileURLToPath(new URL('../../build/nerva-connector-host.exe', import.meta.url));
    }

    /** Full-computer mode still verifies its owned process-lifetime helper before launching it. */
    public static async verifiedExecutable(): Promise<string> {
        const artifact: WindowsStateArtifact | null = await this.read();
        if (artifact === null) {
            throw new Error('Windows full-computer access requires a Windows connector build');
        }
        const executable: string = this.executable();
        await WindowsStateArtifactFile.verify(executable, artifact);
        return executable;
    }
}
