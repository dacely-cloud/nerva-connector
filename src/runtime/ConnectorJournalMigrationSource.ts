// SPDX-FileCopyrightText: 2026 Dacely <business@dacely.com>
// SPDX-License-Identifier: LicenseRef-Proprietary

import type { ConnectorEffectContext } from './ConnectorEffectContext.js';

/** Historical format selection exists only in the stopped migration decoder. */
export enum ConnectorMigrationSourceSchema {
    Original = 'original-journal',
    EffectContext = 'effect-context',
}

/** Original receipt fields are retained exactly; absent admission authority is never inferred. */
export interface ConnectorMigrationSourceReceipt {
    readonly jobId: string;
    readonly sequence: bigint;
    readonly dispatchId: string;
    readonly requestHash: string;
    readonly responseHash: string;
}

/** Historical effect evidence and payload remain distinct from authority granted by an explicit migration approval. */
export interface ConnectorMigrationSourcePending<
    TRequest,
    TResponse,
    TProgress = never,
> extends Omit<ConnectorMigrationSourceReceipt, 'responseHash'> {
    readonly request: TRequest;
    readonly effectContext: ConnectorEffectContext;
    readonly response: TResponse | null;
    readonly progress: TProgress | null;
}

/** Exact old state can be inspected without manufacturing a current authorized journal. */
export interface ConnectorJournalMigrationSource<TRequest, TResponse, TProgress = never> {
    readonly schema: ConnectorMigrationSourceSchema;
    readonly journalId: string;
    readonly acknowledgedSequence: bigint;
    readonly receipt: ConnectorMigrationSourceReceipt | null;
    readonly pending: ConnectorMigrationSourcePending<TRequest, TResponse, TProgress> | null;
}
