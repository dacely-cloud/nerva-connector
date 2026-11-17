// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

import type {
    JointWorkspacePhysicalScope,
    JointWorkspaceExecutionJournals,
} from 'nerva-connector-protocol/workspace/JointWorkspaceBinding.js';
import type { JointWorkspacePublication } from 'nerva-connector-protocol/workspace/JointWorkspacePublication.js';
import type { JointWorkspaceReceipt } from 'nerva-connector-protocol/workspace/JointWorkspaceReceipt.js';

/** Installation identity includes all permanent independent operation journals and both installed public pins. */
export interface JointWorkspaceJournalIdentity {
    readonly scope: JointWorkspacePhysicalScope;
    readonly fileJournalId: string;
    readonly executionJournals: JointWorkspaceExecutionJournals;
}

/** An immutable archive reference identifies its original complete signed descriptor by stable body commitment. */
export interface JointWorkspaceJournalReference {
    readonly revision: bigint;
    readonly bindingSha256: string;
}

/** An exact alias pair points at one retained immutable revision; aliases alone never establish physical equivalence. */
export interface JointWorkspaceJournalPair {
    readonly fileRootId: string;
    readonly executionRootId: string;
    readonly revision: bigint;
}

/** An accepted publication retains its original proof bytes and the actual authenticated lease interval. */
export interface JointWorkspaceJournalAccepted {
    readonly publication: JointWorkspacePublication;
    readonly receipt: JointWorkspaceReceipt;
    readonly leaseIssuedAtMs: bigint;
    readonly leaseExpiresAtMs: bigint;
}

/** The only current local format has explicit revision reservations and never reconstructs missing encrypted state. */
export enum JointWorkspaceJournalSchema {
    Current = 'joint-workspace-publications',
}

/** A reservation consumes one lifetime revision slot even if capture never completes after a crash. */
export interface JointWorkspaceJournalSnapshot {
    readonly schema: JointWorkspaceJournalSchema.Current;
    readonly identitySha256: string;
    readonly revision: bigint;
    readonly reservedRevision: bigint | null;
    readonly references: readonly JointWorkspaceJournalReference[];
    readonly pairs: readonly JointWorkspaceJournalPair[];
    readonly pending: JointWorkspacePublication | null;
    readonly accepted: JointWorkspaceJournalAccepted | null;
}

/** Archive files remain permanent; exhaustion blocks new reservations while exact retained retries remain valid. */
export class JointWorkspaceJournalLimits {
    public static readonly revisions: number = 4096;
    public static readonly pairs: number = 128;
    public static readonly headPlainBytes: number = 720896;
    public static readonly headRecordBytes: number = 983040;
    public static readonly archivePlainBytes: number = 8192;
    public static readonly archiveRecordBytes: number = 12288;
}
