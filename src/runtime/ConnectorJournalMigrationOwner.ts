// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

import { ConnectorJournalLimits } from './ConnectorJournalLimits.js';
import { createHash } from 'node:crypto';
import type { ConnectorClientIdentity } from './ConnectorClientConfiguration.js';
import { ConnectorJournalStore, ConnectorJournalOpenIntent } from './ConnectorJournalStore.js';
import type { ConnectorJournalRecord } from './ConnectorJournalRecord.js';
import type { ConnectorJournalSnapshot } from './ConnectorJournalState.js';
import { ConnectorJournalMigrationCodec } from './ConnectorJournalMigrationCodec.js';
import type { ConnectorOperationCodec } from './ConnectorOperationCodec.js';
import type { ConnectorHistoryMigrationEntry } from './ConnectorHistoryMigrationMarker.js';
import { ConnectorEffectKind } from './ConnectorEffectContext.js';
import { ConnectorApprovedJournalMigration } from './ConnectorApprovedJournalMigration.js';
import type {
    ConnectorMigrationApproval,
    ConnectorMigrationTarget,
} from 'nerva-connector-protocol/protocol/ConnectorAdmissionMigration.js';

/** A common bounded plan permits heterogeneous file/command histories while every owner keeps its concrete types. */
export interface ConnectorHistoryMigrationPlan extends AsyncDisposable {
    readonly entry: ConnectorHistoryMigrationEntry;
    readonly original: boolean;
    readonly historicalPending: boolean;
    match(expected: ConnectorHistoryMigrationEntry, complete: boolean): void;
    commit(): Promise<void>;
    target(): Promise<ConnectorMigrationTarget>;
}

/** One existing encrypted store retains its original process lock throughout validation, conversion and verification. */
export class ConnectorJournalMigrationOwner<
    TRequest,
    TResponse,
    TProgress = never,
> implements ConnectorHistoryMigrationPlan {
    readonly #store: ConnectorJournalStore<
        ConnectorJournalSnapshot<TRequest, TResponse, TProgress>
    >;
    readonly #codec: ConnectorJournalMigrationCodec<TRequest, TResponse, TProgress>;
    readonly #snapshot: ConnectorJournalSnapshot<TRequest, TResponse, TProgress>;
    private constructor(
        store: ConnectorJournalStore<ConnectorJournalSnapshot<TRequest, TResponse, TProgress>>,
        codec: ConnectorJournalMigrationCodec<TRequest, TResponse, TProgress>,
        snapshot: ConnectorJournalSnapshot<TRequest, TResponse, TProgress>,
        public readonly entry: ConnectorHistoryMigrationEntry,
        public readonly original: boolean,
    ) {
        this.#store = store;
        this.#codec = codec;
        this.#snapshot = snapshot;
    }

    /** Missing or undecodable originals are refused before any marker or retained-history write. */
    public static async load<TRequest, TResponse, TProgress = never>(
        directory: string,
        identity: ConnectorClientIdentity,
        operation: ConnectorOperationCodec<TRequest, TResponse, TProgress>,
        approval: ConnectorMigrationApproval,
    ): Promise<ConnectorJournalMigrationOwner<TRequest, TResponse, TProgress>> {
        const codec: ConnectorJournalMigrationCodec<TRequest, TResponse, TProgress> =
            new ConnectorJournalMigrationCodec(
                operation,
                ConnectorApprovedJournalMigration.create(identity, approval, operation.purpose),
            );
        const store: ConnectorJournalStore<
            ConnectorJournalSnapshot<TRequest, TResponse, TProgress>
        > = await ConnectorJournalStore.open(
            directory,
            identity.settings.enrollmentId,
            identity.key,
            operation.purpose,
            codec,
            ConnectorJournalOpenIntent.Migration,
        );
        try {
            const record: ConnectorJournalRecord<
                ConnectorJournalSnapshot<TRequest, TResponse, TProgress>
            > = await store.readRecord();
            const plain: Buffer = Buffer.from(codec.encode(record.state));
            try {
                if (plain.byteLength > ConnectorJournalLimits.plainBytes) {
                    throw new Error('Converted history exceeds its existing storage bound');
                }
                return new ConnectorJournalMigrationOwner(
                    store,
                    codec,
                    record.state,
                    {
                        purpose: operation.purpose,
                        sourceSha256: record.sourceSha256,
                        expectedPlainSha256: createHash('sha256').update(plain).digest('hex'),
                    },
                    codec.original,
                );
            } finally {
                plain.fill(0);
            }
        } catch (caught: unknown) {
            await store[Symbol.asyncDispose]();
            throw caught;
        }
    }

    /** Historical pending work is retained explicitly without creating missing physical provenance. */
    public get historicalPending(): boolean {
        return (
            this.#snapshot.pending?.effectContext.kind === ConnectorEffectKind.HistoricalUnproven
        );
    }

    /** An incomplete attempt permits only its exact source or exact converted target; completed receipts may coexist with later legitimate current work. */
    public match(expected: ConnectorHistoryMigrationEntry, complete: boolean): void {
        if (
            expected.purpose !== this.entry.purpose ||
            (complete
                ? this.original
                : expected.expectedPlainSha256 !== this.entry.expectedPlainSha256 ||
                  (this.original && expected.sourceSha256 !== this.entry.sourceSha256))
        ) {
            throw new Error('Retained migration source or target changed');
        }
    }

    /** A prepared global marker must already be durable before this local atomic replacement begins. */
    public async commit(): Promise<void> {
        if (this.original) {
            await this.#store.write(this.#snapshot, false);
        }
        const actual: ConnectorJournalRecord<
            ConnectorJournalSnapshot<TRequest, TResponse, TProgress>
        > = await this.#store.readRecord();
        const plain: Buffer = Buffer.from(this.#codec.encode(actual.state));
        try {
            if (
                this.#codec.original ||
                createHash('sha256').update(plain).digest('hex') !== this.entry.expectedPlainSha256
            ) {
                throw new Error('Converted history durability is unconfirmed');
            }
        } finally {
            plain.fill(0);
        }
    }

    /** Device conversion evidence records actual durable ciphertext and plaintext after exact target verification. */
    public async target(): Promise<ConnectorMigrationTarget> {
        const actual: ConnectorJournalRecord<
            ConnectorJournalSnapshot<TRequest, TResponse, TProgress>
        > = await this.#store.readRecord();
        const plain: Buffer = Buffer.from(this.#codec.encode(actual.state));
        try {
            const plainSha256: string = createHash('sha256').update(plain).digest('hex');
            if (this.#codec.original || plainSha256 !== this.entry.expectedPlainSha256) {
                throw new Error('Migration target changed before applied attestation');
            }
            return {
                lane: ConnectorApprovedJournalMigration.lane(this.#store.purpose),
                plainSha256,
                cipherSha256: actual.sourceSha256,
            };
        } finally {
            plain.fill(0);
        }
    }

    /** The original encryption key and exclusive process lock remain owned until all writes and reads have joined. */
    public async [Symbol.asyncDispose](): Promise<void> {
        await this.#store[Symbol.asyncDispose]();
    }
}
