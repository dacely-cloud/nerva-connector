// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

/**
 * Why one connector socket ended, decided from local evidence only; no remote text selects a reason.
 *
 * @remarks
 * Every failure path used to terminate the socket silently, so a connector that reconnected every 31 s showed only
 * "Can't reach Nerva". The reason now travels with the retry, and the console names it.
 */
export const ConnectorDisconnect = {
    /** Nerva or the network closed the socket. */
    Closed: 'closed',
    /** The socket reported a network error. */
    Network: 'network',
    /** Signing in did not finish in time. */
    HandshakeTimeout: 'handshake-timeout',
    /** The session lease ran out before it was renewed. */
    LeaseExpired: 'lease-expired',
    /** A frame was malformed, too large, too frequent or not valid at this point. */
    InvalidFrame: 'invalid-frame',
    /** Nerva's challenge or lease did not verify, or the sign-in frame could not be sent. */
    Authentication: 'authentication',
    /** A full-computer operation was refused or failed on this computer. */
    Host: 'host',
    /** A file operation was refused or failed on this computer. */
    Files: 'files',
    /** A program run or workspace publication was refused or failed on this computer. */
    Execution: 'execution',
    /** This computer's system details could not be read or sent. */
    Inventory: 'inventory',
} as const;

/** Allowed values derive from the runtime mapping. */
export type ConnectorDisconnect = (typeof ConnectorDisconnect)[keyof typeof ConnectorDisconnect];
