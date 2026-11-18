// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

import { createHash } from 'node:crypto';
import { chmod, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, it, vi, type MockInstance } from 'vitest';
import { FileHistoryFixture } from './support/FileHistoryFixture.js';
import {
    ConnectorFileHistoryPreparation,
    ConnectorFileHistoryPreparationStatus,
    ConnectorFileHistoryPreparationBlock,
    type ConnectorFileHistoryPreparationReport,
} from '../src/runtime/ConnectorFileHistoryPreparation.js';
import { ConnectorFileStageQuiescence } from '../src/runtime/ConnectorFileStageQuiescence.js';
import { ConnectorFilesystem } from '../src/runtime/ConnectorFilesystem.js';
import {
    ConnectorFileFailure,
    type ConnectorFileResponse,
} from 'nerva-connector-protocol/protocol/ConnectorFiles.js';
import {
    ConnectorFileAction,
    ConnectorWriteMode,
} from 'nerva-connector-protocol/protocol/ConnectorFileTypes.js';
import type {
    ConnectorFileOperation,
    ConnectorFilePermit,
} from 'nerva-connector-protocol/protocol/ConnectorFileJobs.js';
import { ConnectorOperationJournal } from '../src/runtime/ConnectorOperationJournal.js';
import { ConnectorFileProof } from 'nerva-connector-protocol/protocol/ConnectorFileProof.js';

const helpers: boolean =
    process.platform === 'linux' && process.env['NERVA_CONNECTOR_FILES_HELPER'] !== undefined;

it.skipIf(!helpers)(
    'an acknowledged upload can retain a private slot, so an empty journal alone never permits preparation',
    async (): Promise<void> => {
        await using fixture: FileHistoryFixture = await FileHistoryFixture.create();
        const payload: Buffer = Buffer.from('PRIVATE');
        const request: ConnectorFileOperation = {
            action: ConnectorFileAction.UploadBegin,
            requestId: 'upload',
            rootId: 'project',
            policySha256: fixture.policySha256,
            path: 'destination',
            uploadId: 'a'.repeat(64),
            mode: ConnectorWriteMode.Create,
            sizeBytes: BigInt(payload.byteLength),
            sha256: createHash('sha256').update(payload).digest('hex'),
        };
        const original: ConnectorFilePermit = fixture.operation(request);
        let response: ConnectorFileResponse;
        {
            await using files: ConnectorFilesystem = await ConnectorFilesystem.load(
                fixture.files.policy,
                [],
            );
            response = await fixture.files.call(
                files,
                ConnectorFileAction.UploadBegin,
                request.path,
                {
                    requestId: request.requestId,
                    uploadId: request.uploadId,
                    mode: request.mode,
                    sizeBytes: request.sizeBytes.toString(),
                    sha256: request.sha256,
                },
                'c'.repeat(64),
            );
            expect(response.ok).toBe(true);
        }
        await fixture.retain(original, response);
        {
            await using journal: ConnectorOperationJournal<
                ConnectorFileOperation,
                ConnectorFileResponse
            > = await fixture.journal();
            await journal.acknowledge({
                ...original,
                responseHash: ConnectorFileProof.responseHash(response),
            });
        }
        const before: readonly string[] = await readdir(join(fixture.files.directory, 'staging'));
        const ciphertext: Buffer = await readFile(join(fixture.state, 'file-journal'));
        expect(
            await ConnectorFileHistoryPreparation.prepare(
                fixture.identity,
                new AbortController().signal,
            ),
        ).toMatchObject({
            ready: false,
            history: {
                pendingJobId: null,
                pendingSequence: null,
                acknowledgedSequence: 1n,
                status: ConnectorFileHistoryPreparationStatus.Blocked,
            },
        });
        expect(await readdir(join(fixture.files.directory, 'staging'))).toEqual(before);
        expect((await readFile(join(fixture.state, 'file-journal'))).equals(ciphertext)).toBe(true);
        await expect(readFile(join(fixture.files.root, 'destination'))).rejects.toThrow();
    },
);

it.skipIf(!helpers)(
    'a Started upload becomes an original Indeterminate result without aborting or changing its retained private slot',
    async (): Promise<void> => {
        await using fixture: FileHistoryFixture = await FileHistoryFixture.create();
        const request: ConnectorFileOperation = {
            action: ConnectorFileAction.UploadBegin,
            requestId: 'upload',
            rootId: 'project',
            policySha256: fixture.policySha256,
            path: 'destination',
            uploadId: 'd'.repeat(64),
            mode: ConnectorWriteMode.Create,
            sizeBytes: 7n,
            sha256: createHash('sha256').update('PRIVATE').digest('hex'),
        };
        const original: ConnectorFilePermit = fixture.operation(request);
        await fixture.retain(original);
        {
            await using files: ConnectorFilesystem = await ConnectorFilesystem.load(
                fixture.files.policy,
                [],
            );
            expect(
                (
                    await fixture.files.call(
                        files,
                        request.action,
                        request.path,
                        {
                            requestId: request.requestId,
                            uploadId: request.uploadId,
                            mode: request.mode,
                            sizeBytes: request.sizeBytes.toString(),
                            sha256: request.sha256,
                        },
                        'c'.repeat(64),
                    )
                ).ok,
            ).toBe(true);
        }
        const stage: string = join(fixture.files.directory, 'staging');
        const names: readonly string[] = await readdir(stage);
        const before: readonly Buffer[] = await Promise.all(
            names.map((name: string): Promise<Buffer> => readFile(join(stage, name))),
        );
        const report: ConnectorFileHistoryPreparationReport =
            await ConnectorFileHistoryPreparation.prepare(
                fixture.identity,
                new AbortController().signal,
            );
        expect(report).toMatchObject({
            ready: false,
            history: {
                status: ConnectorFileHistoryPreparationStatus.Blocked,
                blocked: ConnectorFileHistoryPreparationBlock.StagesBusy,
                remoteAcknowledgmentPending: true,
            },
            stages: ConnectorFileStageQuiescence.Busy,
        });
        expect((await fixture.pending())?.response).toEqual({
            ok: false,
            error: ConnectorFileFailure.Indeterminate,
        });
        expect((await fixture.pending())?.requestHash).toBe(original.requestHash);
        expect(await readdir(stage)).toEqual(names);
        for (let index: number = 0; index < names.length; index++) {
            const name: string | undefined = names[index];
            const bytes: Buffer | undefined = before[index];
            if (name === undefined || bytes === undefined) {
                throw new Error('Bounded stage snapshot required');
            }
            expect((await readFile(join(stage, name))).equals(bytes)).toBe(true);
        }
        await expect(readFile(join(fixture.files.root, 'destination'))).rejects.toThrow();
    },
);

it.skipIf(!helpers).each([false, true])(
    'unproven original staging (unknown=%s) is retained and leaves Started and its ciphertext unchanged',
    async (unknown: boolean): Promise<void> => {
        await using fixture: FileHistoryFixture = await FileHistoryFixture.create();
        const original: ConnectorFilePermit = fixture.permit();
        await fixture.retain(original);
        if (unknown) {
            await chmod(join(fixture.files.directory, 'staging'), 0o500);
        } else {
            await mkdir(fixture.staged(original), { mode: 0o700 });
        }
        const before: Buffer = await readFile(join(fixture.state, 'file-journal'));
        expect(
            await ConnectorFileHistoryPreparation.prepare(
                fixture.identity,
                new AbortController().signal,
            ),
        ).toMatchObject({
            ready: false,
            stages: unknown
                ? ConnectorFileStageQuiescence.Unknown
                : ConnectorFileStageQuiescence.Busy,
            history: {
                status: ConnectorFileHistoryPreparationStatus.Blocked,
                blocked: ConnectorFileHistoryPreparationBlock.CleanupUnproven,
                remoteAcknowledgmentPending: false,
            },
            preparedPolicySha256: fixture.policySha256,
        });
        expect((await fixture.pending())?.response).toBe(null);
        expect((await readFile(join(fixture.state, 'file-journal'))).equals(before)).toBe(true);
        if (unknown) {
            expect(await readdir(join(fixture.files.directory, 'staging'))).toEqual([]);
        } else {
            expect(await readdir(fixture.staged(original))).toEqual([]);
        }
    },
);

it.skipIf(!helpers)(
    'a saved terminal Write cannot bypass its original policy even when its result is already durable',
    async (): Promise<void> => {
        await using fixture: FileHistoryFixture = await FileHistoryFixture.create();
        const original: ConnectorFilePermit = fixture.permit();
        await fixture.retain(original, { ok: false, error: ConnectorFileFailure.Indeterminate });
        await writeFile(fixture.staged(original), 'RETAINED', { mode: 0o600 });
        const before: Buffer = await readFile(join(fixture.state, 'file-journal'));
        const policy: string = await readFile(fixture.files.policy, 'utf8');
        await writeFile(fixture.files.policy, policy.replace('"revision":"1"', '"revision":"2"'), {
            mode: 0o600,
        });
        expect(
            await ConnectorFileHistoryPreparation.prepare(
                fixture.identity,
                new AbortController().signal,
            ),
        ).toMatchObject({
            ready: false,
            stages: null,
            history: {
                status: ConnectorFileHistoryPreparationStatus.Blocked,
                blocked: ConnectorFileHistoryPreparationBlock.OriginalPolicyChanged,
                remoteAcknowledgmentPending: true,
            },
        });
        expect((await readFile(join(fixture.state, 'file-journal'))).equals(before)).toBe(true);
        expect(await readFile(fixture.staged(original), 'utf8')).toBe('RETAINED');
    },
);

it.skipIf(!helpers)(
    'cancellation after real policy loading joins native ownership before any cleanup or journal finish',
    async (): Promise<void> => {
        await using fixture: FileHistoryFixture = await FileHistoryFixture.create();
        const original: ConnectorFilePermit = fixture.permit();
        await fixture.retain(original);
        await writeFile(fixture.staged(original), 'RETAINED', { mode: 0o600 });
        const before: Buffer = await readFile(join(fixture.state, 'file-journal'));
        const stop: AbortController = new AbortController();
        const load: typeof ConnectorFilesystem.load =
            ConnectorFilesystem.load.bind(ConnectorFilesystem);
        using override: MockInstance<typeof ConnectorFilesystem.load> = vi
            .spyOn(ConnectorFilesystem, 'load')
            .mockImplementation(
                async (
                    ...args: Parameters<typeof ConnectorFilesystem.load>
                ): Promise<ConnectorFilesystem> => {
                    const owner: ConnectorFilesystem = await load(...args);
                    stop.abort();
                    return owner;
                },
            );
        await expect(
            ConnectorFileHistoryPreparation.prepare(fixture.identity, stop.signal),
        ).rejects.toThrow();
        expect(override).toHaveBeenCalledOnce();
        expect((await readFile(join(fixture.state, 'file-journal'))).equals(before)).toBe(true);
        expect(await readFile(fixture.staged(original), 'utf8')).toBe('RETAINED');
        expect((await fixture.pending())?.response).toBe(null);
    },
);

it.skipIf(!helpers)(
    'unknown private staging content blocks an otherwise idle journal without deleting or rewriting anything',
    async (): Promise<void> => {
        await using fixture: FileHistoryFixture = await FileHistoryFixture.create();
        const unknown: string = join(fixture.files.directory, 'staging', 'unknown-operation');
        await writeFile(unknown, 'KEEP', { mode: 0o600 });
        const before: Buffer = await readFile(join(fixture.state, 'file-journal'));
        const report: ConnectorFileHistoryPreparationReport =
            await ConnectorFileHistoryPreparation.prepare(
                fixture.identity,
                new AbortController().signal,
            );
        expect(report.ready).toBe(false);
        expect(report.history?.pendingSequence).toBe(null);
        expect(report.history?.status).toBe(ConnectorFileHistoryPreparationStatus.Blocked);
        expect(report.stages).not.toBe(ConnectorFileStageQuiescence.Quiescent);
        expect((await readFile(join(fixture.state, 'file-journal'))).equals(before)).toBe(true);
        expect(await readFile(unknown, 'utf8')).toBe('KEEP');
    },
);
