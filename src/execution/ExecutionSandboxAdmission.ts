// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

import type { WorkspaceIdentity } from '../workspace/WorkspaceIdentity.js';
import type { WorkspaceIdentityProcess } from '../workspace/WorkspaceIdentityProcess.js';
import type { ExecutionCgroupIdentity } from './ExecutionCgroupIdentity.js';

/** Expected capabilities and the joined durability callback come only from the local trusted owner. */
export interface ExecutionSandboxAdmission {
    readonly workspaceIdentity: WorkspaceIdentity;
    readonly delegationIdentity: ExecutionCgroupIdentity;
    readonly capture: WorkspaceIdentityProcess;
    /** A captured short start window is checked before native effects; running lifetime is separate. */
    readonly expiresAtMs: bigint;
    /** Synchronous trusted validation never refreshes the captured permit or original. */
    readonly assertLaunch: () => void;
    readonly commit: (group: ExecutionCgroupIdentity) => Promise<void>;
}
