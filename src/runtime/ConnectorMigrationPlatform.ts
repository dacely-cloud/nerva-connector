// SPDX-FileCopyrightText: 2026 Dacely <business@dacely.com>
// SPDX-License-Identifier: LicenseRef-Proprietary

import type { ConnectorClientSettings } from './ConnectorClientSettings.js';

/** Platform admission follows the actual ownership mechanisms available for configured state. */
export class ConnectorMigrationPlatform {
    /** Windows and macOS support the existing native runtime/pairing owners, but grant no Linux operation-journal ownership. */
    public static validate(platform: NodeJS.Platform, settings: ConnectorClientSettings): void {
        if (
            platform === 'linux' ||
            ((platform === 'win32' || platform === 'darwin') &&
                settings.files === null &&
                settings.execution === null)
        ) {
            return;
        }
        throw new Error(
            'Stopped migration requires Linux operation-journal ownership or a Windows or macOS device without file and command grants',
        );
    }
}
