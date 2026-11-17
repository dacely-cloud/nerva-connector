// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

/** Safe local setup failures never expose credentials or silently replace retained grants. */
export enum ConnectorPermissionFailure {
    Platform = 'platform',
    Terminal = 'terminal',
    Release = 'release',
    Pairing = 'pairing',
    Existing = 'existing',
    Path = 'path',
    Changed = 'changed',
}
/** Permission setup reports actionable local prerequisites without changing their enforcement. */
export class ConnectorPermissionError extends Error {
    /** Fixed messages are independent of remote or native diagnostic text. */
    public constructor(public readonly code: ConnectorPermissionFailure) {
        super(
            {
                [ConnectorPermissionFailure.Terminal]:
                    'Open an interactive terminal to approve local file access.',
                [ConnectorPermissionFailure.Platform]:
                    'File and command permissions are currently unavailable on this platform. Linux native confinement is required.',
                [ConnectorPermissionFailure.Release]:
                    'File access requires a verified signed Linux installation. Install the connector with its signed release installer first.',
                [ConnectorPermissionFailure.Pairing]:
                    'Link this machine to your account before granting file access.',
                [ConnectorPermissionFailure.Existing]:
                    'Local permissions already exist. Editing these grants is not available yet; existing access and history were kept.',
                [ConnectorPermissionFailure.Path]:
                    'Choose an existing project folder with protected parent directories, outside the connector installation.',
                [ConnectorPermissionFailure.Changed]:
                    'The local installation or original approval changed. Existing permissions and history were kept.',
            }[code],
        );
        this.name = 'ConnectorPermissionError';
    }
}
