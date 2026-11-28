// SPDX-FileCopyrightText: 2026 Dacely <business@dacely.com>
// SPDX-License-Identifier: LicenseRef-Proprietary

import { ConnectorHostHttpMethod } from 'nerva-connector-protocol/protocol/ConnectorHostArgumentChoices.js';
/** End of HTTP framing is distinct from failed or still-pending input. */
export const HostHttpState = {
    Pending: 'pending',
    Complete: 'complete',
    Failed: 'failed',
} as const;
/** A failed body never becomes successful EOF. */
export type HostHttpState = (typeof HostHttpState)[keyof typeof HostHttpState];

/** Native failures expose no URL, header, credential or OS diagnostic text. */
export const HostHttpFailure = {
    Network: 'network',
    Timeout: 'timeout',
    Limit: 'limit',
    Canceled: 'canceled',
} as const;
/** Failure retains the original transfer until joined explicit cleanup. */
export type HostHttpFailure = (typeof HostHttpFailure)[keyof typeof HostHttpFailure];

/** A fresh private connection uses an exact literal IP and the URL's original TLS identity. */
export interface HostHttpRequest {
    readonly url: string;
    readonly address: string;
    readonly method: ConnectorHostHttpMethod;
    readonly headers: Readonly<Record<string, string>>;
    readonly maximumBytes: bigint;
    readonly timeoutMs: number;
    readonly idleTimeoutMs: number;
}

/** Header metadata is bounded and preserves duplicate field evidence. */
export interface HostHttpHead {
    readonly transferId: string;
    readonly status: number;
    readonly headers: readonly (readonly [string, string])[];
    readonly contentLength: bigint | null;
}

/** A body pull reports exact source bytes and terminal framing separately. */
export interface HostHttpRead {
    readonly transferId: string;
    readonly offset: bigint;
    readonly nextOffset: bigint;
    readonly bytes: Uint8Array;
    readonly state: HostHttpState;
    readonly failure: HostHttpFailure | null;
}

/** Local application-owned trust is never accepted from a remote HTTP tool request. */
export interface HostHttpTrust {
    readonly certificates: readonly string[];
}
