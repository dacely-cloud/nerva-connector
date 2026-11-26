// SPDX-FileCopyrightText: 2026 Dacely <business@dacely.com>
// SPDX-License-Identifier: LicenseRef-Proprietary

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { Boundary } from 'nerva-connector-protocol/protocol/Boundary.js';
import { FileHistoryFixture } from './support/FileHistoryFixture.js';
import { JournalEffectFixture } from './support/JournalEffectFixture.js';
import {
    ConnectorAuthorizationKind,
    type ConnectorAuthorization,
} from 'nerva-connector-protocol/protocol/ConnectorAuthorization.js';
import { ConnectorAuthorizationCodec } from 'nerva-connector-protocol/protocol/ConnectorAuthorizationCodec.js';
import { ConnectorAuthorizationProof } from 'nerva-connector-protocol/protocol/ConnectorAuthorizationProof.js';
import { JointWorkspaceProof } from 'nerva-connector-protocol/workspace/JointWorkspaceProof.js';
import {
    ConnectorFileMode,
    ConnectorFileFailure,
    type ConnectorFileResponse,
} from 'nerva-connector-protocol/protocol/ConnectorFiles.js';
import type { ConnectorFilePermit } from 'nerva-connector-protocol/protocol/ConnectorFileJobs.js';
import {
    ConnectorJournalSchema,
    ConnectorJournalState,
} from '../src/runtime/ConnectorJournalState.js';
import { ConnectorFileJournalCodec } from '../src/runtime/ConnectorFileJournalCodec.js';
import type { ConnectorJournalReceipt } from 'nerva-connector-protocol/protocol/ConnectorJournalReceipt.js';
import type { ConnectorJournalPending } from '../src/runtime/ConnectorJournalState.js';
import { ExecutionJournalCodec } from '../src/execution/ExecutionJournalCodec.js';
import { type ExecutionRequest } from 'nerva-connector-protocol/execution/ExecutionJobs.js';
import { ExecutionLane } from 'nerva-connector-protocol/execution/ExecutionLane.js';
import type { ConnectorOperationDispatch } from 'nerva-connector-protocol/protocol/ConnectorOperationDispatch.js';
import { ExecutionProof } from 'nerva-connector-protocol/execution/ExecutionProof.js';
import { ConnectorOperationJournal } from '../src/runtime/ConnectorOperationJournal.js';
import type { ExecutionResult } from 'nerva-connector-protocol/execution/ExecutionTypes.js';
import type { ExecutionOutput } from 'nerva-connector-protocol/execution/ExecutionOutput.js';
import { ExecutionFailure } from 'nerva-connector-protocol/execution/ExecutionTypes.js';
import { ExecutionResultCodec } from '../src/execution/ExecutionResultCodec.js';

const helper: string | undefined = process.env['NERVA_CONNECTOR_FILES_HELPER'];

/** Real signatures qualify immutable storage authority only; this synthetic joint physical commitment never qualifies a native launch. */
function joint(
    fixture: FileHistoryFixture,
    journalId: string,
    revision: bigint = 1n,
): ConnectorAuthorization {
    return {
        kind: ConnectorAuthorizationKind.Joint,
        binding: JointWorkspaceProof.sign(fixture.identity.key, {
            authorityId: fixture.identity.authority.authorityId,
            environmentId: fixture.identity.settings.environmentId,
            enrollmentId: fixture.identity.settings.enrollmentId,
            revision,
            filePolicySha256: fixture.policySha256,
            executionPolicySha256: 'b'.repeat(64),
            fileRootId: 'project',
            executionRootId: 'command',
            access: ConnectorFileMode.ReadWrite,
            physicalRootCommitment: 'c'.repeat(64),
            fileJournalId: journalId,
            executionJournals: { first: 'd'.repeat(64), second: 'e'.repeat(64) },
        }),
    };
}

it.skipIf(helper === undefined)(
    'Started retains the exact first full authorization, rejects randomized signature substitution and changed admission at every terminal transition without changing ciphertext, and compacts its digest',
    async (): Promise<void> => {
        await using fixture: FileHistoryFixture = await FileHistoryFixture.create();
        await using journal: Awaited<ReturnType<FileHistoryFixture['journal']>> =
            await fixture.journal();
        const authorization: ConnectorAuthorization = joint(fixture, journal.id);
        const original: ConnectorFilePermit = fixture.permit();
        const permit: ConnectorFilePermit = {
            ...original,
            authorization,
            admissionHash: ConnectorAuthorizationProof.file(original.requestHash, authorization),
        };
        await journal.begin(permit, JournalEffectFixture.file(permit.request));
        expect(
            ConnectorAuthorizationCodec.encode(
                journal.pending?.authorization ?? { kind: ConnectorAuthorizationKind.Independent },
            ),
        ).toBe(ConnectorAuthorizationCodec.encode(authorization));
        expect(journal.pending?.admissionHash).toBe(permit.admissionHash);
        const started: Buffer = await readFile(join(fixture.state, 'file-journal'));
        const rerandomized: ConnectorAuthorization = joint(fixture, journal.id);
        expect(ConnectorAuthorizationProof.file(permit.requestHash, rerandomized)).toBe(
            permit.admissionHash,
        );
        expect(ConnectorAuthorizationCodec.encode(rerandomized)).not.toBe(
            ConnectorAuthorizationCodec.encode(authorization),
        );
        await expect(
            journal.begin(
                { ...permit, authorization: rerandomized },
                JournalEffectFixture.file(permit.request),
            ),
        ).rejects.toThrow('authorization changed');
        const changed: ConnectorAuthorization = joint(fixture, journal.id, 2n);
        await expect(
            journal.begin(
                {
                    ...permit,
                    authorization: changed,
                    admissionHash: ConnectorAuthorizationProof.file(permit.requestHash, changed),
                },
                JournalEffectFixture.file(permit.request),
            ),
        ).rejects.toThrow();
        const response: ConnectorFileResponse = {
            ok: false,
            error: ConnectorFileFailure.Indeterminate,
        };
        await expect(
            journal.finish({ ...permit, admissionHash: 'f'.repeat(64) }, response),
        ).rejects.toThrow();
        await expect(
            journal.finish({ ...permit, authorization: rerandomized }, response),
        ).rejects.toThrow('authorization changed');
        expect(await readFile(join(fixture.state, 'file-journal'))).toEqual(started);
        await journal.finish(permit, response);
        const completed: Buffer = await readFile(join(fixture.state, 'file-journal'));
        const acknowledgment: ConnectorJournalReceipt = {
            jobId: permit.jobId,
            sequence: permit.sequence,
            dispatchId: permit.dispatchId,
            requestHash: permit.requestHash,
            admissionHash: permit.admissionHash,
            responseHash: new ConnectorFileJournalCodec().responseHash(response),
        };
        await expect(
            journal.acknowledge({ ...acknowledgment, admissionHash: '0'.repeat(64) }),
        ).rejects.toThrow();
        expect(await readFile(join(fixture.state, 'file-journal'))).toEqual(completed);
        await journal.acknowledge(acknowledgment);
        expect(journal.pending).toBeNull();
        await journal.acknowledge(acknowledgment);
        await expect(
            journal.acknowledge({ ...acknowledgment, admissionHash: '0'.repeat(64) }),
        ).rejects.toThrow();
    },
);

it.skipIf(helper === undefined)(
    'the normal storage decoder refuses both old schemas and missing or inconsistent authority rather than inventing independent access',
    async (): Promise<void> => {
        await using fixture: FileHistoryFixture = await FileHistoryFixture.create();
        const codec: ConnectorFileJournalCodec = new ConnectorFileJournalCodec();
        const state: ConnectorJournalState<ConnectorFilePermit['request'], ConnectorFileResponse> =
            new ConnectorJournalState(codec);
        const empty: ReturnType<typeof state.empty> = state.empty('a'.repeat(64));
        expect(empty.schema).toBe(ConnectorJournalSchema.AuthorizedEffectContext);
        expect(() => state.read({ ...empty, schema: 'effect-context' })).toThrow();
        const permit: ConnectorFilePermit = fixture.permit();
        const raw: unknown = JSON.parse(
            codecEncode({
                ...permit,
                effectContext: JournalEffectFixture.file(permit.request),
                response: null,
                progress: null,
            }),
        );
        const requestRaw: unknown = JSON.parse(codecEncode(permit.request));
        const effectRaw: unknown = JSON.parse(
            codecEncode(JournalEffectFixture.file(permit.request)),
        );
        const normalized: ReturnType<typeof state.pending> = state.pending({
            jobId: permit.jobId,
            sequence: permit.sequence.toString(),
            dispatchId: permit.dispatchId,
            requestHash: permit.requestHash,
            admissionHash: permit.admissionHash,
            authorization: { kind: ConnectorAuthorizationKind.Independent },
            request: requestRaw,
            effectContext: effectRaw,
            response: null,
            progress: null,
        });
        expect(normalized.admissionHash).toBe(permit.admissionHash);
        expect(() => state.pending(raw)).toThrow();
        const parsed: unknown = JSON.parse(codecEncode(normalized));
        const fields: Readonly<Record<string, unknown>> = Boundary.record(parsed, [
            'jobId',
            'sequence',
            'dispatchId',
            'requestHash',
            'admissionHash',
            'authorization',
            'request',
            'effectContext',
            'response',
            'progress',
        ]);
        const { authorization: removedAuthorization, ...missingAuthorization } = fields;
        const { admissionHash: removedHash, ...missingHash } = fields;
        expect(removedAuthorization).toBeDefined();
        expect(removedHash).toBeDefined();
        expect(() => state.pending(missingAuthorization)).toThrow();
        expect(() => state.pending(missingHash)).toThrow();
        expect(() => state.pending({ ...fields, admissionHash: '0'.repeat(64) })).toThrow();
        expect(() =>
            state.pending({
                ...fields,
                authorization: {
                    kind: ConnectorAuthorizationKind.Independent,
                    binding: joint(fixture, 'a'.repeat(64)),
                },
            }),
        ).toThrow();
    },
);

/** Test-owned typed shapes retain exact integers; production decoders immediately narrow the resulting unknown JSON. */
function codecEncode(
    value:
        | ConnectorFilePermit
        | ConnectorFilePermit['request']
        | ReturnType<typeof JournalEffectFixture.file>
        | ConnectorJournalPending<ConnectorFilePermit['request'], ConnectorFileResponse>
        | Readonly<Record<string, unknown>>,
): string {
    return JSON.stringify(value, (_key: string, entry: unknown): unknown =>
        typeof entry === 'bigint' ? entry.toString() : entry,
    );
}

it.skipIf(helper === undefined)(
    'command progress and physical group refinement reject a different lane or changed original authority, while request and cgroup hashes stay independent',
    async (): Promise<void> => {
        await using fixture: FileHistoryFixture = await FileHistoryFixture.create();
        const codec: ExecutionJournalCodec = new ExecutionJournalCodec(ExecutionLane.First);
        await ConnectorOperationJournal.initialize(
            fixture.state,
            fixture.identity.settings.enrollmentId,
            fixture.identity.key,
            codec,
        );
        await using journal: ConnectorOperationJournal<
            ExecutionRequest,
            ExecutionResult,
            ExecutionOutput
        > = await ConnectorOperationJournal.load(
            fixture.state,
            fixture.identity.settings.enrollmentId,
            fixture.identity.key,
            codec,
        );
        const request: ExecutionRequest = {
            requestId: 'execute',
            policySha256: 'b'.repeat(64),
            programId: 'program',
            rootId: 'command',
            arguments: [],
        };
        const authorization: ConnectorAuthorization = joint(fixture, 'c'.repeat(64));
        const requestHash: string = ExecutionProof.requestHash(request);
        const original: ConnectorOperationDispatch<ExecutionRequest> = {
            jobId: 'command',
            sequence: 1n,
            dispatchId: 'A'.repeat(43),
            request,
            requestHash,
            authorization,
            admissionHash: ConnectorAuthorizationProof.execution(
                requestHash,
                ExecutionLane.First,
                authorization,
            ),
        };
        const context: ReturnType<typeof JournalEffectFixture.execution> =
            JournalEffectFixture.execution(request);
        await expect(
            journal.begin(
                {
                    ...original,
                    admissionHash: ConnectorAuthorizationProof.execution(
                        requestHash,
                        ExecutionLane.Second,
                        authorization,
                    ),
                },
                context,
            ),
        ).rejects.toThrow();
        await journal.begin(original, context);
        const started: Buffer = await readFile(join(fixture.state, 'execution-journal'));
        const changed: ConnectorOperationDispatch<ExecutionRequest> = {
            ...original,
            authorization: joint(fixture, 'c'.repeat(64)),
            admissionHash: original.admissionHash,
        };
        await expect(
            journal.bindExecutionGroup(changed, {
                ...context.delegation,
                handle: '0200000001000000',
            }),
        ).rejects.toThrow();
        await expect(
            journal.retain(changed, { stdoutBase64: 'YQ==', stderrBase64: '' }),
        ).rejects.toThrow();
        await expect(
            journal.finish(changed, ExecutionResultCodec.interrupted(ExecutionFailure.Interrupted)),
        ).rejects.toThrow();
        expect(await readFile(join(fixture.state, 'execution-journal'))).toEqual(started);
        await journal.bindExecutionGroup(original, {
            ...context.delegation,
            handle: '0200000001000000',
        });
        await journal.retain(original, { stdoutBase64: 'YQ==', stderrBase64: '' });
        await journal.finish(original, {
            ...ExecutionResultCodec.interrupted(ExecutionFailure.Interrupted),
            stdoutBase64: 'YQ==',
        });
        expect(journal.pending?.admissionHash).toBe(original.admissionHash);
        expect(ExecutionProof.requestHash(request)).toBe(requestHash);
    },
);
