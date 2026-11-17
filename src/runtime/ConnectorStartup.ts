// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

import type { ConnectorDisconnect } from './ConnectorDisconnect.js';

/** Local progress names never contain credentials, host addresses, file paths or unverified server text. */
export enum ConnectorStartupStage {
    LocalSecurity = 'Checking secure local storage',
    Configuration = 'Checking saved configuration',
    Identity = 'Preparing device identity',
    PairingState = 'Restoring saved account link',
    FileAccess = 'Checking granted file access',
    CommandAccess = 'Checking granted command access',
    WorkspaceAccess = 'Verifying saved workspace access',
    WorkspacePublication = 'Preparing workspace access',
    WorkspaceOriginals = 'Waiting for existing work to finish',
    Closing = 'Closing previous connection',
    System = 'Reading CPU, memory and GPUs',
    Dns = 'Resolving server address',
    Tcp = 'Connecting to server',
    Tls = 'Verifying TLS certificate',
    Upgrade = 'Opening secure tunnel',
    Rejected = 'Server rejected tunnel',
    PairingRequest = 'Requesting pairing code',
    PairingStatus = 'Checking account link',
    Verification = 'Verifying signed server response',
    Approval = 'Waiting for your approval',
    Saving = 'Saving verified account link',
    Authentication = 'Waiting for server challenge',
    Proof = 'Verifying challenge and signing proof',
    Confirmation = 'Waiting for signed confirmation',
    Retry = 'Waiting to retry connection',
    Ready = 'Authenticated connection ready',
    Stopped = 'Connection stopped',
}
/** Attempts and backoff are controlled local counters, never remote error strings. */
export interface ConnectorStartupProgress {
    readonly stage: ConnectorStartupStage;
    readonly attempt?: number;
    readonly retryAfterMs?: number;
    readonly httpStatus?: number;
    /** Why the previous socket ended, on a retry that follows a connection attempt. */
    readonly disconnect?: ConnectorDisconnect;
}
/** The observer is optional so noninteractive service owners retain their existing output contract. */
export type ConnectorStartupObserver = (progress: ConnectorStartupProgress) => void;
