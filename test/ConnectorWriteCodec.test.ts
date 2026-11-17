// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

import { expect, it } from 'vitest';
import { ConnectorFilesCodec } from 'nerva-connector-protocol/protocol/ConnectorFilesCodec.js';
import { ConnectorFileJobsCodec } from 'nerva-connector-protocol/protocol/ConnectorFileJobsCodec.js';
import {
    ConnectorFileMode,
    type ConnectorFileWrite,
    type ConnectorFileProfile,
} from 'nerva-connector-protocol/protocol/ConnectorFiles.js';
import {
    ConnectorFileAction,
    ConnectorWriteMode,
} from 'nerva-connector-protocol/protocol/ConnectorFileTypes.js';

/** External write payloads must not inject local staging authority or ambiguous bytes. */
const request: ConnectorFileWrite = {
    action: ConnectorFileAction.Write,
    requestId: 'write',
    policySha256: 'a'.repeat(64),
    rootId: 'project',
    path: 'result.txt',
    mode: ConnectorWriteMode.Create,
    dataBase64: 'Zg==',
};

it('rejects noncanonical, oversized and caller-selected staging inputs before native access', (): void => {
    for (const dataBase64 of ['Zh==', 'Zg', 'Zg==\n', Buffer.alloc(16385).toString('base64')]) {
        expect((): void => {
            ConnectorFilesCodec.request({ ...request, dataBase64 });
        }).toThrow();
    }
    expect((): void => {
        ConnectorFilesCodec.request({ ...request, stagingId: 'a'.repeat(64) });
    }).toThrow();
    expect(ConnectorFilesCodec.request({ ...request, dataBase64: '' })).toEqual({
        ...request,
        dataBase64: '',
    });
});

it('requires current explicit profile limits and refuses read-only write authority', (): void => {
    const profile: ConnectorFileProfile = {
        mode: ConnectorFileMode.ReadWrite,
        revision: 1n,
        policySha256: request.policySha256,
        roots: ['project'],
        maximumReadBytes: 32768,
        maximumWriteBytes: 16384,
    };
    expect(ConnectorFileJobsCodec.profile({ ...profile, revision: '1' })).toEqual(profile);
    for (const maximumWriteBytes of [undefined, 0, 16385]) {
        expect((): void => {
            ConnectorFileJobsCodec.profile({ ...profile, revision: '1', maximumWriteBytes });
        }).toThrow();
    }
    expect((): void => {
        ConnectorFileJobsCodec.profile({
            ...profile,
            revision: '1',
            mode: ConnectorFileMode.ReadOnly,
        });
    }).toThrow();
});

it('correlates successful write bytes, private mode and exact file size to the original request', (): void => {
    for (const bytesWritten of ['0', '2']) {
        expect((): void => {
            ConnectorFilesCodec.response(
                {
                    ok: true,
                    result: {
                        action: request.action,
                        requestId: request.requestId,
                        bytesWritten,
                        metadata: {
                            kind: 'file',
                            sizeBytes: bytesWritten,
                            modifiedAtNs: '1',
                            mode: 0o600,
                        },
                    },
                },
                request,
            );
        }).toThrow();
    }
    expect((): void => {
        ConnectorFilesCodec.response(
            {
                ok: true,
                result: {
                    action: request.action,
                    requestId: request.requestId,
                    bytesWritten: '1',
                    metadata: { kind: 'file', sizeBytes: '1', modifiedAtNs: '1', mode: 0o644 },
                },
            },
            request,
        );
    }).toThrow();
});
