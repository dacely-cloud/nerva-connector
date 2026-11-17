// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

import { createHash } from 'node:crypto';
import { readFile, writeFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { FilesystemFixture } from './support/FilesystemFixture.js';
import { ConnectorFilesystem } from '../src/runtime/ConnectorFilesystem.js';
import {
    ConnectorFileMode,
    ConnectorFileFailure,
    ConnectorFileLimits,
    type ConnectorFileResponse,
} from 'nerva-connector-protocol/protocol/ConnectorFiles.js';
import {
    ConnectorFileAction,
    ConnectorWriteMode,
} from 'nerva-connector-protocol/protocol/ConnectorFileTypes.js';
import {
    ConnectorUploadLimits,
    type ConnectorUploadRequest,
} from 'nerva-connector-protocol/protocol/ConnectorUpload.js';

const helper: string | undefined = process.env['NERVA_CONNECTOR_FILES_HELPER'];

/** Tests repeat the entire immutable commitment on each independent signed-step equivalent. */
interface UploadCommitment {
    readonly uploadId: string;
    readonly mode: ConnectorWriteMode;
    readonly sizeBytes: string;
    readonly sha256: string;
}
function commitment(
    data: Buffer,
    mode: ConnectorWriteMode = ConnectorWriteMode.Create,
): UploadCommitment {
    return {
        uploadId: 'b'.repeat(64),
        mode,
        sizeBytes: data.byteLength.toString(),
        sha256: createHash('sha256').update(data).digest('hex'),
    };
}
async function step(
    fixture: FilesystemFixture,
    service: ConnectorFilesystem,
    action: ConnectorUploadRequest['action'],
    target: UploadCommitment,
    additions: Readonly<Record<string, string | number | boolean>> = {},
): Promise<ConnectorFileResponse> {
    return await fixture.call(
        service,
        action,
        'result',
        { ...target, ...additions },
        'c'.repeat(64),
    );
}
async function chunks(
    fixture: FilesystemFixture,
    service: ConnectorFilesystem,
    target: UploadCommitment,
    data: Buffer,
    start: number = 0,
    end: number = data.byteLength,
): Promise<void> {
    for (let offset: number = start; offset < end; offset += ConnectorUploadLimits.chunkBytes) {
        const bytes: Buffer = data.subarray(
            offset,
            Math.min(offset + ConnectorUploadLimits.chunkBytes, end),
        );
        expect(
            await step(fixture, service, ConnectorFileAction.UploadChunk, target, {
                offset: offset.toString(),
                dataBase64: bytes.toString('base64'),
            }),
        ).toMatchObject({
            ok: true,
            result: {
                action: ConnectorFileAction.UploadChunk,
                receivedBytes: BigInt(offset + bytes.byteLength),
            },
        });
    }
}

it.skipIf(helper === undefined)(
    'a file larger than 8 MiB resumes across helper owners, publishes atomically and reads back completely in windows',
    async (): Promise<void> => {
        await using fixture: FilesystemFixture = await FilesystemFixture.create(
            ConnectorFileMode.ReadWrite,
        );
        const data: Buffer = Buffer.alloc(8 * 1024 * 1024 + 12347);
        for (let index: number = 0; index < data.byteLength; index++) {
            data[index] = index % 251;
        }
        const target: UploadCommitment = commitment(data);
        const destination: string = join(fixture.root, 'result');
        await writeFile(join(fixture.directory, 'staging', 'unrelated'), 'keep', { mode: 0o600 });
        {
            await using first: ConnectorFilesystem = await ConnectorFilesystem.load(
                fixture.policy,
                [],
            );
            expect(
                await step(fixture, first, ConnectorFileAction.UploadBegin, target),
            ).toMatchObject({
                ok: true,
                result: { action: ConnectorFileAction.UploadBegin, receivedBytes: 0n },
            });
            await chunks(fixture, first, target, data, 0, 131072);
            expect(
                (
                    await step(fixture, first, ConnectorFileAction.UploadChunk, target, {
                        offset: '0',
                        dataBase64: 'YQ==',
                    })
                ).ok,
            ).toBe(false);
            expect(
                (
                    await step(fixture, first, ConnectorFileAction.UploadBegin, {
                        ...target,
                        uploadId: 'd'.repeat(64),
                    })
                ).ok,
            ).toBe(false);
            expect(
                (
                    await step(fixture, first, ConnectorFileAction.UploadStatus, target, {
                        path: 'another-target',
                    })
                ).ok,
            ).toBe(false);
            await expect(readFile(destination)).rejects.toMatchObject({ code: 'ENOENT' });
            expect((await readdir(join(fixture.directory, 'staging'))).length).toBeLessThanOrEqual(
                4,
            );
        }
        {
            await using resumed: ConnectorFilesystem = await ConnectorFilesystem.load(
                fixture.policy,
                [],
            );
            expect(
                await step(fixture, resumed, ConnectorFileAction.UploadStatus, target),
            ).toMatchObject({
                ok: true,
                result: {
                    action: ConnectorFileAction.UploadStatus,
                    receivedBytes: 131072n,
                    sha256: createHash('sha256').update(data.subarray(0, 131072)).digest('hex'),
                },
            });
            expect(
                await step(fixture, resumed, ConnectorFileAction.UploadBegin, target),
            ).toMatchObject({ ok: true, result: { receivedBytes: 131072n } });
            await chunks(fixture, resumed, target, data, 131072);
            await expect(readFile(destination)).rejects.toMatchObject({ code: 'ENOENT' });
            expect(
                await step(fixture, resumed, ConnectorFileAction.UploadCommit, target),
            ).toMatchObject({
                ok: true,
                result: {
                    action: ConnectorFileAction.UploadCommit,
                    bytesWritten: BigInt(data.byteLength),
                    sha256: target.sha256,
                    metadata: { mode: 0o600 },
                },
            });
            expect(await readFile(destination)).toEqual(data);
            const actual: Buffer = Buffer.alloc(data.byteLength);
            for (let offset: number = 0; offset < data.byteLength;) {
                const response: ConnectorFileResponse = await fixture.call(
                    resumed,
                    ConnectorFileAction.Read,
                    'result',
                    { offset: offset.toString(), limit: ConnectorFileLimits.readBytes },
                );
                if (!response.ok || response.result.action !== ConnectorFileAction.Read) {
                    throw new Error('The published file could not be read back');
                }
                const part: Buffer = Buffer.from(response.result.dataBase64, 'base64');
                expect(part.byteLength).toBeGreaterThan(0);
                expect(response.result.offset).toBe(BigInt(offset));
                expect(response.result.metadata.sizeBytes).toBe(BigInt(data.byteLength));
                part.copy(actual, offset);
                offset += part.byteLength;
            }
            expect(actual).toEqual(data);
            expect((await stat(destination)).mode & 0o777).toBe(0o600);
            expect(await readFile(join(fixture.directory, 'staging', 'unrelated'), 'utf8')).toBe(
                'keep',
            );
        }
    },
    120000,
);

it.skipIf(helper === undefined)(
    'incomplete, wrong-digest and conflicting uploads preserve the original destination until an explicit abort',
    async (): Promise<void> => {
        await using fixture: FilesystemFixture = await FilesystemFixture.create(
            ConnectorFileMode.ReadWrite,
        );
        await using service: ConnectorFilesystem = await ConnectorFilesystem.load(
            fixture.policy,
            [],
        );
        const data: Buffer = Buffer.from('a complete upload that must be verified');
        const original: string = 'original-destination';
        const destination: string = join(fixture.root, 'result');
        await writeFile(destination, original, { mode: 0o600 });
        const target: UploadCommitment = commitment(data, ConnectorWriteMode.Replace);
        expect((await step(fixture, service, ConnectorFileAction.UploadBegin, target)).ok).toBe(
            true,
        );
        expect((await step(fixture, service, ConnectorFileAction.UploadCommit, target)).ok).toBe(
            false,
        );
        expect(await readFile(destination, 'utf8')).toBe(original);
        expect(
            (
                await step(fixture, service, ConnectorFileAction.UploadAbort, target, {
                    sha256: 'f'.repeat(64),
                })
            ).ok,
        ).toBe(false);
        expect(await step(fixture, service, ConnectorFileAction.UploadAbort, target)).toMatchObject(
            { ok: true, result: { removed: true } },
        );
        const wrong: UploadCommitment = { ...target, sha256: 'f'.repeat(64) };
        expect((await step(fixture, service, ConnectorFileAction.UploadBegin, wrong)).ok).toBe(
            true,
        );
        await chunks(fixture, service, wrong, data);
        expect((await step(fixture, service, ConnectorFileAction.UploadCommit, wrong)).ok).toBe(
            false,
        );
        expect(await readFile(destination, 'utf8')).toBe(original);
        expect(await step(fixture, service, ConnectorFileAction.UploadAbort, wrong)).toMatchObject({
            ok: true,
            result: { removed: true },
        });
        const create: UploadCommitment = { ...target, mode: ConnectorWriteMode.Create };
        expect((await step(fixture, service, ConnectorFileAction.UploadBegin, create)).ok).toBe(
            true,
        );
        await chunks(fixture, service, create, data);
        expect((await step(fixture, service, ConnectorFileAction.UploadCommit, create)).ok).toBe(
            false,
        );
        expect(await readFile(destination, 'utf8')).toBe(original);
        expect((await step(fixture, service, ConnectorFileAction.UploadAbort, create)).ok).toBe(
            true,
        );
        expect(await readFile(destination, 'utf8')).toBe(original);
        const empty: UploadCommitment = commitment(Buffer.alloc(0), ConnectorWriteMode.Replace);
        expect((await step(fixture, service, ConnectorFileAction.UploadBegin, empty)).ok).toBe(
            true,
        );
        expect(await readFile(destination, 'utf8')).toBe(original);
        expect((await step(fixture, service, ConnectorFileAction.UploadCommit, empty)).ok).toBe(
            true,
        );
        expect(await readFile(destination)).toEqual(Buffer.alloc(0));
    },
);

it.skipIf(helper === undefined)(
    'every upload step including staging inspection requires local read-write and dispatch authority',
    async (): Promise<void> => {
        await using fixture: FilesystemFixture = await FilesystemFixture.create();
        await using reader: ConnectorFilesystem = await ConnectorFilesystem.load(
            fixture.policy,
            [],
        );
        const target: UploadCommitment = commitment(Buffer.from('a'));
        for (const action of [
            ConnectorFileAction.UploadBegin,
            ConnectorFileAction.UploadStatus,
            ConnectorFileAction.UploadCommit,
            ConnectorFileAction.UploadAbort,
            ConnectorFileAction.UploadChunk,
        ] as const) {
            expect(
                await step(
                    fixture,
                    reader,
                    action,
                    target,
                    action === ConnectorFileAction.UploadChunk
                        ? { offset: '0', dataBase64: 'YQ==' }
                        : {},
                ),
            ).toEqual({ ok: false, error: ConnectorFileFailure.Denied });
        }
        await using writable: FilesystemFixture = await FilesystemFixture.create(
            ConnectorFileMode.ReadWrite,
        );
        await using writer: ConnectorFilesystem = await ConnectorFilesystem.load(
            writable.policy,
            [],
        );
        expect(
            await writable.call(writer, ConnectorFileAction.UploadBegin, 'result', { ...target }),
        ).toEqual({ ok: false, error: ConnectorFileFailure.Denied });
        expect(await readdir(join(writable.directory, 'staging'))).toEqual([]);
    },
);
