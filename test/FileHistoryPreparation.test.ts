// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

import { ConnectorEffectKind } from '../src/runtime/ConnectorEffectContext.js';
import { mkdir, readFile, readdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { FileHistoryFixture } from './support/FileHistoryFixture.js';
import {
    ConnectorFileHistoryPreparation,
    ConnectorFileHistoryPreparationStatus,
    ConnectorFileHistoryPreparationBlock,
    ConnectorFileHistoryPreparationError,
    type ConnectorFileHistoryPreparationReport,
} from '../src/runtime/ConnectorFileHistoryPreparation.js';
import { ConnectorFileStageQuiescence } from '../src/runtime/ConnectorFileStageQuiescence.js';
import {
    ConnectorFileMode,
    ConnectorFileFailure,
    type ConnectorFileResponse,
} from 'nerva-connector-protocol/protocol/ConnectorFiles.js';
import { ConnectorFileAction } from 'nerva-connector-protocol/protocol/ConnectorFileTypes.js';
import type {
    ConnectorFileOperation,
    ConnectorFilePermit,
} from 'nerva-connector-protocol/protocol/ConnectorFileJobs.js';
import type { ConnectorClientIdentity } from '../src/runtime/ConnectorClientConfiguration.js';
import { ConnectorOperationJournal } from '../src/runtime/ConnectorOperationJournal.js';
import { SigningKey } from '../src/identity/SigningKey.js';

const helpers: boolean =
    process.platform === 'linux' && process.env['NERVA_CONNECTOR_FILES_HELPER'] !== undefined;

it.skipIf(!helpers)(
    'unconfigured preparation and cancellation create no histories or capability resources',
    async (): Promise<void> => {
        await using fixture: FileHistoryFixture = await FileHistoryFixture.create();
        const identity: ConnectorClientIdentity = {
            ...fixture.identity,
            settings: { ...fixture.identity.settings, files: null },
        };
        const before: readonly string[] = await readdir(fixture.files.directory, {
            recursive: true,
        });
        expect(
            await ConnectorFileHistoryPreparation.prepare(identity, new AbortController().signal),
        ).toEqual({
            configured: false,
            ready: true,
            history: null,
            stages: null,
            preparedPolicySha256: null,
        });
        const stop: AbortController = new AbortController();
        stop.abort();
        await expect(
            ConnectorFileHistoryPreparation.prepare(fixture.identity, stop.signal),
        ).rejects.toThrow();
        expect(await readdir(fixture.files.directory, { recursive: true })).toEqual(before);
    },
);

it.skipIf(!helpers).each([ConnectorFileMode.ReadOnly, ConnectorFileMode.ReadWrite])(
    'idle existing %s history is ready only after all stages are proven quiescent, without rewriting ciphertext',
    async (mode: ConnectorFileMode): Promise<void> => {
        await using fixture: FileHistoryFixture = await FileHistoryFixture.create(mode);
        const before: Buffer = await readFile(join(fixture.state, 'file-journal'));
        const report: ConnectorFileHistoryPreparationReport =
            await ConnectorFileHistoryPreparation.prepare(
                fixture.identity,
                new AbortController().signal,
            );
        expect(report).toMatchObject({
            configured: true,
            ready: true,
            stages: ConnectorFileStageQuiescence.Quiescent,
            preparedPolicySha256: fixture.policySha256,
            history: {
                acknowledgedSequence: 0n,
                pendingSequence: null,
                pendingJobId: null,
                status: ConnectorFileHistoryPreparationStatus.Idle,
                remoteAcknowledgmentPending: false,
            },
        });
        expect((await readFile(join(fixture.state, 'file-journal'))).equals(before)).toBe(true);
        expect(await fixture.pending()).toBe(null);
    },
);

it.skipIf(!helpers)(
    'missing, corrupt, wrong-key or live-owned history never becomes empty replacement history',
    async (): Promise<void> => {
        await using fixture: FileHistoryFixture = await FileHistoryFixture.create(
            ConnectorFileMode.ReadOnly,
            false,
        );
        await expect(
            ConnectorFileHistoryPreparation.prepare(fixture.identity, new AbortController().signal),
        ).rejects.toBeInstanceOf(ConnectorFileHistoryPreparationError);
        await expect(readFile(join(fixture.state, 'file-journal'))).rejects.toThrow();
        await writeFile(join(fixture.state, 'file-journal'), 'corrupt', { mode: 0o600 });
        await expect(
            ConnectorFileHistoryPreparation.prepare(fixture.identity, new AbortController().signal),
        ).rejects.toBeInstanceOf(ConnectorFileHistoryPreparationError);
        expect(await readFile(join(fixture.state, 'file-journal'), 'utf8')).toBe('corrupt');
        await using valid: FileHistoryFixture = await FileHistoryFixture.create();
        const before: Buffer = await readFile(join(valid.state, 'file-journal'));
        using wrong: SigningKey = SigningKey.generate();
        await expect(
            ConnectorFileHistoryPreparation.prepare(
                { ...valid.identity, key: wrong },
                new AbortController().signal,
            ),
        ).rejects.toBeInstanceOf(ConnectorFileHistoryPreparationError);
        await using journal: ConnectorOperationJournal<
            ConnectorFileOperation,
            ConnectorFileResponse
        > = await valid.journal();
        expect(journal.pending).toBe(null);
        await expect(
            ConnectorFileHistoryPreparation.prepare(valid.identity, new AbortController().signal),
        ).rejects.toBeInstanceOf(ConnectorFileHistoryPreparationError);
        expect((await readFile(join(valid.state, 'file-journal'))).equals(before)).toBe(true);
    },
);

it.skipIf(!helpers).each([ConnectorFileAction.Read, ConnectorFileAction.Write] as const)(
    'Started %s is sealed without replay, preserving the original and awaiting remote acknowledgment',
    async (action: ConnectorFileAction.Read | ConnectorFileAction.Write): Promise<void> => {
        await using fixture: FileHistoryFixture = await FileHistoryFixture.create();
        const original: ConnectorFilePermit = fixture.permit(action);
        await writeFile(join(fixture.files.root, 'destination'), 'OLD', { mode: 0o600 });
        await fixture.retain(original);
        const report: ConnectorFileHistoryPreparationReport =
            await ConnectorFileHistoryPreparation.prepare(
                fixture.identity,
                new AbortController().signal,
            );
        expect(report).toMatchObject({
            ready: false,
            stages: ConnectorFileStageQuiescence.Quiescent,
            preparedPolicySha256: fixture.policySha256,
            history: {
                acknowledgedSequence: 0n,
                pendingJobId: original.jobId,
                pendingSequence: original.sequence,
                status: ConnectorFileHistoryPreparationStatus.InterruptedAwaitingAcknowledgment,
                remoteAcknowledgmentPending: true,
            },
        });
        expect(await fixture.pending()).toEqual({
            jobId: original.jobId,
            sequence: original.sequence,
            dispatchId: original.dispatchId,
            effectContext: {
                kind: ConnectorEffectKind.HistoricalUnproven,
                sourceSha256: fixture.originalSourceSha256,
            },
            requestHash: original.requestHash,
            authorization: original.authorization,
            admissionHash: original.admissionHash,
            request: original.request,
            response: {
                ok: false,
                error:
                    action === ConnectorFileAction.Write
                        ? ConnectorFileFailure.Indeterminate
                        : ConnectorFileFailure.Unavailable,
            },
            progress: null,
        });
        expect(await readFile(join(fixture.files.root, 'destination'), 'utf8')).toBe('OLD');
        expect(await readdir(join(fixture.files.directory, 'staging'))).toEqual([]);
        const retainedBytes: Buffer = await readFile(join(fixture.state, 'file-journal'));
        expect(
            (
                await ConnectorFileHistoryPreparation.prepare(
                    fixture.identity,
                    new AbortController().signal,
                )
            ).history?.status,
        ).toBe(ConnectorFileHistoryPreparationStatus.AwaitingAcknowledgment);
        expect((await readFile(join(fixture.state, 'file-journal'))).equals(retainedBytes)).toBe(
            true,
        );
    },
);

it.skipIf(!helpers)(
    'a saved terminal Write keeps its exact result/ciphertext while refusing staging cleanup without physical provenance',
    async (): Promise<void> => {
        await using fixture: FileHistoryFixture = await FileHistoryFixture.create();
        const original: ConnectorFilePermit = fixture.permit();
        const result: ConnectorFileResponse = { ok: false, error: ConnectorFileFailure.Denied };
        await fixture.retain(original, result);
        const originalBytes: Buffer = await readFile(join(fixture.state, 'file-journal'));
        await writeFile(fixture.staged(original), 'unfinished', { mode: 0o600 });
        await writeFile(join(fixture.files.directory, 'staging/unrelated'), 'KEEP', {
            mode: 0o600,
        });
        const report: ConnectorFileHistoryPreparationReport =
            await ConnectorFileHistoryPreparation.prepare(
                fixture.identity,
                new AbortController().signal,
            );
        expect(report.ready).toBe(false);
        expect(report.history?.remoteAcknowledgmentPending).toBe(true);
        expect(report.stages).not.toBe(ConnectorFileStageQuiescence.Quiescent);
        expect((await fixture.pending())?.response).toEqual(result);
        expect((await readFile(join(fixture.state, 'file-journal'))).equals(originalBytes)).toBe(
            true,
        );
        expect(await readFile(fixture.staged(original), 'utf8')).toBe('unfinished');
        expect(await readFile(join(fixture.files.directory, 'staging/unrelated'), 'utf8')).toBe(
            'KEEP',
        );
    },
);

it.skipIf(!helpers)(
    'a changed original policy cannot clean either an old staging file or a replacement same-alias root',
    async (): Promise<void> => {
        await using fixture: FileHistoryFixture = await FileHistoryFixture.create();
        const original: ConnectorFilePermit = fixture.permit();
        await fixture.retain(original);
        await writeFile(fixture.staged(original), 'ORIGINAL', { mode: 0o600 });
        const replacement: string = join(fixture.files.directory, 'replacement');
        await mkdir(replacement, { mode: 0o700 });
        await writeFile(join(replacement, 'destination'), 'UNCHANGED', { mode: 0o600 });
        const encoded: string = await readFile(fixture.files.policy, 'utf8');
        await writeFile(fixture.files.policy, encoded.replace(fixture.files.root, replacement), {
            mode: 0o600,
        });
        const before: Buffer = await readFile(join(fixture.state, 'file-journal'));
        expect(
            await ConnectorFileHistoryPreparation.prepare(
                fixture.identity,
                new AbortController().signal,
            ),
        ).toMatchObject({
            ready: false,
            stages: null,
            preparedPolicySha256: null,
            history: {
                status: ConnectorFileHistoryPreparationStatus.Blocked,
                blocked: ConnectorFileHistoryPreparationBlock.OriginalPolicyChanged,
                remoteAcknowledgmentPending: false,
            },
        });
        expect((await readFile(join(fixture.state, 'file-journal'))).equals(before)).toBe(true);
        expect(await readFile(fixture.staged(original), 'utf8')).toBe('ORIGINAL');
        expect(await readFile(join(replacement, 'destination'), 'utf8')).toBe('UNCHANGED');
    },
);

it.skipIf(!helpers)(
    'a terminal non-Write result can be inspected without native code while its original acknowledgment remains pending',
    async (): Promise<void> => {
        await using fixture: FileHistoryFixture = await FileHistoryFixture.create(
            ConnectorFileMode.ReadOnly,
        );
        const original: ConnectorFilePermit = fixture.permit(ConnectorFileAction.Read);
        const response: ConnectorFileResponse = {
            ok: false,
            error: ConnectorFileFailure.Unavailable,
        };
        await fixture.retain(original, response);
        const before: Buffer = await readFile(join(fixture.state, 'file-journal'));
        await rm(fixture.files.policy);
        expect(
            await ConnectorFileHistoryPreparation.prepare(
                fixture.identity,
                new AbortController().signal,
            ),
        ).toMatchObject({
            ready: false,
            stages: null,
            preparedPolicySha256: null,
            history: {
                status: ConnectorFileHistoryPreparationStatus.AwaitingAcknowledgment,
                remoteAcknowledgmentPending: true,
            },
        });
        expect((await readFile(join(fixture.state, 'file-journal'))).equals(before)).toBe(true);
        expect((await fixture.pending())?.response).toEqual(response);
    },
);
