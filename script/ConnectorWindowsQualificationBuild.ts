// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

import { resolve } from 'node:path';
import { ConnectorWindowsSources } from './ConnectorWindowsSources.ts';
import type { WindowsStateArtifact } from '../src/windows/WindowsStateArtifact.ts';
import { ConnectorWindowsNativeBuild } from './ConnectorWindowsNativeBuild.ts';

/** Deliberately separate qualification assets; they never activate connector permissions. */
export interface WindowsQualificationArtifacts {
    readonly worker: WindowsStateArtifact;
    readonly broker: WindowsStateArtifact;
}

/** Source and executable digests bind the broker to the precise fixed worker it may launch. */
export class ConnectorWindowsQualificationBuild {
    /** Reuses the ordinary build directory and leaves no generated pin source or partial executable. */
    public static async build(directory: string): Promise<WindowsQualificationArtifacts> {
        const common: readonly string[] = [
            'SandboxNative.cs',
            'SandboxPolicy.cs',
            'SandboxToken.cs',
        ];
        const worker: WindowsStateArtifact = await ConnectorWindowsNativeBuild.build({
            directory,
            stem: 'nerva-connector-file-worker',
            entrypoint: 'SandboxWorker',
            sources: [...common, 'SandboxWorker.cs'].map((name: string): string =>
                resolve('native/windows/sandbox', name),
            ),
        });
        const broker: WindowsStateArtifact = await ConnectorWindowsNativeBuild.build({
            directory,
            stem: 'nerva-connector-files-qualification',
            entrypoint: 'SandboxBroker',
            sources: [
                ...ConnectorWindowsSources.state,
                ...[
                    ...common,
                    'SandboxPath.cs',
                    'SandboxImageIdentity.cs',
                    'SandboxImage.cs',
                    'SandboxFixture.cs',
                    'SandboxAttributes.cs',
                    'SandboxLaunch.cs',
                    'SandboxBroker.cs',
                ].map((name: string): string => resolve('native/windows/sandbox', name)),
            ],
            generatedSource:
                'internal static class SandboxWorkerPin { internal const int Bytes = ' +
                worker.bytes.toString() +
                '; internal const string Sha256 = "' +
                worker.sha256 +
                '"; }\n',
        });
        return { worker, broker };
    }
}
