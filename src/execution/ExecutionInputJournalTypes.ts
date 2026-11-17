// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

import type { ExecutionLane } from 'nerva-connector-protocol/execution/ExecutionLane.js';
import type { ExecutionPermit } from './ExecutionJobs.js';
import type { ExecutionInteractiveReady } from 'nerva-connector-protocol/execution/ExecutionInteractive.js';
import type { ExecutionInputTerminalResolution } from 'nerva-connector-protocol/execution/ExecutionInputTerminalResolution.js';
import type {
    ExecutionInteractiveInvocationRule,
    ExecutionInteractiveLaunch,
} from 'nerva-connector-protocol/execution/ExecutionInteractiveInvocation.js';
import type {
    ExecutionInputCursor,
    ExecutionInputPermit,
    ExecutionInputReceipt,
    ExecutionInputAcknowledgment,
} from 'nerva-connector-protocol/execution/ExecutionInput.js';

/** One fixed file belongs to the permanent execution lane, never to a generated job directory. */
export interface ExecutionInputJournalScope {
    readonly lane: ExecutionLane;
    readonly journalId: string;
}

/** Independently captured launch authority is required again when restoring a particular original. */
export interface ExecutionInputJournalAdmission {
    readonly ready: ExecutionInteractiveReady;
    readonly rule: ExecutionInteractiveInvocationRule;
    readonly launch: ExecutionInteractiveLaunch;
    readonly policySha256: string;
}

/** Exact first signed proofs and their pre-control cursor survive transport retries and process loss. */
export interface ExecutionInputJournalControl {
    readonly kind: ExecutionInputJournalControlKind.Permit;
    readonly permit: ExecutionInputPermit;
    readonly prior: ExecutionInputCursor;
    readonly receipt: ExecutionInputReceipt | null;
    readonly acknowledgment: ExecutionInputAcknowledgment | null;
}

/** Terminal resolution records uncertainty after actual completion and cannot be passed as native write permission. */
export interface ExecutionInputJournalResolvedControl {
    readonly kind: ExecutionInputJournalControlKind.TerminalResolution;
    readonly resolution: ExecutionInputTerminalResolution;
    readonly prior: ExecutionInputCursor;
    readonly receipt: ExecutionInputReceipt | null;
    readonly acknowledgment: ExecutionInputAcknowledgment | null;
}

/** The single pending/last slots retain exactly one explicit authority kind. */
export type ExecutionInputJournalRetainedControl =
    ExecutionInputJournalControl | ExecutionInputJournalResolvedControl;

/** A distinct discriminant prevents terminal recovery authority from becoming native effect permission. */
export enum ExecutionInputJournalControlKind {
    Permit = 'permit',
    TerminalResolution = 'terminal-resolution',
}

/** Full terminal proofs are verified before compaction; bounded commitments avoid copying terminal output here. */
export interface ExecutionInputJournalTerminal {
    readonly completionSha256: string;
    readonly acknowledgmentSha256: string;
    readonly responseHash: string;
}

export enum ExecutionInputJournalSchema {
    Cursor = 'execution-input-cursor',
}

/** Preparation records intended authority, while Ready alone records genuine native exec evidence. */
export enum ExecutionInputJournalPhase {
    Prepared = 'prepared',
    Ready = 'ready',
}

/** Planned incarnation is not native evidence and cannot grant initial input or a Ready publication. */
export interface ExecutionInputJournalPreparation {
    readonly permit: ExecutionPermit;
    readonly rule: ExecutionInteractiveInvocationRule;
    readonly launch: ExecutionInteractiveLaunch;
    readonly incarnation: string;
}

/** A process may have executed before Ready becomes durable; recovery always loses its original native owner. */
export interface ExecutionInputJournalPreparedState {
    readonly schema: ExecutionInputJournalSchema.Cursor;
    readonly phase: ExecutionInputJournalPhase.Prepared;
    readonly scope: ExecutionInputJournalScope;
    readonly preparation: ExecutionInputJournalPreparation;
    readonly ownerLost: boolean;
    readonly terminal: ExecutionInputJournalTerminal | null;
}

/** The same fixed encrypted file has one explicit current phase, never an omitted-phase compatibility form. */
export type ExecutionInputJournalRecordState =
    ExecutionInputJournalPreparedState | ExecutionInputJournalState;

/** Owner loss is local recovery evidence and cannot silently modify an already signed cursor or receipt. */
export interface ExecutionInputJournalState {
    readonly schema: ExecutionInputJournalSchema.Cursor;
    readonly phase: ExecutionInputJournalPhase.Ready;
    readonly scope: ExecutionInputJournalScope;
    readonly admission: ExecutionInputJournalAdmission;
    readonly writerGeneration: bigint;
    readonly cursor: ExecutionInputCursor;
    readonly ownerLost: boolean;
    /** Refusal stops further input even when the same native process still exists. */
    readonly inputStopped: boolean;
    readonly pending: ExecutionInputJournalRetainedControl | null;
    readonly last: ExecutionInputJournalRetainedControl | null;
    readonly terminal: ExecutionInputJournalTerminal | null;
}

/** Both maximum records fit below the existing execution-result journal's independent limits. */
export class ExecutionInputJournalLimits {
    public static readonly plainBytes: number = 114688;
    /** 114688 bytes expand to at most 152918 base64url characters, plus a GCM envelope below 128 bytes. */
    public static readonly recordBytes: number = 153088;
    /** 2048 UTF-8 fixed-switch bytes may expand sixfold; aliases, environment names and finite fields stay below another 12288 bytes. */
    public static readonly ruleBytes: number = 24576;
    public static readonly basename: string = 'execution-input';
}
