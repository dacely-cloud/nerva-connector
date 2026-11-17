// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

import { ConnectorReleaseFile, ConnectorReleasePlatform } from './ConnectorRelease.js';

/** Fixed ordered asset sets make incomplete or mixed-platform signed releases invalid. */
export class ConnectorReleaseAssets {
    /** Linux confined helpers and Windows compiled state/process helpers are independently explicit contracts. */
    public static names(platform: ConnectorReleasePlatform): readonly ConnectorReleaseFile[] {
        switch (platform) {
            case ConnectorReleasePlatform.Linux:
                return [
                    ConnectorReleaseFile.Application,
                    ConnectorReleaseFile.Runtime,
                    ConnectorReleaseFile.License,
                    ConnectorReleaseFile.Files,
                    ConnectorReleaseFile.Execution,
                    ConnectorReleaseFile.Notices,
                    ConnectorReleaseFile.HostWorker,
                ];
            case ConnectorReleasePlatform.Windows:
                return [
                    ConnectorReleaseFile.Application,
                    ConnectorReleaseFile.WindowsRuntime,
                    ConnectorReleaseFile.License,
                    ConnectorReleaseFile.WindowsState,
                    ConnectorReleaseFile.WindowsStateMetadata,
                    ConnectorReleaseFile.WindowsHost,
                    ConnectorReleaseFile.WindowsHostMetadata,
                    ConnectorReleaseFile.Notices,
                    ConnectorReleaseFile.HostWorker,
                ];
            default:
                throw new Error('Unsupported connector release platform');
        }
    }

    /** Launchers use the signed platform's fixed runtime filename. */
    public static runtime(platform: ConnectorReleasePlatform): ConnectorReleaseFile {
        if (platform === ConnectorReleasePlatform.Linux) {
            return ConnectorReleaseFile.Runtime;
        }
        if (platform === ConnectorReleasePlatform.Windows) {
            return ConnectorReleaseFile.WindowsRuntime;
        }
        throw new Error('Unsupported connector release platform');
    }
}
