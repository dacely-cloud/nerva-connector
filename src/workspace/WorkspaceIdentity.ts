// SPDX-FileCopyrightText: 2026 Dacely <business@dacely.com>
// SPDX-License-Identifier: LicenseRef-Proprietary

/** Only private native pipes and encrypted effect history carry these values; none belong in CLI or profile output. */
export interface WorkspaceIdentity {
    readonly filesystemUuid: string;
    readonly device: bigint;
    readonly inode: bigint;
    readonly handleType: 1;
    readonly handle: string;
}

/** Unsupported identity support is distinct from changed or invalid authority. */
export enum WorkspaceIdentityFailure {
    Unsupported = 'unsupported',
    Changed = 'changed',
    Unavailable = 'unavailable',
    Invalid = 'invalid',
}

/** Exact decoded native success retains raw identity only inside local capability owners. */
export interface WorkspaceIdentitySuccess {
    readonly ok: true;
    readonly identity: WorkspaceIdentity;
}

/** No native failure fabricates a successful or comparable identity. */
export interface WorkspaceIdentityError {
    readonly ok: false;
    readonly error: WorkspaceIdentityFailure;
}

/** Private-pipe result; not a signed profile or remote protocol extension. */
export type WorkspaceIdentityResult = WorkspaceIdentitySuccess | WorkspaceIdentityError;
