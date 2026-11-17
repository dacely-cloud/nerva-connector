// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

import { ProtectedFiles } from '../src/local/ProtectedFiles.ts';

/** Publisher output uses the existing native private-directory policy; inherited DACLs never substitute for explicit private ownership. */
export class ConnectorNpmPackageDirectory {
    /** Existing Windows output must already be private; only managed-root native creation may initialize a missing directory. */
    public static async create(directory: string): Promise<void> {
        if (process.platform !== 'win32') {
            await ProtectedFiles.createDirectory(directory);
            return;
        }
        try {
            await ProtectedFiles.directory(directory);
        } catch (caught: unknown) {
            if (!(caught instanceof Error) || !('code' in caught) || caught.code !== 'ENOENT') {
                throw caught;
            }
            await ProtectedFiles.createDirectory(directory);
        }
    }
}
