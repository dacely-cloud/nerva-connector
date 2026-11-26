// SPDX-FileCopyrightText: 2026 Dacely <business@dacely.com>
// SPDX-License-Identifier: LicenseRef-Proprietary

/** Each authenticated record identifies its output lane; termination is explicit. */
export enum StreamChannel {
    Stdout = 'stdout',
    Stderr = 'stderr',
    Terminal = 'terminal',
}

/** Terminal success and failure are authenticated data, never inferred from a closed socket. */
export enum StreamTerminal {
    Exited = 'exited',
    Failed = 'failed',
}

/** Failures expose finite safe codes instead of raw host diagnostics. */
export enum StreamFailure {
    Interrupted = 'interrupted',
    Denied = 'denied',
    Unavailable = 'unavailable',
}

/** Exact sequence and chained commitments reject reorder, substitution, replay and silent truncation. */
export interface StreamRecord {
    readonly sequence: bigint;
    readonly previousSha256: string;
    readonly channel: StreamChannel;
    readonly dataBase64: string;
    readonly terminal: StreamTerminal | null;
    readonly exitCode: number | null;
    readonly failure: StreamFailure | null;
}

/** A caller may consume these bytes only after the owning verifier accepts the complete record. */
export interface VerifiedStreamRecord {
    readonly sequence: bigint;
    readonly channel: StreamChannel;
    readonly data: Buffer;
    readonly terminal: StreamTerminal | null;
    readonly exitCode: number | null;
    readonly failure: StreamFailure | null;
}

/** Trusted operation policy independently caps total bytes and signature work. */
export interface StreamBudget {
    readonly maximumBytes: bigint;
    readonly maximumFrames: bigint;
}

/** Per-frame bounds apply before base64 allocation or signature work. */
export class StreamLimits {
    public static readonly chunkBytes: number = 16384;
    public static readonly maximumBytes: bigint = 1073741824n;
    public static readonly maximumFrames: bigint = 1000000n;
}
