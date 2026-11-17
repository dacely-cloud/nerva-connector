// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

import { ConnectorJournalMigrationSourceCodec } from '../../src/runtime/ConnectorJournalMigrationSourceCodec.js';
import type { ConnectorJournalMigrationSource } from '../../src/runtime/ConnectorJournalMigrationSource.js';
import type {
    ConnectorJournalPending,
    ConnectorJournalReceipt,
} from '../../src/runtime/ConnectorJournalState.js';
import {
    ConnectorJournalSchema,
    ConnectorJournalState,
} from '../../src/runtime/ConnectorJournalState.js';
import type {
    ConnectorOperationCodec,
    ConnectorStorageCodec,
} from '../../src/runtime/ConnectorOperationCodec.js';

/** The exact old pending shape deliberately contains no physical provenance claim. */
export interface OriginalJournalFixturePending<TRequest, TResponse, TProgress = never> extends Omit<
    ConnectorJournalPending<TRequest, TResponse, TProgress>,
    'effectContext' | 'authorization' | 'admissionHash'
> {}

/** The original compacted receipt never contained an authorization commitment. */
export interface OriginalJournalFixtureReceipt extends Omit<
    ConnectorJournalReceipt,
    'admissionHash'
> {}

/** This old test input is written only for qualification of the explicit production migration. */
export interface OriginalJournalFixtureSnapshot<TRequest, TResponse, TProgress = never> {
    readonly journalId: string;
    readonly acknowledgedSequence: bigint;
    readonly receipt: OriginalJournalFixtureReceipt | null;
    readonly pending: OriginalJournalFixturePending<TRequest, TResponse, TProgress> | null;
}

/** Never imported by runtime: constructs old AES input instead of faking a fresh Historical begin. */
export class OriginalJournalFixtureCodec<
    TRequest,
    TResponse,
    TProgress = never,
> implements ConnectorStorageCodec<OriginalJournalFixtureSnapshot<TRequest, TResponse, TProgress>> {
    public constructor(
        public readonly operation: ConnectorOperationCodec<TRequest, TResponse, TProgress>,
    ) {}
    public read(
        raw: unknown,
        sourceSha256: string,
    ): OriginalJournalFixtureSnapshot<TRequest, TResponse, TProgress> {
        if (
            typeof raw === 'object' &&
            raw !== null &&
            'schema' in raw &&
            raw.schema === ConnectorJournalSchema.AuthorizedEffectContext
        ) {
            const initial: ReturnType<
                ConnectorJournalState<TRequest, TResponse, TProgress>['read']
            > = new ConnectorJournalState(this.operation).read(raw);
            if (
                initial.acknowledgedSequence !== 0n ||
                initial.receipt !== null ||
                initial.pending !== null
            ) {
                throw new Error(
                    'Fixture conversion accepts only a pristine newly initialized journal',
                );
            }
            return {
                journalId: initial.journalId,
                acknowledgedSequence: 0n,
                receipt: null,
                pending: null,
            };
        }
        const state: ConnectorJournalMigrationSource<TRequest, TResponse, TProgress> =
            new ConnectorJournalMigrationSourceCodec(this.operation).read(raw, sourceSha256);
        const pending: ConnectorJournalMigrationSource<TRequest, TResponse, TProgress>['pending'] =
            state.pending;
        return {
            journalId: state.journalId,
            acknowledgedSequence: state.acknowledgedSequence,
            receipt: state.receipt,
            pending:
                pending === null
                    ? null
                    : {
                          jobId: pending.jobId,
                          sequence: pending.sequence,
                          dispatchId: pending.dispatchId,
                          requestHash: pending.requestHash,
                          request: pending.request,
                          response: pending.response,
                          progress: pending.progress,
                      },
        };
    }
    public encode(state: OriginalJournalFixtureSnapshot<TRequest, TResponse, TProgress>): string {
        return JSON.stringify(state, (_key: string, entry: unknown): unknown =>
            typeof entry === 'bigint' ? entry.toString() : entry,
        );
    }
}
