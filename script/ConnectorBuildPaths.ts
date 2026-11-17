// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

import path from 'node:path';

/** The audited bundle graph uses filesystem containment on each platform, including Windows drive and UNC paths. */
export class ConnectorBuildPaths {
    /** Custom outputs retain the fixed adjacent notices filename consumed by signed release preparation. */
    public static notices(destination: string, platform: typeof path = path): string {
        if (!platform.isAbsolute(destination) || !destination.endsWith('.mjs')) {
            throw new Error('Connector notices require an absolute application output');
        }
        return platform.join(platform.dirname(destination), 'THIRD-PARTY-NOTICES.txt');
    }

    /** Sibling prefixes, traversal, relative module IDs and other drives cannot become reviewed source modules. */
    public static contains(
        directory: string,
        moduleId: string,
        platform: typeof path = path,
    ): boolean {
        if (!platform.isAbsolute(directory) || !platform.isAbsolute(moduleId)) {
            return false;
        }
        const relative: string = platform.relative(directory, moduleId);
        return (
            relative !== '' &&
            relative !== '..' &&
            !relative.startsWith('..' + platform.sep) &&
            !platform.isAbsolute(relative)
        );
    }
}
