// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

import { resolve } from 'node:path';
import { ProtectedFiles } from '../src/local/ProtectedFiles.ts';

/** Source builds and protected publication have independently explicit canonical locations. */
export interface ConnectorReleasePreparationOptions {
    readonly configuration: string;
    readonly destination: string | null;
    readonly artifactsDirectory: string | null;
}

/** Unknown, duplicate and ambiguous publisher options never select implicit source paths. */
export class ConnectorReleasePreparationArguments {
    /** The original config-only and config/output-directory forms retain their meaning. */
    public static read(args: readonly string[]): ConnectorReleasePreparationOptions {
        if (args.length < 2 || args.length > 6 || args.length % 2 !== 0 || args[0] !== '--config') {
            throw new Error(
                'Use --config PATH with optional --output-directory PATH and --artifacts-directory PATH',
            );
        }
        let configuration: string | null = null;
        let destination: string | null = null;
        let artifactsDirectory: string | null = null;
        for (let index: number = 0; index < args.length; index += 2) {
            const option: string | undefined = args[index];
            const path: string = ProtectedFiles.path(args[index + 1]);
            if (resolve(path) !== path) {
                throw new Error('Canonical release preparation paths required');
            }
            if (option === '--config' && configuration === null && index === 0) {
                configuration = path;
            } else if (option === '--output-directory' && destination === null) {
                destination = path;
            } else if (option === '--artifacts-directory' && artifactsDirectory === null) {
                artifactsDirectory = path;
            } else {
                throw new Error('Unknown or duplicate release preparation option');
            }
        }
        if (configuration === null) {
            throw new Error('Protected release configuration required');
        }
        return { configuration, destination, artifactsDirectory };
    }
}
