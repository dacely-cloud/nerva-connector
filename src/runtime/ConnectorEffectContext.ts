// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

import type { WorkspaceIdentity } from '../workspace/WorkspaceIdentity.js';
import type { ExecutionCgroupIdentity } from '../execution/ExecutionCgroupIdentity.js';

/** Private retained provenance never grants a public joint workspace capability. */
export enum ConnectorEffectKind {
    CapturedFile = 'captured-file',
    HistoricalUnproven = 'historical-unproven',
    IndependentExecution = 'independent-execution',
    CapturedExecution = 'captured-execution',
    CapturedInteractiveExecution = 'captured-interactive-execution',
    ExecutionNotStarted = 'execution-not-started',
}

/** Both actual directory identities are captured before Started, independently of their pathnames. */
export interface ConnectorCapturedFileEffect {
    readonly kind: ConnectorEffectKind.CapturedFile;
    readonly policySha256: string;
    readonly rootId: string;
    readonly root: WorkspaceIdentity;
    readonly staging: WorkspaceIdentity | null;
}

/** Explicit conversion preserves the old original without inventing missing physical provenance. */
export interface ConnectorHistoricalEffect {
    readonly kind: ConnectorEffectKind.HistoricalUnproven;
    readonly sourceSha256: string;
}

/** Independent command history has no file-staging claim; this is not physical command or joint authorization. */
export interface ConnectorIndependentExecutionEffect {
    readonly kind: ConnectorEffectKind.IndependentExecution;
}

/** Fresh command intent retains its actual workspace and delegation before allocating a process group. */
export interface ConnectorCapturedExecutionAuthority {
    readonly policySha256: string;
    readonly rootId: string;
    readonly root: WorkspaceIdentity;
    readonly cgroupRoot: string;
    readonly cgroupHelperFile: string;
    readonly cgroupHelperSha256: string;
    readonly delegation: ExecutionCgroupIdentity;
    readonly group: ExecutionCgroupIdentity | null;
}

/** Foreground execution remains independent of all live-input state and recovery. */
export interface ConnectorCapturedForegroundExecutionEffect extends ConnectorCapturedExecutionAuthority {
    readonly kind: ConnectorEffectKind.CapturedExecution;
}

/** The main journal commits planned interactive identity before preparation and native group binding. */
export interface ConnectorCapturedInteractiveExecutionEffect extends ConnectorCapturedExecutionAuthority {
    readonly kind: ConnectorEffectKind.CapturedInteractiveExecution;
    readonly incarnation: string;
}

/** Both current physical contracts share cleanup authority while preserving their different input recovery obligations. */
export type ConnectorCapturedExecutionEffect =
    ConnectorCapturedForegroundExecutionEffect | ConnectorCapturedInteractiveExecutionEffect;

/** A fresh cancellation or expiry is sealed without allocating a group or authorizing program execution. */
export interface ConnectorExecutionNotStartedEffect {
    readonly kind: ConnectorEffectKind.ExecutionNotStarted;
}

/** Each current journal record states its provenance explicitly; missing metadata is never a fallback. */
export type ConnectorEffectContext =
    | ConnectorCapturedFileEffect
    | ConnectorHistoricalEffect
    | ConnectorIndependentExecutionEffect
    | ConnectorCapturedExecutionEffect
    | ConnectorExecutionNotStartedEffect;

/** The native child receives only these private expected identities, never a key or policy pathname. */
export interface ConnectorNativeFileEffect {
    readonly root: WorkspaceIdentity;
    readonly staging: WorkspaceIdentity | null;
}
