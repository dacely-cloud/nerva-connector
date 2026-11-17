// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { expect, it, vi, type MockInstance } from 'vitest';
import type { ConnectorJournalPending } from '../src/runtime/ConnectorJournalState.js';
import { ConnectorOperationJournal } from '../src/runtime/ConnectorOperationJournal.js';
import type { ConnectorFileOperation } from 'nerva-connector-protocol/protocol/ConnectorFileJobs.js';
import { ConnectorClientFiles } from '../src/runtime/ConnectorClientFiles.js';
import { ConnectorFilesystem } from '../src/runtime/ConnectorFilesystem.js';
import {
    ConnectorEffectKind,
    type ConnectorCapturedFileEffect,
} from '../src/runtime/ConnectorEffectContext.js';
import { ConnectorFileJobsCodec } from 'nerva-connector-protocol/protocol/ConnectorFileJobsCodec.js';
import { ConnectorFileProof } from '../src/runtime/ConnectorFileProof.js';
import {
    ConnectorFileFailure,
    type ConnectorFileResponse,
} from 'nerva-connector-protocol/protocol/ConnectorFiles.js';
import type {
    ConnectorFilePermit,
    ConnectorFileCompletion,
} from 'nerva-connector-protocol/protocol/ConnectorFileJobs.js';
import { CapturedEffectsFixture, type CapturedOriginal } from './support/CapturedEffectsFixture.js';

const helper: string | undefined = process.env['NERVA_CONNECTOR_FILES_HELPER'];

/** Both physical capabilities must remain pinned to their original objects across recovery. */
enum Replacement {
    Root = 'root',
    Staging = 'staging',
}

it.skipIf(helper === undefined)(
    'a fresh signed write durably captures real root and staging before native dispatch, then retains its actual result',
    async (): Promise<void> => {
        await using fixture: CapturedEffectsFixture = await CapturedEffectsFixture.create();
        await writeFile(join(fixture.history.files.root, 'destination'), 'OLD', { mode: 0o600 });
        const permit: ConnectorFilePermit = fixture.permit();
        let expected: ConnectorCapturedFileEffect;
        {
            await using filesystem: ConnectorFilesystem = await fixture.filesystem();
            expected = await filesystem.effectContext('project');
        }
        expect(expected.kind).toBe(ConnectorEffectKind.CapturedFile);
        expect(expected.staging).not.toBeNull();
        const idle: Buffer = await readFile(join(fixture.history.state, 'file-journal'));
        let started: Buffer | null = null;
        const dispatch: MockInstance<typeof ConnectorFilesystem.prototype.dispatchBound> = vi.spyOn(
            ConnectorFilesystem.prototype,
            'dispatchBound',
        );
        dispatch.mockImplementationOnce(async function (
            this: ConnectorFilesystem,
            json: string,
            token: string | undefined,
            effect: ConnectorCapturedFileEffect,
        ): Promise<ConnectorFileResponse> {
            expect(effect).toEqual(expected);
            started = await readFile(join(fixture.history.state, 'file-journal'));
            expect(started.equals(idle)).toBe(false);
            expect(await readFile(join(fixture.history.files.root, 'destination'), 'utf8')).toBe(
                'OLD',
            );
            dispatch.mockRestore();
            return await this.dispatchBound(json, token, effect);
        });
        try {
            await using client: ConnectorClientFiles = await ConnectorClientFiles.load(
                fixture.history.identity,
            );
            const completed: ConnectorFileCompletion = await client.execute(
                permit,
                permit.leaseId,
                permit.expiresAtMs + 10000n,
            );
            expect(completed.response.ok).toBe(true);
            expect(await readFile(join(fixture.history.files.root, 'destination'), 'utf8')).toBe(
                'NEW',
            );
        } finally {
            dispatch.mockRestore();
        }
        const pending: ConnectorJournalPending<
            ConnectorFileOperation,
            ConnectorFileResponse
        > | null = await fixture.history.pending();
        expect(pending?.effectContext).toEqual(expected);
        expect(pending?.response?.ok).toBe(true);
        expect(pending?.requestHash).toBe(permit.requestHash);
        expect(started).not.toBeNull();
        expect((await readFile(join(fixture.history.state, 'file-journal'))).equals(idle)).toBe(
            false,
        );
    },
);

it.skipIf(helper === undefined)(
    'an interruption at the dispatch boundary leaves independently reloadable captured Started provenance before any native mutation',
    async (): Promise<void> => {
        await using fixture: CapturedEffectsFixture = await CapturedEffectsFixture.create();
        await writeFile(join(fixture.history.files.root, 'destination'), 'ORIGINAL', {
            mode: 0o600,
        });
        const permit: ConnectorFilePermit = fixture.permit();
        let expected: ConnectorCapturedFileEffect;
        {
            await using filesystem: ConnectorFilesystem = await fixture.filesystem();
            expected = await filesystem.effectContext('project');
        }
        const dispatch: MockInstance<typeof ConnectorFilesystem.prototype.dispatchBound> = vi
            .spyOn(ConnectorFilesystem.prototype, 'dispatchBound')
            .mockRejectedValueOnce(new Error('Owned interruption before native dispatch'));
        try {
            await using client: ConnectorClientFiles = await ConnectorClientFiles.load(
                fixture.history.identity,
            );
            await expect(
                client.execute(permit, permit.leaseId, permit.expiresAtMs + 10000n),
            ).rejects.toThrow();
            expect(dispatch).toHaveBeenCalledTimes(1);
        } finally {
            dispatch.mockRestore();
        }
        const pending: ConnectorJournalPending<
            ConnectorFileOperation,
            ConnectorFileResponse
        > | null = await fixture.history.pending();
        expect(pending?.effectContext).toEqual(expected);
        expect(pending?.request).toEqual(permit.request);
        expect(pending?.requestHash).toBe(permit.requestHash);
        expect(pending?.response).toBeNull();
        expect(await readFile(join(fixture.history.files.root, 'destination'), 'utf8')).toBe(
            'ORIGINAL',
        );
        await expect(readFile(fixture.history.staged(permit))).rejects.toMatchObject({
            code: 'ENOENT',
        });
    },
);

for (const replacement of Object.values(Replacement)) {
    it.skipIf(helper === undefined)(
        'Started recovery refuses replaced ' +
            replacement +
            ' without cleanup, publication, or journal changes',
        async (): Promise<void> => {
            await using fixture: CapturedEffectsFixture = await CapturedEffectsFixture.create();
            await writeFile(join(fixture.history.files.root, 'destination'), 'ORIGINAL', {
                mode: 0o600,
            });
            const permit: ConnectorFilePermit = fixture.permit();
            const seeded: CapturedOriginal = await fixture.seed(permit);
            await writeFile(fixture.history.staged(permit), 'ORIGINAL PARTIAL', { mode: 0o600 });
            const target: string =
                replacement === Replacement.Root
                    ? fixture.history.files.root
                    : join(fixture.history.files.directory, 'staging');
            const preserved: string = target + '-original';
            await rename(target, preserved);
            await mkdir(target, { mode: 0o700 });
            if (replacement === Replacement.Root) {
                await writeFile(join(target, 'destination'), 'NEW ROOT', { mode: 0o600 });
            } else {
                await writeFile(
                    join(target, basename(fixture.history.staged(permit))),
                    'FOREIGN STAGE',
                    { mode: 0o600 },
                );
            }
            const before: Buffer = await readFile(join(fixture.history.state, 'file-journal'));
            const cleanup: MockInstance<typeof ConnectorFilesystem.prototype.cleanupWrite> =
                vi.spyOn(ConnectorFilesystem.prototype, 'cleanupWrite');
            const dispatch: MockInstance<typeof ConnectorFilesystem.prototype.dispatchBound> =
                vi.spyOn(ConnectorFilesystem.prototype, 'dispatchBound');
            try {
                await using client: ConnectorClientFiles = await ConnectorClientFiles.load(
                    fixture.history.identity,
                );
                const current: ConnectorFilePermit = fixture.permit(permit);
                await expect(
                    client.execute(current, current.leaseId, current.expiresAtMs + 10000n),
                ).rejects.toThrow();
                expect(cleanup).not.toHaveBeenCalled();
                expect(dispatch).not.toHaveBeenCalled();
            } finally {
                cleanup.mockRestore();
                dispatch.mockRestore();
            }
            expect(
                (await readFile(join(fixture.history.state, 'file-journal'))).equals(before),
            ).toBe(true);
            const pending: ConnectorJournalPending<
                ConnectorFileOperation,
                ConnectorFileResponse
            > | null = await fixture.history.pending();
            expect(pending?.effectContext).toEqual(seeded.effect);
            expect(pending?.response).toBeNull();
            expect(pending?.requestHash).toBe(permit.requestHash);
            expect(await readFile(join(fixture.history.files.root, 'destination'), 'utf8')).toBe(
                replacement === Replacement.Root ? 'NEW ROOT' : 'ORIGINAL',
            );
            expect(
                await readFile(
                    replacement === Replacement.Staging
                        ? join(preserved, basename(fixture.history.staged(permit)))
                        : fixture.history.staged(permit),
                    'utf8',
                ),
            ).toBe('ORIGINAL PARTIAL');
            if (replacement === Replacement.Staging) {
                expect(await readFile(fixture.history.staged(permit), 'utf8')).toBe(
                    'FOREIGN STAGE',
                );
            } else {
                expect(await readFile(join(preserved, 'destination'), 'utf8')).toBe('ORIGINAL');
            }
        },
    );
}

it.skipIf(helper === undefined)(
    'the same pinned owner writes only its original renamed root and never the new pathname occupant',
    async (): Promise<void> => {
        await using fixture: CapturedEffectsFixture = await CapturedEffectsFixture.create();
        await writeFile(join(fixture.history.files.root, 'destination'), 'ORIGINAL', {
            mode: 0o600,
        });
        const permit: ConnectorFilePermit = fixture.permit();
        await using filesystem: ConnectorFilesystem = await fixture.filesystem();
        const effect: ConnectorCapturedFileEffect = await filesystem.effectContext('project');
        const preserved: string = fixture.history.files.root + '-original';
        await rename(fixture.history.files.root, preserved);
        await mkdir(fixture.history.files.root, { mode: 0o700 });
        await writeFile(join(fixture.history.files.root, 'destination'), 'NEW ROOT', {
            mode: 0o600,
        });
        const response: ConnectorFileResponse = await filesystem.dispatchBound(
            ConnectorFileJobsCodec.encode(permit.request),
            fixture.token(permit),
            effect,
        );
        expect(response.ok).toBe(true);
        await filesystem.cleanupWrite(permit.request, fixture.token(permit), effect);
        expect(await readFile(join(preserved, 'destination'), 'utf8')).toBe('NEW');
        expect(await readFile(join(fixture.history.files.root, 'destination'), 'utf8')).toBe(
            'NEW ROOT',
        );
        expect(await filesystem.effectContext('project')).toEqual(effect);
    },
);

it.skipIf(helper === undefined)(
    'terminal replay survives root and staging replacement with no recapture, cleanup, or repeated native effect',
    async (): Promise<void> => {
        await using fixture: CapturedEffectsFixture = await CapturedEffectsFixture.create();
        await writeFile(join(fixture.history.files.root, 'destination'), 'ORIGINAL', {
            mode: 0o600,
        });
        const permit: ConnectorFilePermit = fixture.permit();
        const original: CapturedOriginal = await fixture.seed(permit, true);
        for (const target of [
            fixture.history.files.root,
            join(fixture.history.files.directory, 'staging'),
        ]) {
            await rename(target, target + '-original');
            await mkdir(target, { mode: 0o700 });
        }
        await writeFile(join(fixture.history.files.root, 'destination'), 'NEW ROOT', {
            mode: 0o600,
        });
        await writeFile(fixture.history.staged(permit), 'FOREIGN STAGE', { mode: 0o600 });
        const before: Buffer = await readFile(join(fixture.history.state, 'file-journal'));
        const capture: MockInstance<typeof ConnectorFilesystem.prototype.effectContext> = vi.spyOn(
            ConnectorFilesystem.prototype,
            'effectContext',
        );
        const cleanup: MockInstance<typeof ConnectorFilesystem.prototype.cleanupWrite> = vi.spyOn(
            ConnectorFilesystem.prototype,
            'cleanupWrite',
        );
        const dispatch: MockInstance<typeof ConnectorFilesystem.prototype.dispatchBound> = vi.spyOn(
            ConnectorFilesystem.prototype,
            'dispatchBound',
        );
        try {
            await using client: ConnectorClientFiles = await ConnectorClientFiles.load(
                fixture.history.identity,
            );
            const current: ConnectorFilePermit = fixture.permit(permit);
            const completion: ConnectorFileCompletion = await client.execute(
                current,
                current.leaseId,
                current.expiresAtMs + 10000n,
            );
            expect(completion.response).toEqual(original.response);
            if (original.response === null) {
                throw new Error('Actual original terminal result required');
            }
            expect(completion.responseHash).toBe(
                ConnectorFileProof.responseHash(original.response),
            );
            expect(capture).not.toHaveBeenCalled();
            expect(cleanup).not.toHaveBeenCalled();
            expect(dispatch).not.toHaveBeenCalled();
        } finally {
            capture.mockRestore();
            cleanup.mockRestore();
            dispatch.mockRestore();
        }
        expect((await readFile(join(fixture.history.state, 'file-journal'))).equals(before)).toBe(
            true,
        );
        expect(await readFile(join(fixture.history.files.root, 'destination'), 'utf8')).toBe(
            'NEW ROOT',
        );
        expect(await readFile(fixture.history.staged(permit), 'utf8')).toBe('FOREIGN STAGE');
    },
);

it.skipIf(helper === undefined)(
    'HistoricalUnproven preserves original staging without cleanup or replay, and cannot authorize a fresh Started record',
    async (): Promise<void> => {
        await using fixture: CapturedEffectsFixture = await CapturedEffectsFixture.create(false);
        const permit: ConnectorFilePermit = fixture.permit();
        await fixture.historical(permit);
        await writeFile(join(fixture.history.files.root, 'destination'), 'ORIGINAL', {
            mode: 0o600,
        });
        await writeFile(fixture.history.staged(permit), 'HISTORICAL PARTIAL', { mode: 0o600 });
        const cleanup: MockInstance<typeof ConnectorFilesystem.prototype.cleanupWrite> = vi.spyOn(
            ConnectorFilesystem.prototype,
            'cleanupWrite',
        );
        const dispatch: MockInstance<typeof ConnectorFilesystem.prototype.dispatchBound> = vi.spyOn(
            ConnectorFilesystem.prototype,
            'dispatchBound',
        );
        try {
            await using client: ConnectorClientFiles = await ConnectorClientFiles.load(
                fixture.history.identity,
            );
            const completion: ConnectorFileCompletion = await client.execute(
                permit,
                permit.leaseId,
                permit.expiresAtMs + 10000n,
            );
            expect(completion.response).toEqual({
                ok: false,
                error: ConnectorFileFailure.Indeterminate,
            });
            expect(cleanup).not.toHaveBeenCalled();
            expect(dispatch).not.toHaveBeenCalled();
        } finally {
            cleanup.mockRestore();
            dispatch.mockRestore();
        }
        expect(await readFile(fixture.history.staged(permit), 'utf8')).toBe('HISTORICAL PARTIAL');
        expect(await readFile(join(fixture.history.files.root, 'destination'), 'utf8')).toBe(
            'ORIGINAL',
        );
        const pending: ConnectorJournalPending<
            ConnectorFileOperation,
            ConnectorFileResponse
        > | null = await fixture.history.pending();
        expect(pending?.effectContext.kind).toBe(ConnectorEffectKind.HistoricalUnproven);
        await using fresh: CapturedEffectsFixture = await CapturedEffectsFixture.create();
        const before: Buffer = await readFile(join(fresh.history.state, 'file-journal'));
        {
            await using journal: ConnectorOperationJournal<
                ConnectorFileOperation,
                ConnectorFileResponse
            > = await fresh.history.journal();
            await expect(
                journal.begin(fresh.permit(), {
                    kind: ConnectorEffectKind.HistoricalUnproven,
                    sourceSha256: 'f'.repeat(64),
                }),
            ).rejects.toThrow();
            expect(journal.pending).toBeNull();
        }
        expect((await readFile(join(fresh.history.state, 'file-journal'))).equals(before)).toBe(
            true,
        );
    },
);
