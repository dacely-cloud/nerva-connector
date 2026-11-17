// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

import type { ConnectorFilesystem } from '../runtime/ConnectorFilesystem.js';
import type { ConnectorFileProfile } from 'nerva-connector-protocol/protocol/ConnectorFiles.js';
import type { ExecutionPolicy } from '../execution/ExecutionPolicy.js';
import type { ExecutionProfile } from '../execution/ExecutionJobs.js';
import type { JointWorkspaceExecutionJournals } from 'nerva-connector-protocol/workspace/JointWorkspaceBinding.js';

/** Borrowed live-owner view; the runtime must outlive every capture and the caller must not dispose its filesystem. */
export interface ConnectorFileWorkspaceSource {
    /** False for active work or any retained original, including a terminal result awaiting acknowledgment. */
    readonly quiescent: boolean;
    readonly filesystem: ConnectorFilesystem;
    readonly profile: ConnectorFileProfile;
    readonly journalId: string;
}

/** Both permanent lane identities describe the single borrowed installation policy; this view owns no disposal authority. */
export interface ConnectorExecutionWorkspaceSource {
    /** Both lanes must be idle and fully acknowledged; socket state does not establish quiescence. */
    readonly quiescent: boolean;
    readonly policy: ExecutionPolicy;
    readonly profile: ExecutionProfile;
    readonly journals: JointWorkspaceExecutionJournals;
}
