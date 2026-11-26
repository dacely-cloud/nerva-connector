// SPDX-FileCopyrightText: 2026 Dacely <business@dacely.com>
// SPDX-License-Identifier: LicenseRef-Proprietary

import type {
    ExecutionRootPolicy,
    ExecutionProgramPolicy,
} from 'nerva-connector-protocol/execution/ExecutionPolicyTypes.js';
import type { ExecutionResourceLimits } from 'nerva-connector-protocol/execution/ExecutionTypes.js';
import type { ConnectorFileMode } from 'nerva-connector-protocol/protocol/ConnectorFiles.js';

/** A runtime contains only explicitly approved readonly data or executable bytes. */
export enum ConnectorRuntimeFileMode {
    Data = 'data',
    Executable = 'executable',
}
/** Native setup intent is committed before host mutation; only fully prepared files can be used at boot. */
export enum ConnectorNativePhase {
    Preparing = 'preparing',
    Prepared = 'prepared',
}
/** One canonical guest pathname selects the same bounded source-relative file and installed destination. */
export interface ConnectorRuntimeFile {
    readonly path: string;
    readonly sizeBytes: bigint;
    readonly sha256: string;
    readonly mode: ConnectorRuntimeFileMode;
}
/** Local file roots remain separate from program execution grants. */
export interface ConnectorNativeFileRoot {
    readonly id: string;
    readonly path: string;
}
/** Staging paths are derived locally rather than accepted as remote filesystem authority. */
export interface ConnectorNativeFileGrant {
    readonly mode: ConnectorFileMode;
    readonly revision: bigint;
    readonly roots: readonly ConnectorNativeFileRoot[];
}
/** Code paths, workspace aliases, argument rules and resource limits need explicit local approval. */
export interface ConnectorNativeExecutionGrant {
    readonly revision: bigint;
    readonly roots: readonly ExecutionRootPolicy[];
    readonly programs: readonly ExecutionProgramPolicy[];
    readonly resources: ExecutionResourceLimits;
    readonly timeoutMs: number;
    readonly maximumAddressBytes: bigint;
    readonly maximumFileBytes: bigint;
}
/** Operator-approved runtime bytes and confinement policy are private installation inputs, never model parameters. */
export interface ConnectorNativeRequest {
    readonly installationDirectory: string;
    readonly sourceDirectory: string;
    readonly runtimeFiles: readonly ConnectorRuntimeFile[];
    readonly files: ConnectorNativeFileGrant | null;
    readonly execution: ConnectorNativeExecutionGrant;
}
/** Fixed paths belong to this one signed installation and registered system service. */
export interface ConnectorNativeLayout {
    readonly installationDirectory: string;
    readonly directory: string;
    readonly runtimeDirectory: string;
    readonly unitName: string;
    readonly cgroupDirectory: string;
    readonly jobsDirectory: string;
    readonly identity: string;
}
/** The persistent plan binds approved bytes to the original installed release and device/account identity. */
export interface ConnectorNativePlan {
    readonly request: ConnectorNativeRequest;
    readonly releaseSha256: string;
    readonly devicePublicKey: string;
    readonly enrollmentId: string;
    readonly environmentId: string;
    readonly phase: ConnectorNativePhase;
    readonly bubblewrapSha256: string;
}
