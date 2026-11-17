// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

import { open, rename, rm, chmod, type FileHandle } from 'node:fs/promises';

/** Stable product outputs are published atomically; task-owned partials never survive any exit path. */
export class ConnectorBuildArtifact {
    /** Development outputs have no credential-directory authority or private-identity side effects. */
    public static async publish(
        destination: string,
        contents: string | Uint8Array,
        mode: number,
    ): Promise<void> {
        const temporary: string = destination + '.partial-' + process.pid.toString();
        let owned: boolean = false;
        try {
            const output: FileHandle = await open(temporary, 'wx', 0o600);
            owned = true;
            try {
                await output.writeFile(contents);
                await output.sync();
            } finally {
                await output.close();
            }
            await chmod(temporary, mode);
            await rename(temporary, destination);
        } finally {
            if (owned) {
                await rm(temporary, { force: true });
            }
        }
    }
}
