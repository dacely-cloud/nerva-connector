// SPDX-FileCopyrightText: 2026 Dacely <business@dacely.com>
// SPDX-License-Identifier: LicenseRef-Proprietary

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { RuntimeMigrationApprovalFixture } from './support/RuntimeMigrationApprovalFixture.js';
import { ConnectorAdmissionMigrationProof } from 'nerva-connector-protocol/protocol/ConnectorAdmissionMigrationProof.js';
import {
    ConnectorMigrationLane,
    type ConnectorMigrationApproval,
    type ConnectorMigrationPlan,
} from 'nerva-connector-protocol/protocol/ConnectorAdmissionMigration.js';
import { ConnectorOperationSchema } from 'nerva-connector-protocol/protocol/ConnectorOperationSchema.js';
import { FileHistoryFixture } from './support/FileHistoryFixture.js';
import {
    OriginalJournalFixtureCodec,
    type OriginalJournalFixtureSnapshot,
} from './support/OriginalJournalFixtureCodec.js';
import { ConnectorJournalLimits } from '../src/runtime/ConnectorJournalLimits.js';
import { ConnectorJournalStore } from '../src/runtime/ConnectorJournalStore.js';
import {
    ConnectorJournalState,
    type ConnectorJournalSnapshot,
} from '../src/runtime/ConnectorJournalState.js';
import { ConnectorJournalMigrationOwner } from '../src/runtime/ConnectorJournalMigrationOwner.js';
import { ConnectorEffectContextCodec } from '../src/runtime/ConnectorEffectContextCodec.js';
import type { ConnectorEffectContext } from '../src/runtime/ConnectorEffectContext.js';
import {
    ConnectorOperationPurpose,
    type ConnectorOperationCodec,
} from '../src/runtime/ConnectorOperationCodec.js';
import { Boundary } from 'nerva-connector-protocol/protocol/Boundary.js';
import type { ConnectorAuthorization } from 'nerva-connector-protocol/protocol/ConnectorAuthorization.js';
import { ConnectorAuthorizationProof } from 'nerva-connector-protocol/protocol/ConnectorAuthorizationProof.js';

/** This isolated storage test payload is not accepted by any remote file/command capability. */
interface StorageRequest {
    readonly payload: string;
}
/** Its response tests storage correlation only and cannot invoke a program or filesystem operation. */
interface StorageResponse {
    readonly ok: boolean;
}

/** The same core owner can be tested at its exact storage ceiling without inventing a larger production capability. */
class StorageCodec implements ConnectorOperationCodec<StorageRequest, StorageResponse> {
    public readonly purpose: ConnectorOperationPurpose = ConnectorOperationPurpose.Files;
    public readonly progress: null = null;
    public request(raw: unknown): StorageRequest {
        const record: Readonly<Record<string, unknown>> = Boundary.record(raw, ['payload']);
        const value: unknown = record['payload'];
        if (typeof value !== 'string' || value.length > ConnectorJournalLimits.plainBytes) {
            throw new Error('Bounded test storage payload required');
        }
        return { payload: value };
    }
    public response(raw: unknown, _request: StorageRequest): StorageResponse {
        return { ok: Boundary.boolean(Boundary.record(raw, ['ok'])['ok']) };
    }
    public effectContext(raw: unknown, _request: StorageRequest): ConnectorEffectContext {
        return ConnectorEffectContextCodec.read(raw);
    }
    public requestHash(request: StorageRequest): string {
        return createHash('sha256').update(JSON.stringify(request)).digest('hex');
    }
    public admissionHash(requestHash: string, authorization: ConnectorAuthorization): string {
        return ConnectorAuthorizationProof.file(requestHash, authorization);
    }
    public responseHash(response: StorageResponse): string {
        return createHash('sha256').update(JSON.stringify(response)).digest('hex');
    }
}

it.skipIf(
    process.platform !== 'linux' || process.env['NERVA_CONNECTOR_FILES_HELPER'] === undefined,
)(
    'an exact maximum-size old original migrates without truncation and current writes beyond metadata headroom fail atomically',
    async (): Promise<void> => {
        await using fixture: FileHistoryFixture = await FileHistoryFixture.create();
        const operation: StorageCodec = new StorageCodec();
        const originalCodec: OriginalJournalFixtureCodec<StorageRequest, StorageResponse> =
            new OriginalJournalFixtureCodec(operation);
        const empty: OriginalJournalFixtureSnapshot<StorageRequest, StorageResponse> = {
            journalId: 'b'.repeat(64),
            acknowledgedSequence: 0n,
            receipt: null,
            pending: {
                jobId: 'max-original',
                sequence: 1n,
                dispatchId: 'A'.repeat(43),
                requestHash: 'a'.repeat(64),
                request: { payload: '' },
                response: null,
                progress: null,
            },
        };
        const overhead: number = Buffer.byteLength(originalCodec.encode(empty));
        const request: StorageRequest = {
            payload: 'X'.repeat(ConnectorJournalLimits.originalPlainBytes - overhead),
        };
        const original: OriginalJournalFixtureSnapshot<StorageRequest, StorageResponse> = {
            ...empty,
            pending:
                empty.pending === null
                    ? null
                    : { ...empty.pending, request, requestHash: operation.requestHash(request) },
        };
        expect(Buffer.byteLength(originalCodec.encode(original))).toBe(
            ConnectorJournalLimits.originalPlainBytes,
        );
        {
            await using source: ConnectorJournalStore<
                OriginalJournalFixtureSnapshot<StorageRequest, StorageResponse>
            > = await ConnectorJournalStore.open(
                fixture.state,
                fixture.identity.settings.enrollmentId,
                fixture.identity.key,
                operation.purpose,
                originalCodec,
            );
            await source.write(original, false);
        }
        const plan: ConnectorMigrationPlan = ConnectorAdmissionMigrationProof.signPlan(
            fixture.identity.key,
            {
                authorityId: fixture.identity.authority.authorityId,
                environmentId: fixture.identity.settings.environmentId,
                enrollmentId: fixture.identity.settings.enrollmentId,
                devicePublicKey: fixture.identity.publicKey,
                planId: 'TEST-ONLY-storage-ceiling-plan',
                targetOperationSchema: ConnectorOperationSchema.ExplicitAdmission,
                sources: [
                    {
                        lane: ConnectorMigrationLane.Files,
                        sourceSha256: createHash('sha256')
                            .update(await readFile(join(fixture.state, 'file-journal')))
                            .digest('hex'),
                        journalId: original.journalId,
                        acknowledgedSequence: original.acknowledgedSequence,
                        receipt: original.receipt,
                        pending:
                            original.pending === null
                                ? null
                                : {
                                      jobId: original.pending.jobId,
                                      sequence: original.pending.sequence,
                                      dispatchId: original.pending.dispatchId,
                                      requestHash: original.pending.requestHash,
                                  },
                    },
                ],
            },
        );
        const approval: ConnectorMigrationApproval = RuntimeMigrationApprovalFixture.approve(
            fixture.identity,
            plan,
        );
        {
            await using owner: ConnectorJournalMigrationOwner<StorageRequest, StorageResponse> =
                await ConnectorJournalMigrationOwner.load(
                    fixture.state,
                    fixture.identity,
                    operation,
                    approval,
                );
            expect(owner.original).toBe(true);
            await owner.commit();
        }
        const state: ConnectorJournalState<StorageRequest, StorageResponse> =
            new ConnectorJournalState(operation);
        await using current: ConnectorJournalStore<
            ConnectorJournalSnapshot<StorageRequest, StorageResponse>
        > = await ConnectorJournalStore.open(
            fixture.state,
            fixture.identity.settings.enrollmentId,
            fixture.identity.key,
            operation.purpose,
            state,
        );
        const converted: ConnectorJournalSnapshot<StorageRequest, StorageResponse> =
            await current.read();
        expect(Buffer.byteLength(state.encode(converted))).toBeGreaterThan(
            ConnectorJournalLimits.originalPlainBytes,
        );
        expect(Buffer.byteLength(state.encode(converted))).toBeLessThanOrEqual(
            ConnectorJournalLimits.plainBytes,
        );
        expect(converted.pending?.request.payload.length).toBe(request.payload.length);
        expect(converted.pending?.requestHash).toBe(original.pending?.requestHash);
        expect(
            createHash('sha256')
                .update(converted.pending?.request.payload ?? '')
                .digest('hex'),
        ).toBe(createHash('sha256').update(request.payload).digest('hex'));
        const bytes: Buffer = await readFile(join(fixture.state, 'file-journal'));
        const oversized: ConnectorJournalSnapshot<StorageRequest, StorageResponse> = {
            ...converted,
            pending:
                converted.pending === null
                    ? null
                    : {
                          ...converted.pending,
                          request: { payload: 'Y'.repeat(ConnectorJournalLimits.plainBytes + 1) },
                      },
        };
        await expect(current.write(oversized, false)).rejects.toThrow('bound');
        expect((await readFile(join(fixture.state, 'file-journal'))).equals(bytes)).toBe(true);
    },
);
