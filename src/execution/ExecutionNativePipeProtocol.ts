// SPDX-FileCopyrightText: 2026 Dacely <business@dacely.com>
// SPDX-License-Identifier: LicenseRef-Proprietary

/** Local broker commands are available only to an explicitly admitted native Pipe owner. */
export enum ExecutionNativePipeCommandKind {
    Data = 'data',
    End = 'end',
}

/** Native readiness is distinct from application byte acceptance. */
export enum ExecutionNativePipeEventKind {
    Ready = 'ready',
    Applied = 'applied',
    Expired = 'expired',
    TimedOut = 'timed-out',
}

/** Negative native notifications cannot authorize input or replace a confirmed cursor. */
export enum ExecutionNativePipeFailure {
    Owner = 'owner',
    Timeout = 'timeout',
}

/** These native ceilings cannot be increased by a malformed local broker command. */
export class ExecutionNativePipeLimits {
    public static readonly frameBytes: number = 4096;
    public static readonly totalBytes: bigint = 65536n;
    public static readonly controls: bigint = 256n;
    public static readonly encodedCommandBytes: number = 8192;
    public static readonly encodedEventBytes: number = 1024;
}

/** Captured local grants may tighten each hard native ceiling and cannot be replaced after admission. */
export interface ExecutionNativePipeBudget {
    readonly maximumInputBytes: bigint;
    readonly maximumControls: number;
}

/** The verified signed-operation owner supplies correlation, not an arbitrary native path or descriptor. */
export interface ExecutionNativePipeControl {
    readonly incarnation: string;
    readonly inputSequence: bigint;
    readonly offset: bigint;
    readonly inputHash: string;
    readonly deliveryExpiresAtMs: bigint;
}

/** Record zero must match the initial input committed in the isolated bootstrap. */
export interface ExecutionNativePipeData extends ExecutionNativePipeControl {
    readonly kind: ExecutionNativePipeCommandKind.Data;
    readonly dataHash: string;
    readonly byteLength: bigint;
    readonly dataBase64: string;
}

/** Real application pipe EOF follows all prior accepted bytes and is not terminal input data. */
export interface ExecutionNativePipeEnd extends ExecutionNativePipeControl {
    readonly kind: ExecutionNativePipeCommandKind.End;
}

/** There is deliberately no PTY, resize, shell, program or network-forward command in this local protocol. */
export type ExecutionNativePipeCommand = ExecutionNativePipeData | ExecutionNativePipeEnd;

/** One detached validated command and its exact serialized bytes are reused through native submission. */
export interface ExecutionNativePipeCapturedCommand {
    readonly command: ExecutionNativePipeCommand;
    readonly encoded: string;
    readonly identity: string;
}

/** This event is emitted only by the supervised native exec owner; output cannot spoof it. */
export interface ExecutionNativePipeReady {
    readonly kind: ExecutionNativePipeEventKind.Ready;
    readonly incarnation: string;
    readonly initialInputBytes: number;
    readonly initialInputHash: string;
}

/** Accepted offsets describe successful kernel writes, never application consumption or command success. */
export interface ExecutionNativePipeApplied {
    readonly kind: ExecutionNativePipeEventKind.Applied;
    readonly incarnation: string;
    readonly inputSequence: bigint;
    readonly inputHash: string;
    readonly acceptedOffset: bigint;
    readonly ended: boolean;
}

/** Expiry exposes only the prior fully confirmed range, never a guessed partial write or EOF. */
export interface ExecutionNativePipeExpired {
    readonly kind: ExecutionNativePipeEventKind.Expired;
    readonly incarnation: string;
    readonly inputSequence: bigint;
    readonly inputHash: string;
    readonly confirmedOffset: bigint;
}

/** Only the native original-lifetime cutoff supplies this timeout classification; no input is accepted. */
export interface ExecutionNativePipeTimedOut {
    readonly kind: ExecutionNativePipeEventKind.TimedOut;
    readonly incarnation: string;
}

/** Native EOF, setup failure or owner death is not a fabricated Applied event. */
export type ExecutionNativePipeEvent =
    | ExecutionNativePipeReady
    | ExecutionNativePipeApplied
    | ExecutionNativePipeExpired
    | ExecutionNativePipeTimedOut;
