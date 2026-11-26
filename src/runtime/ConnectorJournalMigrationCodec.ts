// SPDX-FileCopyrightText: 2026 Dacely <business@dacely.com>
// SPDX-License-Identifier: LicenseRef-Proprietary

import { ConnectorJournalMigrationSourceCodec } from './ConnectorJournalMigrationSourceCodec.js';
import type { ConnectorJournalMigrationSource } from './ConnectorJournalMigrationSource.js';
import type { ConnectorApprovedJournalMigration } from './ConnectorApprovedJournalMigration.js';
import {
    ConnectorJournalSchema,
    ConnectorJournalState,
    type ConnectorJournalSnapshot,
} from './ConnectorJournalState.js';
import type { ConnectorOperationCodec, ConnectorStorageCodec } from './ConnectorOperationCodec.js';

/** This decoder exists only for an explicit, stopped migration owner; normal runtime never constructs it. */
export class ConnectorJournalMigrationCodec<
    TRequest,
    TResponse,
    TProgress = never,
> implements ConnectorStorageCodec<ConnectorJournalSnapshot<TRequest, TResponse, TProgress>> {
    public readonly current: ConnectorJournalState<TRequest, TResponse, TProgress>;
    #original: boolean = false;

    /** Existing concrete request/result/progress validators remain authoritative for both exact source forms. */
    public constructor(
        codec: ConnectorOperationCodec<TRequest, TResponse, TProgress>,
        public readonly approval: ConnectorApprovedJournalMigration | null = null,
    ) {
        this.current = new ConnectorJournalState(codec);
    }

    /** Whether the last authenticated source required explicit conversion rather than normal current decoding. */
    public get original(): boolean {
        return this.#original;
    }

    /** Old snapshots receive only unproven provenance bound to their exact original ciphertext, never invented capture. */
    public read(
        raw: unknown,
        sourceSha256: string,
    ): ConnectorJournalSnapshot<TRequest, TResponse, TProgress> {
        if (
            typeof raw === 'object' &&
            raw !== null &&
            'schema' in raw &&
            raw.schema === ConnectorJournalSchema.AuthorizedEffectContext
        ) {
            const current: ConnectorJournalSnapshot<TRequest, TResponse, TProgress> =
                this.current.read(raw);
            this.#original = false;
            return current;
        }
        const source: ConnectorJournalMigrationSource<TRequest, TResponse, TProgress> =
            new ConnectorJournalMigrationSourceCodec(this.current.codec).read(raw, sourceSha256);
        if (this.approval === null) {
            throw new Error(
                'Historical admission migration requires an explicit signed authority approval; keep all original histories',
            );
        }
        const current: ConnectorJournalSnapshot<TRequest, TResponse, TProgress> =
            this.approval.convert(source, sourceSha256, this.current.codec);
        this.#original = true;
        return current;
    }

    /** Current encoding retains every validated original and exact decimal counter. */
    public encode(snapshot: ConnectorJournalSnapshot<TRequest, TResponse, TProgress>): string {
        return this.current.encode(snapshot);
    }
}
