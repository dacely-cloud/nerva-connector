// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

import { createHash } from 'node:crypto';
import { expect, it } from 'vitest';
import { AdmissionMigrationFixture } from './support/AdmissionMigrationFixture.js';
import {
    AuthenticatedHistory,
    migrationIdentity,
    migrationApproval,
    migrationFileSnapshot,
    type ContextualHistorySnapshot,
} from './support/ApprovedMigrationHistory.js';
import { Boundary } from 'nerva-connector-protocol/protocol/Boundary.js';
import {
    OriginalJournalFixtureCodec,
    type OriginalJournalFixtureSnapshot,
} from './support/OriginalJournalFixtureCodec.js';
import { JournalEffectFixture } from './support/JournalEffectFixture.js';
import { ConnectorJournalMigrationSourceCodec } from '../src/runtime/ConnectorJournalMigrationSourceCodec.js';
import {
    ConnectorMigrationSourceSchema,
    type ConnectorJournalMigrationSource,
} from '../src/runtime/ConnectorJournalMigrationSource.js';
import { ConnectorApprovedJournalMigration } from '../src/runtime/ConnectorApprovedJournalMigration.js';
import { ConnectorJournalMigrationCodec } from '../src/runtime/ConnectorJournalMigrationCodec.js';
import { ConnectorFileJournalCodec } from '../src/runtime/ConnectorFileJournalCodec.js';
import {
    ConnectorJournalState,
    ConnectorJournalSchema,
    type ConnectorJournalSnapshot,
} from '../src/runtime/ConnectorJournalState.js';
import { ConnectorOperationPurpose } from '../src/runtime/ConnectorOperationCodec.js';
import type { ConnectorClientIdentity } from '../src/runtime/ConnectorClientConfiguration.js';
import { ConnectorEffectKind } from '../src/runtime/ConnectorEffectContext.js';
import { ConnectorAdmissionMigrationProof as Proof } from 'nerva-connector-protocol/protocol/ConnectorAdmissionMigrationProof.js';
import {
    ConnectorMigrationLane,
    type ConnectorMigrationApproval,
    type ConnectorMigrationSource,
} from 'nerva-connector-protocol/protocol/ConnectorAdmissionMigration.js';
import { type ConnectorFileResponse } from 'nerva-connector-protocol/protocol/ConnectorFiles.js';
import type { ConnectorFileOperation } from 'nerva-connector-protocol/protocol/ConnectorFileJobs.js';
import { ExecutionJournalCodec } from '../src/execution/ExecutionJournalCodec.js';
import { type ExecutionRequest } from 'nerva-connector-protocol/execution/ExecutionJobs.js';
import { ExecutionLane } from 'nerva-connector-protocol/execution/ExecutionLane.js';
import type { ExecutionResult } from 'nerva-connector-protocol/execution/ExecutionTypes.js';
import type { ExecutionOutput } from 'nerva-connector-protocol/execution/ExecutionOutput.js';
import { SigningKey } from '../src/identity/SigningKey.js';

it('authenticated original no-authority AES history preserves exact receipt, binary response, provenance and >53-bit counters through approved conversion', (): void => {
    using fixture: AdmissionMigrationFixture = new AdmissionMigrationFixture();
    const operation: ConnectorFileJournalCodec = new ConnectorFileJournalCodec();
    const snapshot: OriginalJournalFixtureSnapshot<ConnectorFileOperation, ConnectorFileResponse> =
        migrationFileSnapshot(fixture);
    using history: AuthenticatedHistory<ConnectorFileOperation, ConnectorFileResponse> =
        new AuthenticatedHistory(fixture, operation, snapshot);
    const before: Buffer = Buffer.from(history.bytes);
    try {
        expect(history.record.sourceSha256).toBe(
            createHash('sha256').update(history.bytes).digest('hex'),
        );
        expect(history.record.state.schema).toBe(ConnectorMigrationSourceSchema.Original);
        expect(history.record.state.receipt).toEqual(snapshot.receipt);
        expect(history.record.state.pending?.response).toEqual(snapshot.pending?.response);
        expect(history.record.state.pending?.effectContext).toEqual({
            kind: ConnectorEffectKind.HistoricalUnproven,
            sourceSha256: history.record.sourceSha256,
        });
        const certificate: ConnectorMigrationApproval = migrationApproval(
            fixture,
            history,
            operation.purpose,
        );
        const converter: ConnectorApprovedJournalMigration =
            ConnectorApprovedJournalMigration.create(
                migrationIdentity(fixture),
                certificate,
                operation.purpose,
            );
        const target: ConnectorJournalSnapshot<ConnectorFileOperation, ConnectorFileResponse> =
            converter.convert(history.record.state, history.record.sourceSha256, operation);
        expect(target.schema).toBe(ConnectorJournalSchema.AuthorizedEffectContext);
        expect(target.acknowledgedSequence).toBe(9007199254740993n);
        expect(target.pending?.sequence).toBe(9007199254740994n);
        expect(target.pending?.request).toEqual(snapshot.pending?.request);
        expect(target.pending?.response).toEqual(snapshot.pending?.response);
        expect(target.pending?.effectContext).toEqual(history.record.state.pending?.effectContext);
        expect(target.receipt).toEqual({
            ...snapshot.receipt,
            admissionHash: operation.admissionHash(
                snapshot.receipt?.requestHash ?? '',
                fixture.independent,
            ),
        });
        expect(history.bytes).toEqual(before);
        expect((): ConnectorJournalSnapshot<ConnectorFileOperation, ConnectorFileResponse> =>
            new ConnectorJournalState(operation).read(
                JSON.parse(new OriginalJournalFixtureCodec(operation).encode(snapshot)),
            ),
        ).toThrow('migration');
    } finally {
        before.fill(0);
    }
});

it('old effect-context captures and retained command binary prefixes survive exactly, without turning them into new physical evidence', (): void => {
    using fixture: AdmissionMigrationFixture = new AdmissionMigrationFixture();
    const files: ConnectorFileJournalCodec = new ConnectorFileJournalCodec();
    const snapshot: OriginalJournalFixtureSnapshot<ConnectorFileOperation, ConnectorFileResponse> =
        migrationFileSnapshot(fixture);
    const contextual: ContextualHistorySnapshot<ConnectorFileOperation, ConnectorFileResponse> = {
        schema: ConnectorMigrationSourceSchema.EffectContext,
        ...snapshot,
        pending:
            snapshot.pending === null
                ? null
                : {
                      ...snapshot.pending,
                      effectContext: JournalEffectFixture.file(fixture.fileRequest),
                  },
    };
    using capturedHistory: AuthenticatedHistory<ConnectorFileOperation, ConnectorFileResponse> =
        new AuthenticatedHistory<ConnectorFileOperation, ConnectorFileResponse>(
            fixture,
            files,
            contextual,
        );
    const fileSource: ConnectorJournalMigrationSource<
        ConnectorFileOperation,
        ConnectorFileResponse
    > = capturedHistory.record.state;
    expect(fileSource.schema).toBe(ConnectorMigrationSourceSchema.EffectContext);
    expect(fileSource.pending?.effectContext).toEqual(
        JournalEffectFixture.file(fixture.fileRequest),
    );
    const fileConverter: ConnectorApprovedJournalMigration =
        ConnectorApprovedJournalMigration.create(
            migrationIdentity(fixture),
            migrationApproval(fixture, capturedHistory, files.purpose),
            files.purpose,
        );
    const convertedFile: ConnectorJournalSnapshot<ConnectorFileOperation, ConnectorFileResponse> =
        fileConverter.convert(fileSource, capturedHistory.record.sourceSha256, files);
    expect(convertedFile.pending?.effectContext).toEqual(fileSource.pending?.effectContext);
    expect(convertedFile.pending?.response).toEqual(fileSource.pending?.response);
    const captured: unknown = JSON.parse(
        JSON.stringify(contextual, (_key: string, value: unknown): unknown =>
            typeof value === 'bigint' ? value.toString() : value,
        ),
    );
    const commands: ExecutionJournalCodec = new ExecutionJournalCodec(ExecutionLane.First);
    const source: ConnectorMigrationSource = fixture.source(ConnectorMigrationLane.ExecutionFirst);
    if (source.pending === null) {
        throw new Error('Command original required');
    }
    const command: OriginalJournalFixtureSnapshot<
        ExecutionRequest,
        ExecutionResult,
        ExecutionOutput
    > = {
        journalId: source.journalId,
        acknowledgedSequence: source.acknowledgedSequence,
        receipt: source.receipt,
        pending: {
            ...source.pending,
            request: fixture.executionRequest,
            response: null,
            progress: { stdoutBase64: 'AP8=', stderrBase64: '77u/' },
        },
    };
    using history: AuthenticatedHistory<ExecutionRequest, ExecutionResult, ExecutionOutput> =
        new AuthenticatedHistory(fixture, commands, command);
    const converter: ConnectorApprovedJournalMigration = ConnectorApprovedJournalMigration.create(
        migrationIdentity(fixture),
        migrationApproval(fixture, history, commands.purpose),
        commands.purpose,
    );
    const target: ConnectorJournalSnapshot<ExecutionRequest, ExecutionResult, ExecutionOutput> =
        converter.convert(history.record.state, history.record.sourceSha256, commands);
    expect(target.pending?.progress).toEqual(command.pending?.progress);
    expect(target.pending?.effectContext).toEqual({
        kind: ConnectorEffectKind.HistoricalUnproven,
        sourceSha256: history.record.sourceSha256,
    });
    expect(target.pending?.response).toBeNull();
    expect(target.receipt?.sequence).toBe(9007199254740993n);
    expect(() =>
        new ConnectorJournalMigrationSourceCodec(commands).read(
            {
                ...Boundary.record(captured, [
                    'schema',
                    'journalId',
                    'acknowledgedSequence',
                    'receipt',
                    'pending',
                ]),
                schema: ConnectorJournalSchema.AuthorizedEffectContext,
            },
            history.record.sourceSha256,
        ),
    ).toThrow();
});

it('every original header, watermark, journal identity and complete encrypted snapshot must still match the signed plan before conversion', (): void => {
    using fixture: AdmissionMigrationFixture = new AdmissionMigrationFixture();
    const operation: ConnectorFileJournalCodec = new ConnectorFileJournalCodec();
    using history: AuthenticatedHistory<ConnectorFileOperation, ConnectorFileResponse> =
        new AuthenticatedHistory(fixture, operation, migrationFileSnapshot(fixture));
    const converter: ConnectorApprovedJournalMigration = ConnectorApprovedJournalMigration.create(
        migrationIdentity(fixture),
        migrationApproval(fixture, history, operation.purpose),
        operation.purpose,
    );
    const original: ConnectorJournalMigrationSource<ConnectorFileOperation, ConnectorFileResponse> =
        history.record.state;
    if (original.pending === null || original.receipt === null) {
        throw new Error('Both original headers required');
    }
    const originalReceipt: NonNullable<typeof original.receipt> = original.receipt;
    const originalPending: NonNullable<typeof original.pending> = original.pending;
    const changed: readonly ConnectorJournalMigrationSource<
        ConnectorFileOperation,
        ConnectorFileResponse
    >[] = [
        { ...original, journalId: 'f'.repeat(64) },
        { ...original, acknowledgedSequence: original.acknowledgedSequence + 1n },
        { ...original, receipt: null },
        { ...original, pending: null },
        ...['jobId', 'dispatchId', 'requestHash', 'responseHash'].map(
            (
                field: string,
            ): ConnectorJournalMigrationSource<ConnectorFileOperation, ConnectorFileResponse> => ({
                ...original,
                receipt: { ...originalReceipt, [field]: 'f'.repeat(64) },
            }),
        ),
        { ...original, receipt: { ...originalReceipt, sequence: original.receipt.sequence + 1n } },
        ...['jobId', 'dispatchId', 'requestHash'].map(
            (
                field: string,
            ): ConnectorJournalMigrationSource<ConnectorFileOperation, ConnectorFileResponse> => ({
                ...original,
                pending: { ...originalPending, [field]: 'f'.repeat(64) },
            }),
        ),
        { ...original, pending: { ...originalPending, sequence: original.pending.sequence + 1n } },
    ];
    const before: string = createHash('sha256').update(history.bytes).digest('hex');
    for (const candidate of changed) {
        expect(() => converter.convert(candidate, history.record.sourceSha256, operation)).toThrow(
            'changed',
        );
    }
    expect(() => converter.convert(original, 'f'.repeat(64), operation)).toThrow('changed');
    expect(createHash('sha256').update(history.bytes).digest('hex')).toBe(before);
});

it('an authority-approved joint certificate cannot manufacture missing joint operation proof, and omitted approvals never infer Independent', (): void => {
    using fixture: AdmissionMigrationFixture = new AdmissionMigrationFixture();
    const operation: ConnectorFileJournalCodec = new ConnectorFileJournalCodec();
    const snapshot: OriginalJournalFixtureSnapshot<ConnectorFileOperation, ConnectorFileResponse> =
        migrationFileSnapshot(fixture);
    using history: AuthenticatedHistory<ConnectorFileOperation, ConnectorFileResponse> =
        new AuthenticatedHistory(fixture, operation, snapshot);
    const certificate: ConnectorMigrationApproval = migrationApproval(
        fixture,
        history,
        operation.purpose,
        true,
    );
    expect(Proof.verifyApproval(SigningKey, fixture.scope, certificate.plan, certificate)).toBe(
        true,
    );
    const converter: ConnectorApprovedJournalMigration = ConnectorApprovedJournalMigration.create(
        migrationIdentity(fixture),
        certificate,
        operation.purpose,
    );
    expect(() =>
        converter.convert(history.record.state, history.record.sourceSha256, operation),
    ).toThrow('independent');
    expect(() =>
        new ConnectorJournalMigrationCodec(operation).read(
            JSON.parse(new OriginalJournalFixtureCodec(operation).encode(snapshot)),
            history.record.sourceSha256,
        ),
    ).toThrow('explicit signed');
    const empty: OriginalJournalFixtureSnapshot<ConnectorFileOperation, ConnectorFileResponse> = {
        journalId: snapshot.journalId,
        acknowledgedSequence: 0n,
        receipt: null,
        pending: null,
    };
    expect(() =>
        new ConnectorJournalMigrationCodec(operation).read(
            JSON.parse(new OriginalJournalFixtureCodec(operation).encode(empty)),
            history.record.sourceSha256,
        ),
    ).toThrow('explicit signed');
    using authorizedEmpty: AuthenticatedHistory<ConnectorFileOperation, ConnectorFileResponse> =
        new AuthenticatedHistory(fixture, operation, empty);
    const emptyConverter: ConnectorApprovedJournalMigration =
        ConnectorApprovedJournalMigration.create(
            migrationIdentity(fixture),
            migrationApproval(fixture, authorizedEmpty, operation.purpose),
            operation.purpose,
        );
    const emptyTarget: ConnectorJournalSnapshot<ConnectorFileOperation, ConnectorFileResponse> =
        emptyConverter.convert(
            authorizedEmpty.record.state,
            authorizedEmpty.record.sourceSha256,
            operation,
        );
    expect(emptyTarget).toEqual({
        schema: ConnectorJournalSchema.AuthorizedEffectContext,
        journalId: empty.journalId,
        acknowledgedSequence: 0n,
        receipt: null,
        pending: null,
    });
});

it('protected identity pins, both signature components and the fixed local purpose are required before converter creation', (): void => {
    using fixture: AdmissionMigrationFixture = new AdmissionMigrationFixture();
    using foreign: SigningKey = SigningKey.generate();
    const operation: ConnectorFileJournalCodec = new ConnectorFileJournalCodec();
    using history: AuthenticatedHistory<ConnectorFileOperation, ConnectorFileResponse> =
        new AuthenticatedHistory(fixture, operation, migrationFileSnapshot(fixture));
    const certificate: ConnectorMigrationApproval = migrationApproval(
        fixture,
        history,
        operation.purpose,
    );
    const original: ConnectorClientIdentity = migrationIdentity(fixture);
    for (const changed of [
        { ...original, authority: { ...original.authority, authorityId: 'foreign-authority' } },
        { ...original, authority: { ...original.authority, publicKey: foreign.publicKey } },
        { ...original, publicKey: foreign.publicKey },
        { ...original, settings: { ...original.settings, environmentId: 'foreign-environment' } },
        { ...original, settings: { ...original.settings, enrollmentId: 'conn_' + 'b'.repeat(64) } },
    ]) {
        expect(() =>
            ConnectorApprovedJournalMigration.create(changed, certificate, operation.purpose),
        ).toThrow('invalid');
    }
    for (const offset of [0, 2420]) {
        const bytes: Buffer = Buffer.from(certificate.signature, 'base64url');
        bytes[offset] = (bytes[offset] ?? 0) ^ 1;
        expect(() =>
            ConnectorApprovedJournalMigration.create(
                original,
                { ...certificate, signature: bytes.toString('base64url') },
                operation.purpose,
            ),
        ).toThrow('invalid');
        const planBytes: Buffer = Buffer.from(certificate.plan.signature, 'base64url');
        planBytes[offset] = (planBytes[offset] ?? 0) ^ 1;
        expect(() =>
            ConnectorApprovedJournalMigration.create(
                original,
                {
                    ...certificate,
                    plan: { ...certificate.plan, signature: planBytes.toString('base64url') },
                },
                operation.purpose,
            ),
        ).toThrow('invalid');
    }
    expect(() =>
        ConnectorApprovedJournalMigration.create(
            original,
            certificate,
            ConnectorOperationPurpose.ExecutionSecond,
        ),
    ).toThrow('omits');
});
