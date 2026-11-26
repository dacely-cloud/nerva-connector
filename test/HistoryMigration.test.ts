// SPDX-FileCopyrightText: 2026 Dacely <business@dacely.com>
// SPDX-License-Identifier: LicenseRef-Proprietary

import { watch, type FSWatcher } from 'node:fs';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { expect, it } from 'vitest';
import { RuntimeMigrationApprovalFixture } from './support/RuntimeMigrationApprovalFixture.js';
import type { ConnectorMigrationApproval } from 'nerva-connector-protocol/protocol/ConnectorAdmissionMigration.js';
import { FileHistoryFixture } from './support/FileHistoryFixture.js';
import {
    ConnectorHistoryMigration,
    ConnectorHistoryMigrationError,
} from '../src/runtime/ConnectorHistoryMigration.js';
import {
    ConnectorHistoryMigrationMarker,
    ConnectorHistoryMigrationPhase,
    type ConnectorHistoryMigrationReceipt,
} from '../src/runtime/ConnectorHistoryMigrationMarker.js';
import { ConnectorOperationJournal } from '../src/runtime/ConnectorOperationJournal.js';
import {
    ConnectorEffectKind,
    type ConnectorEffectContext,
} from '../src/runtime/ConnectorEffectContext.js';
import {
    ConnectorFileFailure,
    type ConnectorFileResponse,
} from 'nerva-connector-protocol/protocol/ConnectorFiles.js';
import { ConnectorFileAction } from 'nerva-connector-protocol/protocol/ConnectorFileTypes.js';
import type {
    ConnectorFileOperation,
    ConnectorFilePermit,
} from 'nerva-connector-protocol/protocol/ConnectorFileJobs.js';
import { ConnectorFileProof } from 'nerva-connector-protocol/protocol/ConnectorFileProof.js';
import { JournalEffectFixture } from './support/JournalEffectFixture.js';

const helpers: boolean =
    process.platform === 'linux' && process.env['NERVA_CONNECTOR_FILES_HELPER'] !== undefined;

it.skipIf(!helpers)(
    'normal runtime rejects old history until explicit migration preserves the original and adds only exact-source unproven provenance',
    async (): Promise<void> => {
        await using fixture: FileHistoryFixture = await FileHistoryFixture.create();
        const original: ConnectorFilePermit = fixture.permit();
        const response: ConnectorFileResponse = {
            ok: false,
            error: ConnectorFileFailure.Indeterminate,
        };
        await fixture.retainOriginal(original, response);
        await expect(fixture.journal()).rejects.toThrow('migration');
        const approval: ConnectorMigrationApproval = await RuntimeMigrationApprovalFixture.prepare(
            fixture.identity,
        );
        expect(
            await ConnectorHistoryMigration.run(
                fixture.identity.configurationFile,
                new AbortController().signal,
                approval,
            ),
        ).toEqual({ complete: true, upgraded: 1, alreadyCurrent: 0, historicalPending: 1 });
        expect(await fixture.pending()).toEqual({
            jobId: original.jobId,
            sequence: original.sequence,
            dispatchId: original.dispatchId,
            requestHash: original.requestHash,
            admissionHash: original.admissionHash,
            authorization: original.authorization,
            request: original.request,
            response,
            progress: null,
            effectContext: {
                kind: ConnectorEffectKind.HistoricalUnproven,
                sourceSha256: fixture.originalSourceSha256,
            },
        });
        await ConnectorHistoryMigration.requireComplete(fixture.identity);
        const bytes: Buffer = await readFile(join(fixture.state, 'file-journal'));
        {
            await using journal: ConnectorOperationJournal<
                ConnectorFileOperation,
                ConnectorFileResponse
            > = await fixture.journal();
            const effect: ConnectorEffectContext | undefined = journal.pending?.effectContext;
            if (effect === undefined) {
                throw new Error('Migrated original required');
            }
            expect((await journal.begin(original, effect)).fresh).toBe(false);
            await expect(
                journal.begin(original, JournalEffectFixture.file(original.request)),
            ).rejects.toThrow('context');
        }
        expect((await readFile(join(fixture.state, 'file-journal'))).equals(bytes)).toBe(true);
    },
);

it.skipIf(!helpers)(
    'fresh Historical tags are denied and immutable current context survives result retention and acknowledgment',
    async (): Promise<void> => {
        await using fixture: FileHistoryFixture = await FileHistoryFixture.create();
        const original: ConnectorFilePermit = fixture.permit();
        await using journal: ConnectorOperationJournal<
            ConnectorFileOperation,
            ConnectorFileResponse
        > = await fixture.journal();
        await expect(
            journal.begin(original, {
                kind: ConnectorEffectKind.HistoricalUnproven,
                sourceSha256: 'a'.repeat(64),
            }),
        ).rejects.toThrow('Historical');
        await journal.begin(original, JournalEffectFixture.file(original.request));
        expect(Object.isFrozen(journal.pending)).toBe(true);
        const captured: ConnectorEffectContext | undefined = journal.pending?.effectContext;
        expect(
            Reflect.set(journal.pending ?? {}, 'effectContext', {
                kind: ConnectorEffectKind.HistoricalUnproven,
                sourceSha256: 'b'.repeat(64),
            }),
        ).toBe(false);
        const response: ConnectorFileResponse = {
            ok: false,
            error: ConnectorFileFailure.Indeterminate,
        };
        await journal.finish(original, response);
        expect(journal.pending?.effectContext).toEqual(captured);
        expect(Object.isFrozen(journal.pending)).toBe(true);
        await journal.acknowledge({
            ...original,
            responseHash: ConnectorFileProof.responseHash(response),
        });
        expect(journal.pending).toBe(null);
        expect(journal.acknowledgedSequence).toBe(1n);
    },
);

it.skipIf(!helpers)(
    'a durable prepared marker fences runtime after interruption and resumes the exact converted target without rewriting it',
    async (): Promise<void> => {
        await using fixture: FileHistoryFixture = await FileHistoryFixture.create();
        await fixture.retainOriginal(fixture.permit());
        const approval: ConnectorMigrationApproval = await RuntimeMigrationApprovalFixture.prepare(
            fixture.identity,
        );
        const stop: AbortController = new AbortController();
        const observer: FSWatcher = watch(
            fixture.state,
            (_event: string, filename: string | Buffer | null): void => {
                if (filename === 'file-journal') {
                    stop.abort();
                }
            },
        );
        try {
            await expect(
                ConnectorHistoryMigration.run(
                    fixture.identity.configurationFile,
                    stop.signal,
                    approval,
                ),
            ).rejects.toBeInstanceOf(ConnectorHistoryMigrationError);
        } finally {
            observer.close();
        }
        await expect(
            ConnectorHistoryMigration.requireComplete(fixture.identity),
        ).rejects.toBeInstanceOf(ConnectorHistoryMigrationError);
        const path: string = join(
            dirname(fixture.identity.settings.privateKeyFile),
            ConnectorHistoryMigrationMarker.filename,
        );
        const marker: ConnectorHistoryMigrationReceipt = ConnectorHistoryMigrationMarker.read(
            await readFile(path),
            fixture.identity,
        );
        expect(marker.phase).toBe(ConnectorHistoryMigrationPhase.Prepared);
        expect(marker.entries[0]?.sourceSha256).toBe(fixture.originalSourceSha256);
        const converted: Buffer = await readFile(join(fixture.state, 'file-journal'));
        expect(
            await ConnectorHistoryMigration.run(
                fixture.identity.configurationFile,
                new AbortController().signal,
                approval,
            ),
        ).toEqual({ complete: true, upgraded: 0, alreadyCurrent: 1, historicalPending: 1 });
        expect((await readFile(join(fixture.state, 'file-journal'))).equals(converted)).toBe(true);
        await ConnectorHistoryMigration.requireComplete(fixture.identity);
    },
);

it.skipIf(!helpers)(
    'a prepared marker rejects substituted current payloads while a completed marker permits later legitimate current history',
    async (): Promise<void> => {
        await using fixture: FileHistoryFixture = await FileHistoryFixture.create();
        const original: ConnectorFilePermit = fixture.permit();
        await fixture.retain(original);
        const markerPath: string = join(
            dirname(fixture.identity.settings.privateKeyFile),
            ConnectorHistoryMigrationMarker.filename,
        );
        const complete: ConnectorHistoryMigrationReceipt = ConnectorHistoryMigrationMarker.read(
            await readFile(markerPath),
            fixture.identity,
        );
        await writeFile(
            markerPath,
            JSON.stringify(
                ConnectorHistoryMigrationMarker.create(
                    fixture.identity,
                    ConnectorHistoryMigrationPhase.Prepared,
                    complete.entries,
                    complete.approvalSha256,
                    null,
                ),
            ),
            { mode: 0o600 },
        );
        const response: ConnectorFileResponse = {
            ok: false,
            error: ConnectorFileFailure.Indeterminate,
        };
        {
            await using journal: ConnectorOperationJournal<
                ConnectorFileOperation,
                ConnectorFileResponse
            > = await fixture.journal();
            await journal.finish(original, response);
        }
        const bytes: Buffer = await readFile(join(fixture.state, 'file-journal'));
        await expect(
            ConnectorHistoryMigration.run(
                fixture.identity.configurationFile,
                new AbortController().signal,
            ),
        ).rejects.toBeInstanceOf(ConnectorHistoryMigrationError);
        expect((await readFile(join(fixture.state, 'file-journal'))).equals(bytes)).toBe(true);
        await writeFile(markerPath, JSON.stringify(complete), { mode: 0o600 });
        expect(
            await ConnectorHistoryMigration.run(
                fixture.identity.configurationFile,
                new AbortController().signal,
            ),
        ).toMatchObject({ complete: true, upgraded: 0 });
        expect((await readFile(join(fixture.state, 'file-journal'))).equals(bytes)).toBe(true);
    },
);

it.skipIf(!helpers)(
    'missing or corrupt originals and invalid markers never initialize or rewrite histories',
    async (): Promise<void> => {
        await using missing: FileHistoryFixture = await FileHistoryFixture.create(undefined, false);
        await expect(
            ConnectorHistoryMigration.run(
                missing.identity.configurationFile,
                new AbortController().signal,
            ),
        ).rejects.toBeInstanceOf(ConnectorHistoryMigrationError);
        expect(await readdir(missing.state)).toEqual([]);
        await using fixture: FileHistoryFixture = await FileHistoryFixture.create();
        await fixture.retainOriginal(fixture.permit(ConnectorFileAction.Read));
        await writeFile(join(fixture.state, 'file-journal'), 'BROKEN', { mode: 0o600 });
        await expect(
            ConnectorHistoryMigration.run(
                fixture.identity.configurationFile,
                new AbortController().signal,
            ),
        ).rejects.toBeInstanceOf(ConnectorHistoryMigrationError);
        expect(await readFile(join(fixture.state, 'file-journal'), 'utf8')).toBe('BROKEN');
        expect(await readdir(dirname(fixture.identity.settings.privateKeyFile))).not.toContain(
            ConnectorHistoryMigrationMarker.filename,
        );
    },
);

it.skipIf(!helpers)(
    'a stopped signed plan cannot replace explicit authority approval and leaves old ciphertext untouched',
    async (): Promise<void> => {
        await using fixture: FileHistoryFixture = await FileHistoryFixture.create();
        await fixture.retainOriginal(fixture.permit());
        const path: string = join(fixture.state, 'file-journal');
        const original: Buffer = await readFile(path);
        await RuntimeMigrationApprovalFixture.prepare(fixture.identity);
        await expect(
            ConnectorHistoryMigration.run(
                fixture.identity.configurationFile,
                new AbortController().signal,
            ),
        ).rejects.toBeInstanceOf(ConnectorHistoryMigrationError);
        expect((await readFile(path)).equals(original)).toBe(true);
        await expect(fixture.journal()).rejects.toThrow('migration');
        expect(await readdir(dirname(fixture.identity.settings.privateKeyFile))).not.toContain(
            ConnectorHistoryMigrationMarker.filename,
        );
    },
);
