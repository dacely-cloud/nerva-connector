// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

import { WindowsStateBuild } from './WindowsStateBuild.js';
import { WindowsStateArtifactFile } from './WindowsStateArtifactFile.js';
import type { WindowsStateArtifact } from './WindowsStateArtifact.js';
import { WindowsStateError, WindowsStateFailure } from './WindowsStateProtocol.js';

/** Windows launches a normal compiled sidecar after checking its bounded bytes against the app's build pin. */
export class WindowsStateExecutable {
    /** The bundle chooses a fixed adjacent executable and pins its digest at build time. */
    public static async path(): Promise<string> {
        let artifact: WindowsStateArtifact | null;
        try {
            artifact = await WindowsStateBuild.read();
        } catch {
            throw new WindowsStateError(WindowsStateFailure.HelperUntrusted);
        }
        if (artifact === null) {
            throw new WindowsStateError(WindowsStateFailure.HelperMissing);
        }
        const path: string = WindowsStateBuild.executable();
        await this.verify(path, artifact);
        return path;
    }

    /** Only fixed safe failure categories reach the UI; file contents and paths are not diagnostics. */
    public static async verify(path: string, artifact: WindowsStateArtifact): Promise<void> {
        try {
            await WindowsStateArtifactFile.verify(path, artifact);
        } catch (caught: unknown) {
            if (caught instanceof Error && 'code' in caught && caught.code === 'ENOENT') {
                throw new WindowsStateError(WindowsStateFailure.HelperMissing);
            }
            throw new WindowsStateError(WindowsStateFailure.HelperUntrusted);
        }
    }
}
