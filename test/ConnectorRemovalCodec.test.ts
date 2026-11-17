// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

import { expect, it } from 'vitest';
import { ConnectorFilesCodec } from 'nerva-connector-protocol/protocol/ConnectorFilesCodec.js';
import { type ConnectorFileRemove } from 'nerva-connector-protocol/protocol/ConnectorFiles.js';
import { ConnectorFileAction } from 'nerva-connector-protocol/protocol/ConnectorFileTypes.js';

const request: ConnectorFileRemove = {
    action: ConnectorFileAction.Remove,
    requestId: 'remove',
    policySha256: 'a'.repeat(64),
    rootId: 'project',
    path: 'tree',
    recursive: true,
};

it('requires explicit removal intent and rejects root removal and added authority', (): void => {
    expect(ConnectorFilesCodec.request(request)).toEqual(request);
    for (const addition of [
        { recursive: undefined },
        { recursive: 'true' },
        { path: '.' },
        { stagingId: 'a'.repeat(64) },
        { mode: 'replace' },
    ]) {
        expect((): void => {
            ConnectorFilesCodec.request({ ...request, ...addition });
        }).toThrow();
    }
    expect(ConnectorFilesCodec.isMutation(request.action)).toBe(true);
    expect(ConnectorFilesCodec.isMutation(ConnectorFileAction.Read)).toBe(false);
});

it('accepts only correlated bounded complete removals with no unrelated result fields', (): void => {
    const valid: Readonly<Record<string, string>> = {
        action: request.action,
        requestId: request.requestId,
        entriesRemoved: '2',
    };
    expect(ConnectorFilesCodec.response({ ok: true, result: valid }, request)).toEqual({
        ok: true,
        result: { ...valid, entriesRemoved: 2n },
    });
    for (const addition of [
        { entriesRemoved: '0' },
        { entriesRemoved: '4097' },
        { entriesRemoved: '01' },
        { entriesRemoved: 1 },
        { requestId: 'other' },
        { metadata: {} },
    ]) {
        expect((): void => {
            ConnectorFilesCodec.response({ ok: true, result: { ...valid, ...addition } }, request);
        }).toThrow();
    }
    expect((): void => {
        ConnectorFilesCodec.response({ ok: true, result: valid }, { ...request, recursive: false });
    }).toThrow();
});
