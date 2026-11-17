// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/** Every direct artifact build rejects incomplete or circular source graphs before creating outputs. */
export class CircularDependencies {
    /** Preserve machine-readable build output on success and expose the complete graph failure on error. */
    public static check(): void {
        const root: URL = new URL('../', import.meta.url);
        const result: SpawnSyncReturns<string> = spawnSync(
            process.execPath,
            [
                fileURLToPath(new URL('node_modules/madge/bin/cli.js', root)),
                '--circular',
                '--strict',
                '--json',
                '.',
            ],
            { cwd: root, encoding: 'utf8' },
        );
        if (result.error !== undefined) {
            throw result.error;
        }
        if (result.status !== 0) {
            process.stderr.write(result.stdout + result.stderr);
            throw new Error('Circular dependency check failed');
        }
    }
}
