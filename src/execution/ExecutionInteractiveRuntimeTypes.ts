// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

import type { ConnectorClientIdentity } from '../runtime/ConnectorClientConfiguration.js';
import type { ExecutionPermit } from './ExecutionJobs.js';
import type {
    ExecutionInteractiveInvocationRule,
    ExecutionInteractiveLaunch,
} from 'nerva-connector-protocol/execution/ExecutionInteractiveInvocation.js';
import type { ExecutionNativePipeHandle } from './ExecutionNativePipeHandle.js';
import type { ExecutionInputJournalOwner } from './ExecutionInputJournalOwner.js';
import type {
    ExecutionInputPermit,
    ExecutionInputAcknowledgment,
    ExecutionInputReceipt,
} from 'nerva-connector-protocol/execution/ExecutionInput.js';

/** The trusted execution owner has already resolved the exact local program and owns sandbox cleanup. */
export interface ExecutionInteractiveRuntimeSettings {
    readonly identity: ConnectorClientIdentity;
    readonly permit: ExecutionPermit;
    readonly rule: ExecutionInteractiveInvocationRule;
    readonly launch: ExecutionInteractiveLaunch;
    readonly incarnation: string;
    readonly native: ExecutionNativePipeHandle;
    readonly journal: ExecutionInputJournalOwner;
    readonly nowMs: () => bigint;
}

/** Recovery owns only durable evidence; it cannot manufacture a native Pipe handle. */
export interface ExecutionInteractiveRuntimeContext {
    readonly identity: ConnectorClientIdentity;
    readonly native: ExecutionNativePipeHandle | null;
    readonly journal: ExecutionInputJournalOwner;
    readonly nowMs: () => bigint;
}

/** At most one backend ACK and one immutable next control are consumed in ACK-first order. */
export interface ExecutionInteractiveRuntimeWork {
    readonly acknowledgment: ExecutionInputAcknowledgment | null;
    readonly permit: ExecutionInputPermit | null;
}

/** Replies contain only journal-durable proofs, never a fabricated native or backend acknowledgment. */
export interface ExecutionInteractiveRuntimeReply {
    readonly acknowledgment: ExecutionInputAcknowledgment | null;
    readonly receipt: ExecutionInputReceipt | null;
}
