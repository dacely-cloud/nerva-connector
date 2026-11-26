// SPDX-FileCopyrightText: 2026 Dacely <business@dacely.com>
// SPDX-License-Identifier: LicenseRef-Proprietary

import { resolve } from 'node:path';
import { AdmissionMigrationFixture } from './AdmissionMigrationFixture.js';
import {
    OriginalJournalFixtureCodec,
    type OriginalJournalFixtureSnapshot,
} from './OriginalJournalFixtureCodec.js';
import { ConnectorJournalCipher } from '../../src/runtime/ConnectorJournalCipher.js';
import { ConnectorJournalMigrationSourceCodec } from '../../src/runtime/ConnectorJournalMigrationSourceCodec.js';
import {
    ConnectorMigrationSourceSchema,
    type ConnectorJournalMigrationSource,
} from '../../src/runtime/ConnectorJournalMigrationSource.js';
import { ConnectorApprovedJournalMigration } from '../../src/runtime/ConnectorApprovedJournalMigration.js';
import type {
    ConnectorOperationPurpose,
    ConnectorOperationCodec,
    ConnectorStorageCodec,
} from '../../src/runtime/ConnectorOperationCodec.js';
import type { ConnectorJournalRecord } from '../../src/runtime/ConnectorJournalRecord.js';
import type { ConnectorEffectContext } from '../../src/runtime/ConnectorEffectContext.js';
import type { ConnectorClientIdentity } from '../../src/runtime/ConnectorClientConfiguration.js';
import { ConnectorAdmissionMigrationProof as Proof } from 'nerva-connector-protocol/protocol/ConnectorAdmissionMigrationProof.js';
import { SigningKey } from '../../src/identity/SigningKey.js';
import {
    ConnectorMigrationLane,
    type ConnectorMigrationPlan,
    type ConnectorMigrationApproval,
    type ConnectorMigrationSource,
} from 'nerva-connector-protocol/protocol/ConnectorAdmissionMigration.js';
import { type ConnectorFileResponse } from 'nerva-connector-protocol/protocol/ConnectorFiles.js';
import { ConnectorFileKind } from 'nerva-connector-protocol/protocol/ConnectorFileTypes.js';
import { ConnectorFileAction } from 'nerva-connector-protocol/protocol/ConnectorFileTypes.js';
import type { ConnectorFileOperation } from 'nerva-connector-protocol/protocol/ConnectorFileJobs.js';
/** This read-only adapter authenticates actual old AES bytes before invoking the production stopped source decoder. */
class SourceReader<TRequest, TResponse, TProgress = never> implements ConnectorStorageCodec<
    ConnectorJournalMigrationSource<TRequest, TResponse, TProgress>
> {
    readonly #source: ConnectorJournalMigrationSourceCodec<TRequest, TResponse, TProgress>;
    public constructor(operation: ConnectorOperationCodec<TRequest, TResponse, TProgress>) {
        this.#source = new ConnectorJournalMigrationSourceCodec(operation);
    }
    public read(
        raw: unknown,
        sourceSha256: string,
    ): ConnectorJournalMigrationSource<TRequest, TResponse, TProgress> {
        return this.#source.read(raw, sourceSha256);
    }
    public encode(_state: ConnectorJournalMigrationSource<TRequest, TResponse, TProgress>): string {
        throw new Error('Read-only historical qualification adapter');
    }
}

/** Exact old contextual storage adds only its mandatory provenance to the same original no-admission payload. */
export interface ContextualHistorySnapshot<
    TRequest,
    TResponse,
    TProgress = never,
> extends OriginalJournalFixtureSnapshot<TRequest, TResponse, TProgress> {
    readonly schema: ConnectorMigrationSourceSchema.EffectContext;
    readonly pending: ContextualHistoryPending<TRequest, TResponse, TProgress> | null;
}

/** Synthetic captures test authenticated preservation, without claiming native identity evidence. */
interface ContextualHistoryPending<TRequest, TResponse, TProgress> {
    readonly jobId: string;
    readonly sequence: bigint;
    readonly dispatchId: string;
    readonly requestHash: string;
    readonly request: TRequest;
    readonly response: TResponse | null;
    readonly progress: TProgress | null;
    readonly effectContext: ConnectorEffectContext;
}

/** Test-only encrypted buffers share the real operation key, purpose and AAD without creating files, locks or native effects. */
export class AuthenticatedHistory<TRequest, TResponse, TProgress = never> implements Disposable {
    public readonly bytes: Buffer;
    public readonly record: ConnectorJournalRecord<
        ConnectorJournalMigrationSource<TRequest, TResponse, TProgress>
    >;
    public constructor(
        fixture: AdmissionMigrationFixture,
        operation: ConnectorOperationCodec<TRequest, TResponse, TProgress>,
        snapshot: OriginalJournalFixtureSnapshot<TRequest, TResponse, TProgress>,
    ) {
        const directory: string = resolve('migration-qualification-' + operation.purpose);
        using writer: ConnectorJournalCipher<
            OriginalJournalFixtureSnapshot<TRequest, TResponse, TProgress>
        > = ConnectorJournalCipher.create(
            directory,
            fixture.scope.enrollmentId,
            fixture.device,
            operation.purpose,
            new OriginalJournalFixtureCodec(operation),
        );
        this.bytes = writer.encode(snapshot);
        try {
            using reader: ConnectorJournalCipher<
                ConnectorJournalMigrationSource<TRequest, TResponse, TProgress>
            > = ConnectorJournalCipher.create(
                directory,
                fixture.scope.enrollmentId,
                fixture.device,
                operation.purpose,
                new SourceReader(operation),
            );
            this.record = reader.decode(this.bytes);
        } catch (caught: unknown) {
            this.bytes.fill(0);
            throw caught;
        }
    }
    public [Symbol.dispose](): void {
        this.bytes.fill(0);
    }
}

/** Identity pins are generated test-only inputs; this pure converter never opens or trusts these synthetic configuration paths. */
export function migrationIdentity(fixture: AdmissionMigrationFixture): ConnectorClientIdentity {
    return {
        configurationFile: '/owned-qualification/device.json',
        key: fixture.device,
        publicKey: fixture.device.publicKey,
        ca: undefined,
        authority: {
            authorityId: fixture.scope.authorityId,
            publicKey: fixture.authority.publicKey,
        },
        settings: {
            authorityId: fixture.scope.authorityId,
            authorityPublicKeyFile: '/owned-qualification/authority.json',
            environmentId: fixture.scope.environmentId,
            enrollmentId: fixture.scope.enrollmentId,
            slot: 0,
            endpoints: ['wss://unused.invalid/tunnel'],
            privateKeyFile: '/owned-qualification/device-key.json',
            serverCaFile: null,
            files: null,
            execution: null,
        },
    };
}

/** Real old source correlations become a device-signed source plan without copying plaintext requests or results into the certificate. */
export function migrationApproval<TRequest, TResponse, TProgress>(
    fixture: AdmissionMigrationFixture,
    history: AuthenticatedHistory<TRequest, TResponse, TProgress>,
    purpose: ConnectorOperationPurpose,
    joint: boolean = false,
): ConnectorMigrationApproval {
    const source: ConnectorJournalMigrationSource<TRequest, TResponse, TProgress> =
        history.record.state;
    const entry: ConnectorMigrationSource = {
        lane: ConnectorApprovedJournalMigration.lane(purpose),
        sourceSha256: history.record.sourceSha256,
        journalId: source.journalId,
        acknowledgedSequence: source.acknowledgedSequence,
        receipt: source.receipt,
        pending:
            source.pending === null
                ? null
                : {
                      jobId: source.pending.jobId,
                      sequence: source.pending.sequence,
                      dispatchId: source.pending.dispatchId,
                      requestHash: source.pending.requestHash,
                  },
    };
    const plan: ConnectorMigrationPlan = Proof.signPlan(fixture.device, {
        ...fixture.planBody(),
        sources: [entry],
    });
    return Proof.signApproval(
        SigningKey,
        fixture.authority,
        fixture.scope,
        fixture.approvalBody(plan, joint ? fixture.authorization : fixture.independent),
    );
}

/** Original old history has no authorization envelope; its existing receipt and response are preserved byte-for-byte. */
export function migrationFileSnapshot(
    fixture: AdmissionMigrationFixture,
): OriginalJournalFixtureSnapshot<ConnectorFileOperation, ConnectorFileResponse> {
    const source: ConnectorMigrationSource = fixture.source(ConnectorMigrationLane.Files);
    if (source.pending === null || source.receipt === null) {
        throw new Error('Both exact original headers required');
    }
    return {
        journalId: source.journalId,
        acknowledgedSequence: source.acknowledgedSequence,
        receipt: source.receipt,
        pending: {
            ...source.pending,
            request: fixture.fileRequest,
            response: {
                ok: true,
                result: {
                    action: ConnectorFileAction.Read,
                    requestId: fixture.fileRequest.requestId,
                    offset: fixture.fileRequest.offset,
                    dataBase64: 'AP8=',
                    metadata: {
                        kind: ConnectorFileKind.File,
                        sizeBytes: fixture.fileRequest.offset + 2n,
                        modifiedAtNs: 9007199254740995n,
                        mode: 384,
                    },
                },
            },
            progress: null,
        },
    };
}
