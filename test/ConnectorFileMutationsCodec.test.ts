// SPDX-FileCopyrightText: 2026 Dacely <business@dacely.com>
// SPDX-License-Identifier: LicenseRef-Proprietary

import { expect, it } from 'vitest';
import { ConnectorFilesCodec } from 'nerva-connector-protocol/protocol/ConnectorFilesCodec.js';
import { ConnectorFileJobsCodec } from 'nerva-connector-protocol/protocol/ConnectorFileJobsCodec.js';
import {
    ConnectorFilePermissionMode,
    type ConnectorFileChmod,
    type ConnectorFileRename,
    type ConnectorFileRequest,
    type ConnectorFileResponse,
} from 'nerva-connector-protocol/protocol/ConnectorFiles.js';
import { ConnectorFileKind } from 'nerva-connector-protocol/protocol/ConnectorFileTypes.js';
import {
    ConnectorFileAction,
    ConnectorWriteMode,
} from 'nerva-connector-protocol/protocol/ConnectorFileTypes.js';

const chmod: ConnectorFileChmod = {
    action: ConnectorFileAction.Chmod,
    requestId: 'private-mode',
    policySha256: 'a'.repeat(64),
    rootId: 'project',
    path: 'script',
    mode: ConnectorFilePermissionMode.Executable,
};
const rename: ConnectorFileRename = {
    action: ConnectorFileAction.Rename,
    requestId: 'move-file',
    policySha256: 'a'.repeat(64),
    rootId: 'project',
    path: 'source',
    destination: 'nested/target',
    mode: ConnectorWriteMode.Create,
};

it('permission changes accept only exact numeric private modes and cannot modify the granted root or carry broader authority', (): void => {
    for (const mode of [
        ConnectorFilePermissionMode.Private,
        ConnectorFilePermissionMode.Executable,
    ]) {
        expect(ConnectorFilesCodec.request({ ...chmod, mode })).toEqual({ ...chmod, mode });
    }
    for (const mode of [
        0,
        0o644,
        0o755,
        0o777,
        0o1700,
        0o4600,
        '0600',
        '0700',
        true,
        null,
        undefined,
    ]) {
        expect((): ConnectorFileRequest =>
            ConnectorFilesCodec.request({ ...chmod, mode }),
        ).toThrow();
    }
    for (const path of ['.', '/', '../private', 'nested/../private', 'nested//file']) {
        expect((): ConnectorFileRequest =>
            ConnectorFilesCodec.request({ ...chmod, path }),
        ).toThrow();
    }
    expect((): ConnectorFileRequest =>
        ConnectorFilesCodec.request({ ...chmod, destination: 'other' }),
    ).toThrow();
    expect((): ConnectorFileRequest =>
        ConnectorFilesCodec.request({ ...chmod, executable: '/bin/sh' }),
    ).toThrow();
    expect(ConnectorFilesCodec.isMutation(ConnectorFileAction.Chmod)).toBe(true);
});

it('rename binds two distinct nonroot paths to the same root and requires explicit create or replace intent', (): void => {
    for (const mode of [ConnectorWriteMode.Create, ConnectorWriteMode.Replace]) {
        const normalized: ConnectorFileRequest = ConnectorFileJobsCodec.operation({
            ...rename,
            mode,
        });
        expect(normalized).toEqual({ ...rename, mode });
        expect(
            ConnectorFileJobsCodec.operation(JSON.parse(ConnectorFileJobsCodec.encode(normalized))),
        ).toEqual(normalized);
    }
    for (const destination of [
        '.',
        '/',
        '../private',
        'nested/../private',
        'nested//file',
        rename.path,
        '',
    ]) {
        expect((): ConnectorFileRequest =>
            ConnectorFilesCodec.request({ ...rename, destination }),
        ).toThrow();
    }
    for (const mode of [undefined, 'overwrite', ConnectorFilePermissionMode.Private, true]) {
        expect((): ConnectorFileRequest =>
            ConnectorFilesCodec.request({ ...rename, mode }),
        ).toThrow();
    }
    expect((): ConnectorFileRequest =>
        ConnectorFilesCodec.request({ ...rename, path: '.' }),
    ).toThrow();
    expect((): ConnectorFileRequest =>
        ConnectorFilesCodec.request({ ...rename, destinationRootId: 'another-root' }),
    ).toThrow();
    expect((): ConnectorFileRequest =>
        ConnectorFilesCodec.request({ ...rename, stagingId: 'b'.repeat(64) }),
    ).toThrow();
    expect(ConnectorFilesCodec.isMutation(ConnectorFileAction.Rename)).toBe(true);
});

it('metadata mutations require correlated regular-file results and chmod confirms its exact requested mode', (): void => {
    for (const request of [chmod, rename]) {
        const result: Readonly<Record<string, unknown>> = {
            action: request.action,
            requestId: request.requestId,
            metadata: {
                kind: ConnectorFileKind.File,
                sizeBytes: '9007199254740993',
                modifiedAtNs: '9007199254740995',
                mode: 0o700,
            },
        };
        expect(ConnectorFilesCodec.response({ ok: true, result }, request)).toMatchObject({
            ok: true,
            result: {
                action: request.action,
                metadata: { sizeBytes: 9007199254740993n, modifiedAtNs: 9007199254740995n },
            },
        });
        expect((): ConnectorFileResponse =>
            ConnectorFilesCodec.response(
                { ok: true, result: { ...result, requestId: 'another-request' } },
                request,
            ),
        ).toThrow();
        expect((): ConnectorFileResponse =>
            ConnectorFilesCodec.response(
                {
                    ok: true,
                    result: {
                        ...result,
                        metadata: {
                            kind: ConnectorFileKind.Directory,
                            sizeBytes: '0',
                            modifiedAtNs: '1',
                            mode: 0o700,
                        },
                    },
                },
                request,
            ),
        ).toThrow();
    }
    expect((): ConnectorFileResponse =>
        ConnectorFilesCodec.response(
            {
                ok: true,
                result: {
                    action: chmod.action,
                    requestId: chmod.requestId,
                    metadata: {
                        kind: ConnectorFileKind.File,
                        sizeBytes: '1',
                        modifiedAtNs: '1',
                        mode: 0o600,
                    },
                },
            },
            chmod,
        ),
    ).toThrow();
});
