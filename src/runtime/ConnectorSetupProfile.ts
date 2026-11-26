// SPDX-FileCopyrightText: 2026 Dacely <business@dacely.com>
// SPDX-License-Identifier: LicenseRef-Proprietary

/** Setup records the user's access choice; independently installed runtime grants remain authoritative. */
export const ConnectorSetupAccess = {
    PairingOnly: 'pairing-only',
    FilesRead: 'files-read',
    FilesWrite: 'files-write',
    FullComputer: 'full-computer',
} as const;

/** Allowed values derive from the current runtime mapping. */
export type ConnectorSetupAccess = (typeof ConnectorSetupAccess)[keyof typeof ConnectorSetupAccess];

/** Local preferences contain no credentials and cannot substitute for account or device authorization. */
export interface ConnectorSetupPreferences {
    readonly name: string;
    readonly tasksDirectory: string;
    readonly localInstructions: string;
    readonly access: ConnectorSetupAccess;
}

/** Exact revisions prevent a concurrent setup from overwriting another completed local review. */
export interface ConnectorSetupProfile extends ConnectorSetupPreferences {
    readonly revision: bigint;
}
