// SPDX-FileCopyrightText: 2026 Dacely <business@dacely.com>
// SPDX-License-Identifier: LicenseRef-Proprietary

import { ConnectorAuthorizationKind } from 'nerva-connector-protocol/protocol/ConnectorAuthorization.js';
import { ConnectorAuthorizationProof } from 'nerva-connector-protocol/protocol/ConnectorAuthorizationProof.js';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, it, vi, type MockInstance } from 'vitest';
import { ExecutionHistoryFixture } from './support/ExecutionHistoryFixture.js';
import { ConnectorEffectKind } from '../src/runtime/ConnectorEffectContext.js';
import { ConnectorOperationJournal } from '../src/runtime/ConnectorOperationJournal.js';
import {
    ConnectorPrivateDirectory,
    ConnectorDirectoryPurpose,
} from '../src/runtime/ConnectorPrivateDirectory.js';
import { ConnectorJournalSchema } from '../src/runtime/ConnectorJournalState.js';
import type { ConnectorOperationDispatch } from 'nerva-connector-protocol/protocol/ConnectorOperationDispatch.js';
import { type ExecutionRequest } from 'nerva-connector-protocol/execution/ExecutionJobs.js';
import { ExecutionLane } from 'nerva-connector-protocol/execution/ExecutionLane.js';
import { ExecutionCgroup } from '../src/execution/ExecutionCgroup.js';
import { ExecutionResultCodec } from '../src/execution/ExecutionResultCodec.js';
import type { ExecutionOutput } from 'nerva-connector-protocol/execution/ExecutionOutput.js';
import {
    ExecutionFailure,
    ExecutionTermination,
    type ExecutionResult,
} from 'nerva-connector-protocol/execution/ExecutionTypes.js';
import {
    ExecutionHistoryPreparation,
    ExecutionHistoryPreparationStatus,
    ExecutionHistoryPreparationBlock,
    ExecutionHistoryPreparationError,
    type ExecutionHistoryPreparationReport,
    type ExecutionHistoryPreparationLane,
} from '../src/execution/ExecutionHistoryPreparation.js';
import {
    OriginalJournalFixtureCodec,
    type OriginalJournalFixtureSnapshot,
} from './support/OriginalJournalFixtureCodec.js';
import { ConnectorJournalStore } from '../src/runtime/ConnectorJournalStore.js';
import { ExecutionJournalCodec } from '../src/execution/ExecutionJournalCodec.js';
import { RuntimeMigrationApprovalFixture } from './support/RuntimeMigrationApprovalFixture.js';
import type { ConnectorMigrationApproval } from 'nerva-connector-protocol/protocol/ConnectorAdmissionMigration.js';
import { ConnectorHistoryMigration } from '../src/runtime/ConnectorHistoryMigration.js';

type HistoryLaneSummary = readonly [ExecutionHistoryPreparationStatus, bigint, boolean];

it('only two idle lanes are ready and preparation never initializes or rewrites their existing history', async (): Promise<void> => {
    await using fixture: ExecutionHistoryFixture = await ExecutionHistoryFixture.create();
    await rm(fixture.policy);
    const first: Buffer = await fixture.bytes(ExecutionLane.First);
    const second: Buffer = await fixture.bytes(ExecutionLane.Second);
    const initialize: MockInstance<typeof ConnectorOperationJournal.initialize> = vi.spyOn(
        ConnectorOperationJournal,
        'initialize',
    );
    try {
        const report: ExecutionHistoryPreparationReport = await ExecutionHistoryPreparation.prepare(
            fixture.identity,
            new AbortController().signal,
        );
        expect(report.ready).toBe(true);
        expect(report.lanes).toHaveLength(2);
        expect(
            report.lanes.every(
                (lane: ExecutionHistoryPreparationLane): boolean =>
                    lane.status === ExecutionHistoryPreparationStatus.Idle &&
                    !lane.remoteAcknowledgmentPending &&
                    lane.acknowledgedSequence === 0n,
            ),
        ).toBe(true);
        expect(initialize).not.toHaveBeenCalled();
        expect((await fixture.bytes(ExecutionLane.First)).equals(first)).toBe(true);
        expect((await fixture.bytes(ExecutionLane.Second)).equals(second)).toBe(true);
        expect(
            await ExecutionHistoryPreparation.prepare(
                fixture.authority.identity,
                new AbortController().signal,
            ),
        ).toEqual({ configured: false, ready: true, lanes: [] });
    } finally {
        initialize.mockRestore();
    }
});

it('idle and terminal preparation preserves exact counters, immutable output and journal ciphertext without requiring any original policy or runtime', async (): Promise<void> => {
    await using fixture: ExecutionHistoryFixture = await ExecutionHistoryFixture.create();
    const acknowledged: bigint = 9007199254740993n;
    const terminal: ExecutionResult = {
        ...ExecutionResultCodec.interrupted(ExecutionFailure.Interrupted),
        stdoutBase64: Buffer.from('PRIVATE_OUTPUT_CANARY').toString('base64'),
    };
    for (const lane of Object.values(ExecutionLane)) {
        const dispatch: ConnectorOperationDispatch<ExecutionRequest> = fixture.dispatch(
            lane,
            fixture.digest,
            acknowledged + 1n,
        );
        await fixture.snapshot(lane, {
            schema: ConnectorJournalSchema.AuthorizedEffectContext,
            journalId: (lane === ExecutionLane.First ? 'c' : 'd').repeat(64),
            acknowledgedSequence: acknowledged,
            receipt: {
                jobId: 'previous',
                sequence: acknowledged,
                dispatchId: Buffer.alloc(32, 2).toString('base64url'),
                requestHash: 'e'.repeat(64),
                admissionHash: ConnectorAuthorizationProof.execution('e'.repeat(64), lane, {
                    kind: ConnectorAuthorizationKind.Independent,
                }),
                responseHash: 'f'.repeat(64),
            },
            pending:
                lane === ExecutionLane.First
                    ? null
                    : {
                          ...dispatch,
                          effectContext: { kind: ConnectorEffectKind.IndependentExecution },
                          response: terminal,
                          progress: null,
                      },
        });
    }
    await rm(fixture.policy);
    const first: Buffer = await fixture.bytes(ExecutionLane.First);
    const second: Buffer = await fixture.bytes(ExecutionLane.Second);
    const recover: MockInstance<typeof ExecutionCgroup.recover> = vi.spyOn(
        ExecutionCgroup,
        'recover',
    );
    try {
        const report: ExecutionHistoryPreparationReport = await ExecutionHistoryPreparation.prepare(
            fixture.identity,
            new AbortController().signal,
        );
        expect(report.ready).toBe(false);
        expect(
            report.lanes.map((lane: ExecutionHistoryPreparationLane): HistoryLaneSummary => [
                lane.status,
                lane.acknowledgedSequence,
                lane.remoteAcknowledgmentPending,
            ]),
        ).toEqual([
            [ExecutionHistoryPreparationStatus.Idle, acknowledged, false],
            [ExecutionHistoryPreparationStatus.AwaitingAcknowledgment, acknowledged, true],
        ]);
        const text: string = JSON.stringify(report, (_key: string, value: unknown): unknown =>
            typeof value === 'bigint' ? value.toString() : value,
        );
        for (const canary of [
            'PRIVATE_ARGUMENT_CANARY',
            'PRIVATE_OUTPUT_CANARY',
            terminal.stdoutBase64,
            fixture.directory,
        ]) {
            expect(text.includes(canary)).toBe(false);
        }
        expect(recover).not.toHaveBeenCalled();
        expect((await fixture.bytes(ExecutionLane.First)).equals(first)).toBe(true);
        expect((await fixture.bytes(ExecutionLane.Second)).equals(second)).toBe(true);
    } finally {
        recover.mockRestore();
    }
});

it('live execution and second-lane owners fail closed, release earlier locks and never recreate missing history', async (): Promise<void> => {
    await using fixture: ExecutionHistoryFixture = await ExecutionHistoryFixture.create();
    const first: Buffer = await fixture.bytes(ExecutionLane.First);
    const second: Buffer = await fixture.bytes(ExecutionLane.Second);
    {
        await using owner: ConnectorPrivateDirectory = await ConnectorPrivateDirectory.open(
            fixture.state,
            ConnectorDirectoryPurpose.Execution,
        );
        expect(owner.directory).toBe(fixture.state);
        await expect(
            ExecutionHistoryPreparation.prepare(fixture.identity, new AbortController().signal),
        ).rejects.toBeInstanceOf(ExecutionHistoryPreparationError);
    }
    {
        await using owner: ConnectorOperationJournal<
            ExecutionRequest,
            ExecutionResult,
            ExecutionOutput
        > = await fixture.load(ExecutionLane.Second);
        expect(owner.pending).toBe(null);
        await expect(
            ExecutionHistoryPreparation.prepare(fixture.identity, new AbortController().signal),
        ).rejects.toBeInstanceOf(ExecutionHistoryPreparationError);
        await using firstOwner: ConnectorOperationJournal<
            ExecutionRequest,
            ExecutionResult,
            ExecutionOutput
        > = await fixture.load(ExecutionLane.First);
        expect(firstOwner.pending).toBe(null);
    }
    expect((await fixture.bytes(ExecutionLane.First)).equals(first)).toBe(true);
    expect((await fixture.bytes(ExecutionLane.Second)).equals(second)).toBe(true);
    await rm(join(fixture.state, ExecutionLane.Second, 'execution-journal'));
    await expect(
        ExecutionHistoryPreparation.prepare(fixture.identity, new AbortController().signal),
    ).rejects.toBeInstanceOf(ExecutionHistoryPreparationError);
    expect((await fixture.bytes(ExecutionLane.First)).equals(first)).toBe(true);
    await expect(fixture.bytes(ExecutionLane.Second)).rejects.toThrow();
});

it.each([
    ConnectorEffectKind.IndependentExecution,
    ConnectorEffectKind.HistoricalUnproven,
] as const)(
    '%s Started history stays blocked and byte exact without pathname cleanup or obsolete policy reads',
    async (
        kind: ConnectorEffectKind.IndependentExecution | ConnectorEffectKind.HistoricalUnproven,
    ): Promise<void> => {
        await using fixture: ExecutionHistoryFixture = await ExecutionHistoryFixture.create();
        for (const lane of Object.values(ExecutionLane)) {
            const dispatch: ConnectorOperationDispatch<ExecutionRequest> = fixture.dispatch(
                lane,
                lane === ExecutionLane.First ? fixture.digest : 'f'.repeat(64),
            );
            if (kind === ConnectorEffectKind.IndependentExecution) {
                const journal: ConnectorOperationJournal<
                    ExecutionRequest,
                    ExecutionResult,
                    ExecutionOutput
                > = await fixture.load(lane);
                const id: string = journal.id;
                await journal[Symbol.asyncDispose]();
                await fixture.snapshot(lane, {
                    schema: ConnectorJournalSchema.AuthorizedEffectContext,
                    journalId: id,
                    acknowledgedSequence: 0n,
                    receipt: null,
                    pending: {
                        ...dispatch,
                        effectContext: { kind },
                        response: null,
                        progress: { stdoutBase64: 'AP8=', stderrBase64: 'AQ==' },
                    },
                });
            } else {
                const codec: ExecutionJournalCodec = new ExecutionJournalCodec(lane);
                await using store: ConnectorJournalStore<
                    OriginalJournalFixtureSnapshot<
                        ExecutionRequest,
                        ExecutionResult,
                        ExecutionOutput
                    >
                > = await ConnectorJournalStore.open(
                    join(fixture.state, lane),
                    fixture.identity.settings.enrollmentId,
                    fixture.identity.key,
                    codec.purpose,
                    new OriginalJournalFixtureCodec(codec),
                );
                const idle: OriginalJournalFixtureSnapshot<
                    ExecutionRequest,
                    ExecutionResult,
                    ExecutionOutput
                > = await store.read();
                await store.write(
                    {
                        ...idle,
                        pending: {
                            jobId: dispatch.jobId,
                            sequence: dispatch.sequence,
                            dispatchId: dispatch.dispatchId,
                            requestHash: dispatch.requestHash,
                            request: dispatch.request,
                            response: null,
                            progress: { stdoutBase64: 'AP8=', stderrBase64: 'AQ==' },
                        },
                    },
                    false,
                );
            }
        }
        if (kind === ConnectorEffectKind.HistoricalUnproven) {
            const approval: ConnectorMigrationApproval =
                await RuntimeMigrationApprovalFixture.prepare(
                    fixture.identity,
                    fixture.authority.authority,
                );
            await ConnectorHistoryMigration.run(
                fixture.identity.configurationFile,
                new AbortController().signal,
                approval,
            );
        }
        await rm(fixture.policy);
        const before: readonly Buffer[] = await Promise.all(
            Object.values(ExecutionLane).map((lane: ExecutionLane): Promise<Buffer> =>
                fixture.bytes(lane),
            ),
        );
        using recover: MockInstance<typeof ExecutionCgroup.recover> = vi.spyOn(
            ExecutionCgroup,
            'recover',
        );
        const report: ExecutionHistoryPreparationReport = await ExecutionHistoryPreparation.prepare(
            fixture.identity,
            new AbortController().signal,
        );
        expect(report.ready).toBe(false);
        expect(
            report.lanes.every(
                (lane: ExecutionHistoryPreparationLane): boolean =>
                    lane.status === ExecutionHistoryPreparationStatus.Blocked &&
                    lane.blocked === ExecutionHistoryPreparationBlock.CleanupUnproven &&
                    !lane.remoteAcknowledgmentPending,
            ),
        ).toBe(true);
        expect(recover).not.toHaveBeenCalled();
        let index: number = 0;
        for (const lane of Object.values(ExecutionLane)) {
            const bytes: Buffer | undefined = before[index++];
            if (bytes === undefined) {
                throw new Error('Original journal bytes required');
            }
            expect((await fixture.bytes(lane)).equals(bytes)).toBe(true);
            await using journal: ConnectorOperationJournal<
                ExecutionRequest,
                ExecutionResult,
                ExecutionOutput
            > = await fixture.load(lane);
            expect(journal.pending?.effectContext.kind).toBe(kind);
            expect(journal.pending?.progress).toEqual({
                stdoutBase64: 'AP8=',
                stderrBase64: 'AQ==',
            });
            expect(journal.pending?.response).toBe(null);
        }
    },
);

it('a fresh NotStarted original seals Interrupted without cgroup access or a current policy, while unproven other-lane output remains intact', async (): Promise<void> => {
    await using fixture: ExecutionHistoryFixture = await ExecutionHistoryFixture.create();
    const first: ConnectorOperationDispatch<ExecutionRequest> = fixture.dispatch(
        ExecutionLane.First,
    );
    {
        await using journal: ConnectorOperationJournal<
            ExecutionRequest,
            ExecutionResult,
            ExecutionOutput
        > = await fixture.load(ExecutionLane.First);
        await journal.begin(first, { kind: ConnectorEffectKind.ExecutionNotStarted });
    }
    const second: ConnectorOperationDispatch<ExecutionRequest> = fixture.dispatch(
        ExecutionLane.Second,
    );
    const other: ConnectorOperationJournal<ExecutionRequest, ExecutionResult, ExecutionOutput> =
        await fixture.load(ExecutionLane.Second);
    const id: string = other.id;
    await other[Symbol.asyncDispose]();
    await fixture.snapshot(ExecutionLane.Second, {
        schema: ConnectorJournalSchema.AuthorizedEffectContext,
        journalId: id,
        acknowledgedSequence: 0n,
        receipt: null,
        pending: {
            ...second,
            effectContext: { kind: ConnectorEffectKind.IndependentExecution },
            progress: { stdoutBase64: 'AP8=', stderrBase64: 'AQ==' },
            response: null,
        },
    });
    await rm(fixture.policy);
    const before: Buffer = await fixture.bytes(ExecutionLane.Second);
    using recover: MockInstance<typeof ExecutionCgroup.recover> = vi.spyOn(
        ExecutionCgroup,
        'recover',
    );
    const report: ExecutionHistoryPreparationReport = await ExecutionHistoryPreparation.prepare(
        fixture.identity,
        new AbortController().signal,
    );
    expect(report.lanes[0]?.status).toBe(
        ExecutionHistoryPreparationStatus.InterruptedAwaitingAcknowledgment,
    );
    expect(report.lanes[1]?.blocked).toBe(ExecutionHistoryPreparationBlock.CleanupUnproven);
    expect(report.ready).toBe(false);
    expect(recover).not.toHaveBeenCalled();
    expect((await fixture.bytes(ExecutionLane.Second)).equals(before)).toBe(true);
    await using journal: ConnectorOperationJournal<
        ExecutionRequest,
        ExecutionResult,
        ExecutionOutput
    > = await fixture.load(ExecutionLane.First);
    expect(journal.pending).toEqual({
        ...first,
        effectContext: { kind: ConnectorEffectKind.ExecutionNotStarted },
        progress: null,
        response: ExecutionResultCodec.interrupted(ExecutionFailure.Interrupted),
    });
});

it.each([false, true])(
    'NotStarted terminal durability failure (published=%s) retains original metadata without any cleanup claim',
    async (published: boolean): Promise<void> => {
        await using fixture: ExecutionHistoryFixture = await ExecutionHistoryFixture.create();
        const dispatch: ConnectorOperationDispatch<ExecutionRequest> = fixture.dispatch(
            ExecutionLane.First,
        );
        {
            await using journal: ConnectorOperationJournal<
                ExecutionRequest,
                ExecutionResult,
                ExecutionOutput
            > = await fixture.load(ExecutionLane.First);
            await journal.begin(dispatch, { kind: ConnectorEffectKind.ExecutionNotStarted });
        }
        using recover: MockInstance<typeof ExecutionCgroup.recover> = vi.spyOn(
            ExecutionCgroup,
            'recover',
        );
        using write: MockInstance<typeof ConnectorPrivateDirectory.prototype.write> = vi.spyOn(
            ConnectorPrivateDirectory.prototype,
            'write',
        );
        write.mockImplementationOnce(async function (
            this: ConnectorPrivateDirectory,
            ...args: Parameters<typeof ConnectorPrivateDirectory.prototype.write>
        ): Promise<void> {
            write.mockRestore();
            if (published) {
                await this.write(...args);
            }
            throw new Error('Controlled lost result observation');
        });
        const report: ExecutionHistoryPreparationReport = await ExecutionHistoryPreparation.prepare(
            fixture.identity,
            new AbortController().signal,
        );
        expect(report.ready).toBe(false);
        expect(report.lanes[0]?.blocked).toBe(
            ExecutionHistoryPreparationBlock.DurabilityUnconfirmed,
        );
        expect(recover).not.toHaveBeenCalled();
        await using journal: ConnectorOperationJournal<
            ExecutionRequest,
            ExecutionResult,
            ExecutionOutput
        > = await fixture.load(ExecutionLane.First);
        expect(journal.pending?.requestHash).toBe(dispatch.requestHash);
        expect(journal.pending?.effectContext).toEqual({
            kind: ConnectorEffectKind.ExecutionNotStarted,
        });
        expect(journal.pending?.response?.failure ?? null).toBe(
            published ? ExecutionFailure.Interrupted : null,
        );
        expect(journal.pending?.response?.termination ?? null).toBe(
            published ? ExecutionTermination.Indeterminate : null,
        );
    },
);
