// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

import { resolve } from 'node:path';
import type { WindowsStateArtifact } from '../src/windows/WindowsStateArtifact.ts';
import {
    ConnectorWindowsNativeBuild,
    type WindowsNativeBuildInput,
} from './ConnectorWindowsNativeBuild.ts';

/** Publisher-only compilation produces the trusted bootstrap asset; no customer runtime compiles code. */
export class ConnectorBootstrapWindowsBuild {
    /** One source-pinned output is reused, verified and replaced in the existing build directory. */
    public static async build(directory: string): Promise<WindowsStateArtifact> {
        return await ConnectorWindowsNativeBuild.build(this.#input(directory));
    }

    /** Same-directory private inputs require a current, fully verified cache; this path never invokes a compiler. */
    public static async cached(directory: string): Promise<WindowsStateArtifact> {
        const artifact: WindowsStateArtifact | null = await ConnectorWindowsNativeBuild.cached(
            this.#input(directory),
        );
        if (artifact === null) {
            throw new Error(
                'Private publisher bootstrap cache is missing, stale or invalid; use a distinct reviewed --artifacts-directory',
            );
        }
        return artifact;
    }

    static #input(directory: string): WindowsNativeBuildInput {
        return {
            directory,
            stem: 'nerva-connector-bootstrap',
            entrypoint: 'NexaConnectorReleaseBootstrap',
            sources: [
                resolve('native/windows/StateOwner.cs'),
                resolve('native/windows/GpuInventory.cs'),
                resolve('native/windows/ArtifactOperations.cs'),
                resolve('native/windows/BootstrapProcess.cs'),
                resolve('native/windows/ReleaseBootstrap.cs'),
            ],
        };
    }
}
