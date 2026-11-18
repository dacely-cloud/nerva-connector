// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

import { expect, it } from 'vitest';
import { SignaturePurpose } from 'nerva-connector-protocol/identity/IdentityFormat.js';
import {
    ConnectorFileAction,
    ConnectorWriteMode,
} from 'nerva-connector-protocol/protocol/ConnectorFileTypes.js';
import { ConnectorUploadLimits } from 'nerva-connector-protocol/protocol/ConnectorUpload.js';
import { ConnectorFileJobsCodec } from 'nerva-connector-protocol/protocol/ConnectorFileJobsCodec.js';
import type {
    ConnectorFileOperation,
    ConnectorFilePermit,
} from 'nerva-connector-protocol/protocol/ConnectorFileJobs.js';
import { ConnectorFileProof } from 'nerva-connector-protocol/protocol/ConnectorFileProof.js';
import { ConnectorAuthorizationProof } from 'nerva-connector-protocol/protocol/ConnectorAuthorizationProof.js';
import {
    ConnectorFrameKind,
    ConnectorTransportCodec,
    ConnectorTransportLimits,
} from '../src/protocol/ConnectorTransport.js';
import {
    ExecutionJobLimits,
    type ExecutionPermit,
    type ExecutionRequest,
} from 'nerva-connector-protocol/execution/ExecutionJobs.js';
import { ExecutionJobsCodec } from '../src/execution/ExecutionJobsCodec.js';
import { ExecutionOutputProtocol } from '../src/execution/ExecutionOutputProtocol.js';
import type {
    ExecutionOutputUpdate,
    ExecutionOutput,
} from 'nerva-connector-protocol/execution/ExecutionOutput.js';
import { ExecutionProof } from 'nerva-connector-protocol/execution/ExecutionProof.js';
import { AuthorizedOperationFixture } from './support/AuthorizedOperationFixture.js';

it('a full65536-byte upload chunk plus full authorization and hybrid permit fits the unchanged131072-byte file frame', (): void => {
    using fixture: AuthorizedOperationFixture = new AuthorizedOperationFixture();
    const request: ConnectorFileOperation = ConnectorFileJobsCodec.operation({
        action: ConnectorFileAction.UploadChunk,
        requestId: 'maximum-chunk',
        policySha256: fixture.descriptor.binding.filePolicySha256,
        rootId: fixture.descriptor.binding.fileRootId,
        path: 'payload.bin',
        uploadId: 'f'.repeat(64),
        mode: ConnectorWriteMode.Create,
        sizeBytes: 9223372036854775807n.toString(),
        sha256: 'e'.repeat(64),
        offset: '0',
        dataBase64: Buffer.alloc(ConnectorUploadLimits.chunkBytes, 0xa5).toString('base64'),
    });
    const original: ConnectorFilePermit = fixture.filePermit();
    const requestHash: string = ConnectorFileProof.digest(ConnectorFileJobsCodec.encode(request));
    const body: Omit<ConnectorFilePermit, 'signature'> = {
        authorityId: original.authorityId,
        enrollmentId: original.enrollmentId,
        leaseId: original.leaseId,
        jobId: original.jobId,
        sequence: original.sequence,
        dispatchId: original.dispatchId,
        issuedAtMs: original.issuedAtMs,
        expiresAtMs: original.expiresAtMs,
        request,
        requestHash,
        authorization: original.authorization,
        admissionHash: ConnectorAuthorizationProof.file(requestHash, original.authorization),
    };
    const permit: ConnectorFilePermit = {
        ...body,
        signature: fixture.authority.sign(
            SignaturePurpose.OperationFilePermit,
            ConnectorFileProof.permit(body),
        ),
    };
    const frame: string = ConnectorTransportCodec.encode({
        kind: ConnectorFrameKind.FilePermit,
        permit,
    });
    expect(Buffer.byteLength(frame)).toBeLessThan(ConnectorTransportLimits.fileFrameBytes);
    expect(ConnectorTransportCodec.server(frame)).toEqual({
        kind: ConnectorFrameKind.FilePermit,
        permit,
    });
    process.stdout.write(
        'NERVA_AUTHORIZED_UPLOAD_BUDGET ' +
            JSON.stringify({
                chunkBytes: ConnectorUploadLimits.chunkBytes,
                permitFrameBytes: Buffer.byteLength(frame),
                frameLimit: ConnectorTransportLimits.fileFrameBytes,
            }) +
            '\n',
    );
});

it('the exact original16384-byte execution request remains valid with its full separate authorization under32768-byte admission and unchanged WSS bounds', (): void => {
    using fixture: AuthorizedOperationFixture = new AuthorizedOperationFixture();
    const empty: ExecutionRequest = { ...fixture.executionRequest, arguments: [''] };
    const contentBudget: number =
        ExecutionJobLimits.requestBytes - Buffer.byteLength(ExecutionJobsCodec.encode(empty));
    const escaped: string =
        '\u0001'.repeat(Math.floor(contentBudget / 6)) + 'a'.repeat(contentBudget % 6);
    const request: ExecutionRequest = ExecutionJobsCodec.request({
        ...empty,
        arguments: [escaped],
    });
    expect(Buffer.byteLength(ExecutionJobsCodec.encode(request))).toBe(16384);
    const original: ExecutionPermit = fixture.executionPermit();
    const requestHash: string = ExecutionProof.requestHash(request);
    const body: Omit<ExecutionPermit, 'signature'> = {
        authorityId: original.authorityId,
        environmentId: original.environmentId,
        enrollmentId: original.enrollmentId,
        lane: original.lane,
        leaseId: original.leaseId,
        jobId: original.jobId,
        sequence: original.sequence,
        dispatchId: original.dispatchId,
        issuedAtMs: original.issuedAtMs,
        expiresAtMs: original.expiresAtMs,
        executionDeadlineMs: original.executionDeadlineMs,
        request,
        requestHash,
        authorization: original.authorization,
        admissionHash: ConnectorAuthorizationProof.execution(
            requestHash,
            original.lane,
            original.authorization,
        ),
    };
    const permit: ExecutionPermit = {
        ...body,
        signature: fixture.authority.sign(
            SignaturePurpose.OperationExecutionPermit,
            ExecutionProof.permit(body),
        ),
    };
    const submission: string = JSON.stringify(
        {
            lane: original.lane,
            previousSequence: 0n,
            request,
            authorization: permit.authorization,
            admissionHash: permit.admissionHash,
        },
        (_key: string, entry: unknown): unknown =>
            typeof entry === 'bigint' ? entry.toString() : entry,
    );
    const frame: string = ConnectorTransportCodec.encode({
        kind: ConnectorFrameKind.ExecutionPermit,
        permit,
    });
    expect(Buffer.byteLength(submission)).toBeLessThan(ExecutionJobLimits.submissionBytes);
    expect(Buffer.byteLength(frame)).toBeLessThan(ConnectorTransportLimits.executionFrameBytes);
    expect(ConnectorTransportCodec.server(frame)).toEqual({
        kind: ConnectorFrameKind.ExecutionPermit,
        permit,
    });
    process.stdout.write(
        'NERVA_AUTHORIZED_EXECUTION_BUDGET ' +
            JSON.stringify({
                originalRequestBytes: 16384,
                submissionBytes: Buffer.byteLength(submission),
                submissionLimit: ExecutionJobLimits.submissionBytes,
                permitFrameBytes: Buffer.byteLength(frame),
                frameLimit: ConnectorTransportLimits.executionFrameBytes,
            }) +
            '\n',
    );
});

it('the complete65536-byte binary prefix keeps its original size with admissionHash and a hybrid proof', (): void => {
    using fixture: AuthorizedOperationFixture = new AuthorizedOperationFixture();
    const permit: ExecutionPermit = fixture.executionPermit();
    const output: ExecutionOutput = {
        stdoutBase64: Buffer.alloc(65536, 0xff).toString('base64'),
        stderrBase64: '',
    };
    const body: Omit<ExecutionOutputUpdate, 'signature'> = {
        environmentId: permit.environmentId,
        enrollmentId: permit.enrollmentId,
        lane: permit.lane,
        leaseId: permit.leaseId,
        jobId: permit.jobId,
        sequence: permit.sequence,
        dispatchId: permit.dispatchId,
        requestHash: permit.requestHash,
        admissionHash: permit.admissionHash,
        output,
        outputHash: ExecutionProof.outputHash(output),
    };
    const update: ExecutionOutputUpdate = {
        ...body,
        signature: fixture.device.sign(
            SignaturePurpose.OperationExecutionOutput,
            ExecutionProof.output(body),
        ),
    };
    const frame: string = ConnectorTransportCodec.encode({
        kind: ConnectorFrameKind.ExecutionOutput,
        update,
    });
    expect(Buffer.byteLength(frame)).toBeLessThan(ConnectorTransportLimits.executionFrameBytes);
    expect(ExecutionOutputProtocol.bytes(output)).toEqual(output);
    expect(ConnectorTransportCodec.client(frame)).toEqual({
        kind: ConnectorFrameKind.ExecutionOutput,
        update,
    });
    const raw: unknown = JSON.parse(ExecutionOutputProtocol.encode(update));
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
        throw new Error('Original wire record required');
    }
    const missing: Record<string, unknown> = { ...raw };
    Reflect.deleteProperty(missing, 'admissionHash');
    expect((): ExecutionOutputUpdate => ExecutionOutputProtocol.update(missing)).toThrow();
    process.stdout.write(
        'NERVA_AUTHORIZED_OUTPUT_BUDGET ' +
            JSON.stringify({
                binaryBytes: 65536,
                frameBytes: Buffer.byteLength(frame),
                frameLimit: ConnectorTransportLimits.executionFrameBytes,
            }) +
            '\n',
    );
});
