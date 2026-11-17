// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

import { Boundary } from 'nerva-connector-protocol/protocol/Boundary.js';
import { ConnectorEnrollmentCodec } from 'nerva-connector-protocol/protocol/ConnectorEnrollmentCodec.js';
import { ConnectorDeviceCodec } from 'nerva-connector-protocol/protocol/ConnectorDeviceCodec.js';
import { ConnectorEffectKind, type ConnectorEffectContext } from './ConnectorEffectContext.js';
import type { ConnectorOperationCodec } from './ConnectorOperationCodec.js';
import {
    ConnectorMigrationSourceSchema,
    type ConnectorJournalMigrationSource,
    type ConnectorMigrationSourceReceipt,
    type ConnectorMigrationSourcePending,
} from './ConnectorJournalMigrationSource.js';

/** Stopped migration alone accepts these exact old storage forms, without granting missing admission authority. */
export class ConnectorJournalMigrationSourceCodec<TRequest, TResponse, TProgress = never> {
    /** Concrete payload, effect and progress validators remain authoritative for historical data. */
    public constructor(
        public readonly operation: ConnectorOperationCodec<TRequest, TResponse, TProgress>,
    ) {}

    /** Source ciphertext identity binds any explicitly unproven historical provenance to the original bytes. */
    public read(
        raw: unknown,
        sourceSha256: string,
    ): ConnectorJournalMigrationSource<TRequest, TResponse, TProgress> {
        const withContext: boolean = typeof raw === 'object' && raw !== null && 'schema' in raw;
        const value: Readonly<Record<string, unknown>> = Boundary.record(raw, [
            ...(withContext ? ['schema'] : []),
            'journalId',
            'acknowledgedSequence',
            'receipt',
            'pending',
        ]);
        if (withContext && value['schema'] !== ConnectorMigrationSourceSchema.EffectContext) {
            throw new Error('Unsupported historical journal migration source');
        }
        const acknowledgedSequence: bigint = Boundary.integer(value['acknowledgedSequence']);
        const receipt: ConnectorMigrationSourceReceipt | null =
            value['receipt'] === null ? null : this.#receipt(value['receipt']);
        const pending: ConnectorMigrationSourcePending<TRequest, TResponse, TProgress> | null =
            value['pending'] === null
                ? null
                : this.#pending(value['pending'], withContext, sourceSha256);
        if (
            (acknowledgedSequence === 0n) !== (receipt === null) ||
            (receipt !== null && receipt.sequence !== acknowledgedSequence) ||
            (pending !== null && pending.sequence !== acknowledgedSequence + 1n)
        ) {
            throw new Error('Historical journal ordering is inconsistent');
        }
        return {
            schema: withContext
                ? ConnectorMigrationSourceSchema.EffectContext
                : ConnectorMigrationSourceSchema.Original,
            journalId: ConnectorEnrollmentCodec.digest(value['journalId']),
            acknowledgedSequence,
            receipt,
            pending,
        };
    }

    #receipt(raw: unknown): ConnectorMigrationSourceReceipt {
        const value: Readonly<Record<string, unknown>> = Boundary.record(raw, [
            'jobId',
            'sequence',
            'dispatchId',
            'requestHash',
            'responseHash',
        ]);
        const sequence: bigint = Boundary.integer(value['sequence']);
        if (sequence === 0n) {
            throw new Error('Historical receipt sequence must be positive');
        }
        return {
            jobId: Boundary.id(value['jobId']),
            sequence,
            dispatchId: ConnectorDeviceCodec.nonce(value['dispatchId']),
            requestHash: ConnectorEnrollmentCodec.digest(value['requestHash']),
            responseHash: ConnectorEnrollmentCodec.digest(value['responseHash']),
        };
    }

    #pending(
        raw: unknown,
        withContext: boolean,
        sourceSha256: string,
    ): ConnectorMigrationSourcePending<TRequest, TResponse, TProgress> {
        const value: Readonly<Record<string, unknown>> = Boundary.record(raw, [
            'jobId',
            'sequence',
            'dispatchId',
            'requestHash',
            'request',
            ...(withContext ? ['effectContext'] : []),
            'response',
            'progress',
        ]);
        const request: TRequest = this.operation.request(value['request']);
        const requestHash: string = ConnectorEnrollmentCodec.digest(value['requestHash']);
        const sequence: bigint = Boundary.integer(value['sequence']);
        if (sequence === 0n || requestHash !== this.operation.requestHash(request)) {
            throw new Error('Historical original request commitment changed');
        }
        const effectContext: ConnectorEffectContext = withContext
            ? this.operation.effectContext(value['effectContext'], request)
            : {
                  kind: ConnectorEffectKind.HistoricalUnproven,
                  sourceSha256: ConnectorEnrollmentCodec.digest(sourceSha256),
              };
        const response: TResponse | null =
            value['response'] === null
                ? null
                : this.operation.response(value['response'], request, effectContext);
        let progress: TProgress | null = null;
        if (value['progress'] !== null) {
            if (this.operation.progress === null || response !== null) {
                throw new Error('Historical progress cannot replace a terminal result');
            }
            progress = this.operation.progress.read(value['progress'], request, effectContext);
        }
        return {
            jobId: Boundary.id(value['jobId']),
            sequence,
            dispatchId: ConnectorDeviceCodec.nonce(value['dispatchId']),
            requestHash,
            request,
            effectContext,
            response,
            progress,
        };
    }
}
