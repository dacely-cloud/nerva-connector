// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

import { createHash } from 'node:crypto';
import { expect, it } from 'vitest';
import { Boundary } from 'nerva-connector-protocol/protocol/Boundary.js';
import { ConnectorFilesCodec } from 'nerva-connector-protocol/protocol/ConnectorFilesCodec.js';
import { ConnectorFileJobsCodec } from 'nerva-connector-protocol/protocol/ConnectorFileJobsCodec.js';
import {
    type ConnectorFileRequest,
    type ConnectorFileResponse,
} from 'nerva-connector-protocol/protocol/ConnectorFiles.js';
import {
    ConnectorFileAction,
    ConnectorWriteMode,
} from 'nerva-connector-protocol/protocol/ConnectorFileTypes.js';
import {
    ConnectorUploadLimits,
    type ConnectorUploadChunk,
    type ConnectorUploadRequest,
} from 'nerva-connector-protocol/protocol/ConnectorUpload.js';
import {
    ConnectorTransportLimits,
    ConnectorFrameKind,
} from '../src/protocol/ConnectorTransport.js';

const data: Buffer = Buffer.alloc(ConnectorUploadLimits.chunkBytes, 0xa5);
const chunk: ConnectorUploadChunk = {
    action: ConnectorFileAction.UploadChunk,
    requestId: 'upload-chunk',
    rootId: 'project',
    policySha256: 'a'.repeat(64),
    path: 'nested/output',
    uploadId: 'b'.repeat(64),
    mode: ConnectorWriteMode.Create,
    sizeBytes: BigInt(data.byteLength),
    sha256: createHash('sha256').update(data).digest('hex'),
    offset: 0n,
    dataBase64: data.toString('base64'),
};
const common: Omit<ConnectorUploadChunk, 'action' | 'offset' | 'dataBase64'> = {
    requestId: chunk.requestId,
    rootId: chunk.rootId,
    policySha256: chunk.policySha256,
    path: chunk.path,
    uploadId: chunk.uploadId,
    mode: chunk.mode,
    sizeBytes: chunk.sizeBytes,
    sha256: chunk.sha256,
};
function decode(request: ConnectorUploadRequest): ConnectorFileRequest {
    return ConnectorFilesCodec.request(wire(request));
}
/** Test wire data crosses the same unknown JSON boundary as a real permit. */
function wire(request: ConnectorUploadRequest): Readonly<Record<string, unknown>> {
    const raw: unknown = JSON.parse(ConnectorFileJobsCodec.encode(request));
    return Boundary.record(raw, [
        'action',
        'requestId',
        'rootId',
        'policySha256',
        'path',
        'uploadId',
        'mode',
        'sizeBytes',
        'sha256',
        'offset',
        'dataBase64',
    ]);
}

it('all upload steps require exact immutable commitments and read-write admission, including status', (): void => {
    for (const action of [
        ConnectorFileAction.UploadBegin,
        ConnectorFileAction.UploadStatus,
        ConnectorFileAction.UploadCommit,
        ConnectorFileAction.UploadAbort,
    ] as const) {
        const request: ConnectorUploadRequest = { ...common, action };
        expect(decode(request)).toEqual(request);
        expect(ConnectorFilesCodec.isMutation(action)).toBe(true);
        for (const additions of [
            { bindingSha256: 'a'.repeat(64) },
            { stagingId: 'a'.repeat(64) },
            { path: '.' },
            { path: '../outside' },
            { mode: 'append' },
            { uploadId: 'bad' },
            { sha256: 'f'.repeat(63) },
            { sizeBytes: '9223372036854775808' },
            { sizeBytes: '-1' },
            { sizeBytes: 10 },
            { offset: '0' },
            { dataBase64: 'YQ==' },
        ]) {
            expect((): ConnectorFileRequest =>
                ConnectorFilesCodec.request({
                    ...wire(request),
                    ...additions,
                }),
            ).toThrow();
        }
    }
    expect(decode(chunk)).toEqual(chunk);
    expect(ConnectorFilesCodec.isMutation(chunk.action)).toBe(true);
    expect(Buffer.byteLength(ConnectorFileJobsCodec.encode(chunk))).toBeLessThan(
        ConnectorTransportLimits.bytes(ConnectorFrameKind.FilePermit) - 8192,
    );
    expect(ConnectorTransportLimits.bytes(ConnectorFrameKind.Hello)).toBe(16384);
});

it('chunk encoding rejects empty, oversized, noncanonical, sparse and overflowing payloads before native dispatch', (): void => {
    const encoded: Readonly<Record<string, unknown>> = wire(chunk);
    for (const additions of [
        { dataBase64: '' },
        { dataBase64: 'Zh==' },
        { dataBase64: 'YQ' },
        { dataBase64: Buffer.alloc(65537).toString('base64') },
        { offset: '1' },
        { offset: '9007199254740993' },
        { offset: -1 },
        { sizeBytes: '0' },
    ]) {
        expect((): ConnectorFileRequest =>
            ConnectorFilesCodec.request({ ...encoded, ...additions }),
        ).toThrow();
    }
});

it('upload progress and publication reject substituted identities, lengths, digests, metadata and extra fields', (): void => {
    for (const request of [
        { ...common, action: ConnectorFileAction.UploadBegin },
        chunk,
        { ...common, action: ConnectorFileAction.UploadStatus },
        { ...common, action: ConnectorFileAction.UploadCommit },
        { ...common, action: ConnectorFileAction.UploadAbort },
    ] satisfies readonly ConnectorUploadRequest[]) {
        const result: Readonly<Record<string, unknown>> = {
            action: request.action,
            requestId: request.requestId,
            uploadId: request.uploadId,
            ...(request.action === ConnectorFileAction.UploadAbort
                ? { removed: true }
                : request.action === ConnectorFileAction.UploadCommit
                  ? {
                        bytesWritten: request.sizeBytes.toString(),
                        sha256: request.sha256,
                        metadata: {
                            kind: 'file',
                            sizeBytes: request.sizeBytes.toString(),
                            modifiedAtNs: '1',
                            mode: 0o600,
                        },
                    }
                  : {
                        receivedBytes: request.sizeBytes.toString(),
                        ...(request.action === ConnectorFileAction.UploadStatus
                            ? { sha256: request.sha256 }
                            : {}),
                    }),
        };
        expect(ConnectorFilesCodec.response({ ok: true, result }, request).ok).toBe(true);
        for (const additions of [
            { uploadId: 'f'.repeat(64) },
            { requestId: 'other' },
            { action: ConnectorFileAction.Read },
            { hostPath: '/private' },
        ]) {
            expect((): ConnectorFileResponse =>
                ConnectorFilesCodec.response(
                    { ok: true, result: { ...result, ...additions } },
                    request,
                ),
            ).toThrow();
        }
        if (
            request.action === ConnectorFileAction.UploadChunk ||
            request.action === ConnectorFileAction.UploadStatus ||
            request.action === ConnectorFileAction.UploadBegin
        ) {
            expect((): ConnectorFileResponse =>
                ConnectorFilesCodec.response(
                    {
                        ok: true,
                        result: { ...result, receivedBytes: (request.sizeBytes + 1n).toString() },
                    },
                    request,
                ),
            ).toThrow();
        }
        if (request.action === ConnectorFileAction.UploadChunk) {
            expect((): ConnectorFileResponse =>
                ConnectorFilesCodec.response(
                    { ok: true, result: { ...result, receivedBytes: '1' } },
                    request,
                ),
            ).toThrow();
        }
        if (request.action === ConnectorFileAction.UploadCommit) {
            for (const additions of [
                { bytesWritten: '1' },
                { sha256: 'f'.repeat(64) },
                {
                    metadata: {
                        kind: 'file',
                        sizeBytes: request.sizeBytes.toString(),
                        modifiedAtNs: '1',
                        mode: 0o700,
                    },
                },
                {
                    metadata: {
                        kind: 'directory',
                        sizeBytes: request.sizeBytes.toString(),
                        modifiedAtNs: '1',
                        mode: 0o600,
                    },
                },
            ]) {
                expect((): ConnectorFileResponse =>
                    ConnectorFilesCodec.response(
                        { ok: true, result: { ...result, ...additions } },
                        request,
                    ),
                ).toThrow();
            }
        }
    }
});
