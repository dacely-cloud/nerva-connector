// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

import { watch, type FSWatcher } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { expect, it } from 'vitest';
import { HistoryMigrationFixture } from './support/HistoryMigrationFixture.js';
import {
    ConnectorHistoryMigration,
    ConnectorHistoryMigrationError,
} from '../src/runtime/ConnectorHistoryMigration.js';
import {
    ConnectorHistoryMigrationMarker,
    ConnectorHistoryMigrationPhase,
} from '../src/runtime/ConnectorHistoryMigrationMarker.js';
import { ConnectorJournalStore } from '../src/runtime/ConnectorJournalStore.js';
import {
    OriginalJournalFixtureCodec,
    type OriginalJournalFixtureSnapshot,
} from './support/OriginalJournalFixtureCodec.js';
import { RuntimeMigrationApprovalFixture } from './support/RuntimeMigrationApprovalFixture.js';
import type { ConnectorMigrationApproval } from 'nerva-connector-protocol/protocol/ConnectorAdmissionMigration.js';
import type { ConnectorJournalRecord } from '../src/runtime/ConnectorJournalRecord.js';
import {
    ConnectorAuthorizationKind,
    type ConnectorAuthorization,
} from 'nerva-connector-protocol/protocol/ConnectorAuthorization.js';
import { ConnectorAuthorizationProof } from 'nerva-connector-protocol/protocol/ConnectorAuthorizationProof.js';
import { ConnectorJournalCipher } from '../src/runtime/ConnectorJournalCipher.js';
import {
    ConnectorJournalState,
    type ConnectorJournalSnapshot,
} from '../src/runtime/ConnectorJournalState.js';
import { ConnectorOperationJournal } from '../src/runtime/ConnectorOperationJournal.js';
import { ConnectorEffectKind } from '../src/runtime/ConnectorEffectContext.js';
import { type ExecutionRequest } from 'nerva-connector-protocol/execution/ExecutionJobs.js';
import { ExecutionLane } from 'nerva-connector-protocol/execution/ExecutionLane.js';
import type { ExecutionResult } from 'nerva-connector-protocol/execution/ExecutionTypes.js';
import type { ExecutionOutput } from 'nerva-connector-protocol/execution/ExecutionOutput.js';
import { ExecutionJournalCodec } from '../src/execution/ExecutionJournalCodec.js';

const helpers: boolean =
    process.platform === 'linux' && process.env['NERVA_CONNECTOR_FILES_HELPER'] !== undefined;

it.skipIf(!helpers)(
    'prevalidates all three old histories before any marker/history write and never initializes a missing or corrupt last lane',
    async (): Promise<void> => {
        await using fixture: HistoryMigrationFixture = await HistoryMigrationFixture.create();
        const file: string = join(fixture.file.state, 'file-journal');
        const first: string = join(
            fixture.executionState,
            ExecutionLane.First,
            'execution-journal',
        );
        const last: string = join(
            fixture.executionState,
            ExecutionLane.Second,
            'execution-journal',
        );
        const originals: readonly Buffer[] = await Promise.all([readFile(file), readFile(first)]);
        await writeFile(last, 'CORRUPT LAST LANE', { mode: 0o600 });
        await expect(
            ConnectorHistoryMigration.run(
                fixture.identity.configurationFile,
                new AbortController().signal,
            ),
        ).rejects.toBeInstanceOf(ConnectorHistoryMigrationError);
        expect((await readFile(file)).equals(originals[0] ?? Buffer.alloc(0))).toBe(true);
        expect((await readFile(first)).equals(originals[1] ?? Buffer.alloc(0))).toBe(true);
        expect(await readFile(last, 'utf8')).toBe('CORRUPT LAST LANE');
        await expect(
            readFile(
                join(
                    dirname(fixture.identity.settings.privateKeyFile),
                    ConnectorHistoryMigrationMarker.filename,
                ),
            ),
        ).rejects.toThrow();
    },
);

it.skipIf(!helpers)(
    'resumes mixed old/current histories under the original prepared marker and preserves binary progress, terminal output and bigint watermarks',
    async (): Promise<void> => {
        await using fixture: HistoryMigrationFixture = await HistoryMigrationFixture.create();
        const originalExecution: ConnectorJournalRecord<
            OriginalJournalFixtureSnapshot<ExecutionRequest, ExecutionResult, ExecutionOutput>
        >[] = [];
        for (const lane of Object.values(ExecutionLane)) {
            const operation: ExecutionJournalCodec = new ExecutionJournalCodec(lane);
            await using source: ConnectorJournalStore<
                OriginalJournalFixtureSnapshot<ExecutionRequest, ExecutionResult, ExecutionOutput>
            > = await ConnectorJournalStore.open(
                join(fixture.executionState, lane),
                fixture.identity.settings.enrollmentId,
                fixture.identity.key,
                operation.purpose,
                new OriginalJournalFixtureCodec(operation),
            );
            originalExecution.push(await source.readRecord());
        }
        const approval: ConnectorMigrationApproval = await RuntimeMigrationApprovalFixture.prepare(
            fixture.identity,
        );
        const stop: AbortController = new AbortController();
        const observer: FSWatcher = watch(
            fixture.file.state,
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
        const convertedFile: Buffer = await readFile(join(fixture.file.state, 'file-journal'));
        const markerPath: string = join(
            dirname(fixture.identity.settings.privateKeyFile),
            ConnectorHistoryMigrationMarker.filename,
        );
        expect(
            ConnectorHistoryMigrationMarker.read(await readFile(markerPath), fixture.identity)
                .phase,
        ).toBe(ConnectorHistoryMigrationPhase.Prepared);
        for (const lane of Object.values(ExecutionLane)) {
            await expect(
                ConnectorOperationJournal.load(
                    join(fixture.executionState, lane),
                    fixture.identity.settings.enrollmentId,
                    fixture.identity.key,
                    new ExecutionJournalCodec(lane),
                ),
            ).rejects.toThrow('migration');
        }
        expect(
            await ConnectorHistoryMigration.run(
                fixture.identity.configurationFile,
                new AbortController().signal,
                approval,
            ),
        ).toEqual({ complete: true, upgraded: 2, alreadyCurrent: 1, historicalPending: 3 });
        expect(
            (await readFile(join(fixture.file.state, 'file-journal'))).equals(convertedFile),
        ).toBe(true);
        let index: number = 0;
        for (const lane of Object.values(ExecutionLane)) {
            await using journal: ConnectorOperationJournal<
                ExecutionRequest,
                ExecutionResult,
                ExecutionOutput
            > = await ConnectorOperationJournal.load(
                join(fixture.executionState, lane),
                fixture.identity.settings.enrollmentId,
                fixture.identity.key,
                new ExecutionJournalCodec(lane),
            );
            const record:
                | ConnectorJournalRecord<
                      OriginalJournalFixtureSnapshot<
                          ExecutionRequest,
                          ExecutionResult,
                          ExecutionOutput
                      >
                  >
                | undefined = originalExecution[index++];
            if (record === undefined || record.state.pending === null) {
                throw new Error('Original lane fixture required');
            }
            const original: OriginalJournalFixtureSnapshot<
                ExecutionRequest,
                ExecutionResult,
                ExecutionOutput
            > = record.state;
            const authorization: ConnectorAuthorization = {
                kind: ConnectorAuthorizationKind.Independent,
            };
            expect(journal.id).toBe(original.journalId);
            expect(journal.acknowledgedSequence).toBe(original.acknowledgedSequence);
            using cipher: ConnectorJournalCipher<
                ConnectorJournalSnapshot<ExecutionRequest, ExecutionResult, ExecutionOutput>
            > = ConnectorJournalCipher.create(
                join(fixture.executionState, lane),
                fixture.identity.settings.enrollmentId,
                fixture.identity.key,
                new ExecutionJournalCodec(lane).purpose,
                new ConnectorJournalState(new ExecutionJournalCodec(lane)),
            );
            expect(
                cipher.decode(
                    await readFile(join(fixture.executionState, lane, 'execution-journal')),
                ).state.receipt,
            ).toEqual(
                original.receipt === null
                    ? null
                    : {
                          ...original.receipt,
                          admissionHash: ConnectorAuthorizationProof.execution(
                              original.receipt.requestHash,
                              lane,
                              authorization,
                          ),
                      },
            );
            expect(journal.pending).toEqual({
                ...original.pending,
                authorization,
                admissionHash: ConnectorAuthorizationProof.execution(
                    record.state.pending.requestHash,
                    lane,
                    authorization,
                ),
                effectContext: {
                    kind: ConnectorEffectKind.HistoricalUnproven,
                    sourceSha256: record.sourceSha256,
                },
            });
            expect(journal.pending?.effectContext.kind).toBe(
                ConnectorEffectKind.HistoricalUnproven,
            );
        }
        await ConnectorHistoryMigration.requireComplete(fixture.identity);
    },
);
