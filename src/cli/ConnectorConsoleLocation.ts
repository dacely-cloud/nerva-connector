// SPDX-FileCopyrightText: 2026 Dacely <business@dacely.com>
// SPDX-License-Identifier: LicenseRef-Proprietary

import { dirname } from 'node:path';
import { ConnectorCloudConfiguration } from '../runtime/ConnectorCloudConfiguration.js';
import { ConnectorInstallation } from '../install/ConnectorInstallation.js';
import { ConnectorLogout } from '../runtime/ConnectorLogout.js';
import type { ConnectorSetupSession } from './ConnectorSetupSession.js';

/** Deployment discovery stays behind the application; normal startup uses the default installation. */
export const ConnectorConsoleSourceKind = {
    Cloud: 'cloud',
    Installation: 'installation',
    Pairing: 'pairing',
} as const;
/** Source kinds derive from their runtime mapping. */
export type ConnectorConsoleSourceKind =
    (typeof ConnectorConsoleSourceKind)[keyof typeof ConnectorConsoleSourceKind];

/** Explicit source arguments are reserved for controlled developer and enterprise installations. */
export interface ConnectorConsoleSource {
    readonly kind: ConnectorConsoleSourceKind;
    readonly path: string;
}

/** Resolves the installation folder and the active pairing file for one console source. */
export class ConnectorConsoleLocation {
    /** The installer chooses the private pairing file; the terminal never asks users to author it. */
    public constructor(public readonly source: ConnectorConsoleSource) {}

    /** The connector's own private folder; reading it creates nothing. */
    public async directory(): Promise<string> {
        return this.source.kind === ConnectorConsoleSourceKind.Cloud
            ? this.source.path === ''
                ? await ConnectorCloudConfiguration.defaultDirectory()
                : this.source.path
            : this.source.kind === ConnectorConsoleSourceKind.Installation
              ? this.source.path
              : dirname(this.source.path);
    }

    /**
     * The current pairing file after any completed unlink, prepared on first use.
     *
     * @param setup - Supplies the chosen computer name for a pairing that has not started yet
     */
    public async pairingFile(signal: AbortSignal, setup: ConnectorSetupSession): Promise<string> {
        const initial: string =
            this.source.kind === ConnectorConsoleSourceKind.Cloud
                ? await ConnectorCloudConfiguration.prepare(
                      this.source.path === ''
                          ? await ConnectorCloudConfiguration.defaultDirectory()
                          : this.source.path,
                      signal,
                  )
                : this.source.kind === ConnectorConsoleSourceKind.Installation
                  ? (await ConnectorInstallation.read(this.source.path, signal)).pairingFile
                  : this.source.path;
        const pairingFile: string = await ConnectorLogout.resolve(initial, signal);
        await setup.applyPairingName(pairingFile);
        return pairingFile;
    }
}
