// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

import { expect, it } from 'vitest';
import { WindowsStateOwner } from '../src/windows/WindowsStateOwner.js';
import { WindowsStateRequestCodec } from '../src/windows/WindowsStateRequestCodec.js';
import {
    WindowsStateOperation,
    WindowsStateFailure,
    WindowsStateError,
    type WindowsStateParameters,
    type WindowsStateRequest,
    type WindowsStateResponse,
} from '../src/windows/WindowsStateProtocol.js';
import type { WindowsStateArtifactMetadata } from '../src/windows/WindowsStateArtifactMetadata.js';

const empty: WindowsStateResponse = {
    id: '1',
    ok: true,
    path: null,
    lease: null,
    exists: null,
    names: null,
    dataBase64: null,
    error: null,
    sizeBytes: null,
    sha256: null,
};

it('native private bytes retain NUL and non-UTF8 data while canonical encoding and resource bounds remain enforced', (): void => {
    const response: WindowsStateResponse = WindowsStateOwner.decode({
        ...empty,
        dataBase64: 'AP8=',
    });
    expect(WindowsStateOwner.bytes(response, 2)).toEqual(Buffer.from([0, 255]));
    for (const encoded of ['AP8', 'AP8=\n', 'AP8==']) {
        expect((): Buffer =>
            WindowsStateOwner.bytes({ ...response, dataBase64: encoded }, 2),
        ).toThrow(WindowsStateError);
    }
    expect((): Buffer => WindowsStateOwner.bytes(response, 1)).toThrow(WindowsStateError);
    expect((): Buffer => WindowsStateOwner.bytes(response, Number.NaN)).toThrow(WindowsStateError);
    expect((): Buffer => WindowsStateOwner.bytes(response, 1048577)).toThrow(WindowsStateError);
});

it('native artifact metadata is exact and cannot widen ordinary private byte-response limits', (): void => {
    const response: WindowsStateResponse = WindowsStateOwner.decode({
        ...empty,
        sizeBytes: '268435456',
        sha256: 'a'.repeat(64),
    });
    expect(WindowsStateOwner.artifact(response, 268435456)).toEqual({
        sizeBytes: 268435456n,
        sha256: 'a'.repeat(64),
    });
    for (const maximum of [0, 268435455, 268435457, 1.5, Number.NaN]) {
        expect((): WindowsStateArtifactMetadata =>
            WindowsStateOwner.artifact(response, maximum),
        ).toThrow(WindowsStateError);
    }
    expect((): Buffer => WindowsStateOwner.bytes(response, 268435456)).toThrow(WindowsStateError);
    for (const raw of [
        { ...empty, sizeBytes: '1', sha256: null },
        { ...empty, sizeBytes: null, sha256: 'a'.repeat(64) },
        { ...empty, sizeBytes: '0', sha256: 'a'.repeat(64) },
        { ...empty, sizeBytes: '01', sha256: 'a'.repeat(64) },
        { ...empty, sizeBytes: 1, sha256: 'a'.repeat(64) },
        { ...empty, sizeBytes: '268435457', sha256: 'a'.repeat(64) },
        { ...empty, sizeBytes: '9007199254740993', sha256: 'a'.repeat(64) },
        { ...empty, sizeBytes: '1', sha256: 'A'.repeat(64) },
        { ...empty, sizeBytes: '1', sha256: 'a'.repeat(64) + '\n' },
        {
            ...empty,
            ok: false,
            error: WindowsStateFailure.Io,
            sizeBytes: '1',
            sha256: 'a'.repeat(64),
        },
    ]) {
        expect((): WindowsStateResponse => WindowsStateOwner.decode(raw)).toThrow();
    }
});

it('artifact request streaming retains per-artifact bounds without expanding ordinary state operations', (): void => {
    const parameters: WindowsStateParameters = {
        path: 'C:\\release\\node.exe',
        lease: 'owned-installation',
        name: 'node.exe',
        maximumBytes: 268435456,
        sizeBytes: 268435456n,
        sha256: 'b'.repeat(64),
        replace: false,
    };
    const request: WindowsStateRequest = WindowsStateRequestCodec.create(
        '1',
        WindowsStateOperation.ArtifactInstall,
        parameters,
    );
    expect(request).toMatchObject({
        sizeBytes: '268435456',
        sha256: 'b'.repeat(64),
        maximumBytes: 268435456,
        replace: false,
        dataBase64: null,
    });
    for (const maximum of [0, 268435457, 1.5, Number.NaN]) {
        expect((): WindowsStateRequest =>
            WindowsStateRequestCodec.create('1', WindowsStateOperation.ArtifactInstall, {
                ...parameters,
                maximumBytes: maximum,
            }),
        ).toThrow(WindowsStateError);
    }
    for (const override of [
        { sizeBytes: 0n },
        { sizeBytes: 268435457n },
        { sha256: 'B'.repeat(64) },
        { sha256: 'b'.repeat(64) + '\n' },
    ]) {
        expect((): WindowsStateRequest =>
            WindowsStateRequestCodec.create('1', WindowsStateOperation.ArtifactInstall, {
                ...parameters,
                ...override,
            }),
        ).toThrow(WindowsStateError);
    }
    expect((): WindowsStateRequest =>
        WindowsStateRequestCodec.create('1', WindowsStateOperation.ArtifactDescribe, {}),
    ).toThrow(WindowsStateError);
    expect((): WindowsStateRequest =>
        WindowsStateRequestCodec.create('1', WindowsStateOperation.ArtifactVerify, {
            path: parameters.path,
            maximumBytes: 268435456,
        }),
    ).toThrow(WindowsStateError);
    expect((): WindowsStateRequest =>
        WindowsStateRequestCodec.create('1', WindowsStateOperation.Read, {
            maximumBytes: 1048577,
        }),
    ).toThrow(WindowsStateError);
    expect((): WindowsStateRequest =>
        WindowsStateRequestCodec.create('1', WindowsStateOperation.Write, {
            maximumBytes: 1048576,
            sizeBytes: 1n,
        }),
    ).toThrow(WindowsStateError);
    expect(
        WindowsStateRequestCodec.create('1', WindowsStateOperation.ArtifactDescribe, {
            path: parameters.path,
            maximumBytes: 268435456,
        }),
    ).toMatchObject({ sizeBytes: null, sha256: null, replace: null });
});

it('native envelopes cannot supply extra fields, ambiguous IDs, arbitrary errors or inconsistent success state', (): void => {
    for (const raw of [
        { ...empty, id: '01' },
        { ...empty, id: '1\n' },
        { ...empty, ok: 1 },
        { ...empty, exists: 'true' },
        { ...empty, error: WindowsStateFailure.Untrusted },
        { ...empty, ok: false, error: null },
        { ...empty, ok: false, error: 'raw C:\\private\\secret' },
        { ...empty, privateKey: 'unexpected' },
        { ...empty, path: 'x'.repeat(4097) },
        { ...empty, names: Array.from({ length: 129 }, (): string => 'name') },
        { ...empty, names: [''] },
    ]) {
        expect((): WindowsStateResponse => WindowsStateOwner.decode(raw)).toThrow();
    }
    expect(
        WindowsStateOwner.decode({ ...empty, ok: false, error: WindowsStateFailure.Untrusted }),
    ).toMatchObject({ ok: false, error: WindowsStateFailure.Untrusted });
});

it('finite storage failures retain explicit missing-file semantics and safe actionable diagnostics', (): void => {
    expect(new WindowsStateError(WindowsStateFailure.Missing).code).toBe('ENOENT');
    expect(new WindowsStateError(WindowsStateFailure.Busy).message).toContain('another process');
    expect(new WindowsStateError(WindowsStateFailure.Untrusted).message).toContain('preserved');
    expect(new WindowsStateError(WindowsStateFailure.Migration).message).toContain('migration');
    expect(new WindowsStateError(WindowsStateFailure.Unsupported).code).toBe('ENOTSUP');
    expect(new WindowsStateError(WindowsStateFailure.Unsupported).message).toContain('filesystem');
});
