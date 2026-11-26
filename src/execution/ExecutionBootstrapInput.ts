// SPDX-FileCopyrightText: 2026 Dacely <business@dacely.com>
// SPDX-License-Identifier: LicenseRef-Proprietary

import type { ExecutionMachineEnvironmentValue } from 'nerva-connector-protocol/execution/ExecutionMachineInvocation.js';

/** Native helpers accept one explicit current input contract, never omitted-field compatibility. */
export enum ExecutionBootstrapInputKind {
    Fixed = 'fixed',
    Machine = 'machine',
    Pipe = 'pipe',
}
/** Positional programs retain their fixed workspace, empty inherited environment and closed input. */
export interface ExecutionFixedBootstrapInput {
    readonly kind: ExecutionBootstrapInputKind.Fixed;
}
/** The trusted local policy resolves every field before durable native admission. */
export interface ExecutionMachineBootstrapInput {
    readonly kind: ExecutionBootstrapInputKind.Machine;
    readonly cwd: string;
    readonly environment: readonly ExecutionMachineEnvironmentValue[];
    readonly stdin: string;
}
/** An explicitly authorized live-input owner supplies the exact guardian, incarnation and captured finite limits. */
export interface ExecutionPipeBootstrapInput {
    readonly kind: ExecutionBootstrapInputKind.Pipe;
    readonly cwd: string;
    readonly environment: readonly ExecutionMachineEnvironmentValue[];
    readonly stdin: string;
    readonly incarnation: string;
    readonly guardianProfile: string;
    readonly executionDeadlineMs: bigint;
    readonly maximumInputBytes: bigint;
    readonly maximumControls: number;
}
/** Application input is separate from the private launcher JSON transport. */
export type ExecutionBootstrapInput =
    ExecutionFixedBootstrapInput | ExecutionMachineBootstrapInput | ExecutionPipeBootstrapInput;
