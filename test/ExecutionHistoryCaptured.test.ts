// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

import { createHash } from 'node:crypto';
import { readFile, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, it, vi, type MockInstance } from 'vitest';
import {
    ExecutionHistoryCapturedFixture,
    CapturedHistoryGroup,
} from './support/ExecutionHistoryCapturedFixture.js';
import { ConnectorOperationJournal } from '../src/runtime/ConnectorOperationJournal.js';
import type { ConnectorOperationDispatch } from '../src/runtime/ConnectorOperationCodec.js';
import { ConnectorEffectContextCodec } from '../src/runtime/ConnectorEffectContextCodec.js';
import {
    ConnectorEffectKind,
    type ConnectorCapturedExecutionEffect,
} from '../src/runtime/ConnectorEffectContext.js';
import {
    ConnectorPrivateDirectory,
    ConnectorDirectoryPurpose,
} from '../src/runtime/ConnectorPrivateDirectory.js';
import { type ExecutionRequest } from '../src/execution/ExecutionJobs.js';
import { ExecutionLane } from 'nerva-connector-protocol/execution/ExecutionLane.js';
import type { ExecutionResult } from '../src/execution/ExecutionTypes.js';
import { ExecutionFailure } from '../src/execution/ExecutionTypes.js';
import type { ExecutionOutput } from '../src/execution/ExecutionOutput.js';
import { ExecutionProof } from '../src/execution/ExecutionProof.js';
import { ExecutionCgroup } from '../src/execution/ExecutionCgroup.js';
import { ExecutionPolicy } from '../src/execution/ExecutionPolicy.js';
import {
    ExecutionHistoryPreparation,
    ExecutionHistoryPreparationStatus,
    type ExecutionHistoryPreparationReport,
} from '../src/execution/ExecutionHistoryPreparation.js';

const native: boolean =
    process.platform === 'linux' &&
    process.getuid?.() === 0 &&
    process.env['NERVA_CONNECTOR_EXEC_HELPER'] !== undefined;

it.skipIf(!native).each([false, true])(
    'actual captured parent/group cleanup joins the original only and preserves observed binary output; canceled=%s',
    async (canceled: boolean): Promise<void> => {
        await using fixture: ExecutionHistoryCapturedFixture =
            await ExecutionHistoryCapturedFixture.create();
        const policyHash: string = createHash('sha256')
            .update(await readFile(fixture.history.policy))
            .digest('hex');
        const dispatch: ConnectorOperationDispatch<ExecutionRequest> = fixture.history.dispatch(
            ExecutionLane.First,
            policyHash,
        );
        const context: ConnectorCapturedExecutionEffect = fixture.context(policyHash);
        let journalId: string;
        let captured: ConnectorCapturedExecutionEffect;
        let original: CapturedHistoryGroup;
        {
            await using journal: ConnectorOperationJournal<
                ExecutionRequest,
                ExecutionResult,
                ExecutionOutput
            > = await fixture.history.load(ExecutionLane.First);
            journalId = journal.id;
            await journal.begin(dispatch, context);
            const id: string = ExecutionProof.cgroupId(journalId, {
                ...dispatch,
                lane: ExecutionLane.First,
                enrollmentId: fixture.history.identity.settings.enrollmentId,
            });
            original = await fixture.group(id);
            captured = await journal.bindExecutionGroup(dispatch, original.identity);
            await original.start(join(fixture.history.directory, 'original-effect'));
            await journal.retain(dispatch, original.output);
        }
        const canary: CapturedHistoryGroup = await fixture.group('f'.repeat(64));
        await canary.start(join(fixture.history.directory, 'unrelated-effect'));
        await rename(
            join(fixture.history.directory, 'actual-workspace'),
            join(fixture.history.directory, 'retained-workspace'),
        );
        await rm(fixture.history.policy);
        using loadPolicy: MockInstance<typeof ExecutionPolicy.load> = vi.spyOn(
            ExecutionPolicy,
            'load',
        );
        const before: Buffer = await fixture.history.bytes(ExecutionLane.First);
        if (canceled) {
            const actualRecover: typeof ExecutionCgroup.recover =
                ExecutionCgroup.recover.bind(ExecutionCgroup);
            const entered: PromiseWithResolvers<undefined> = Promise.withResolvers<undefined>();
            const release: PromiseWithResolvers<undefined> = Promise.withResolvers<undefined>();
            using recover: MockInstance<typeof ExecutionCgroup.recover> = vi
                .spyOn(ExecutionCgroup, 'recover')
                .mockImplementation(
                    async (effect: ConnectorCapturedExecutionEffect, id: string): Promise<void> => {
                        entered.resolve(undefined);
                        await release.promise;
                        await actualRecover(effect, id);
                    },
                );
            const stop: AbortController = new AbortController();
            const preparing: Promise<ExecutionHistoryPreparationReport> =
                ExecutionHistoryPreparation.prepare(fixture.history.identity, stop.signal);
            const joined: Promise<
                readonly PromiseSettledResult<ExecutionHistoryPreparationReport>[]
            > = Promise.allSettled([preparing]);
            try {
                await Promise.race([
                    entered.promise,
                    (async (): Promise<never> => {
                        await preparing;
                        throw new Error('Captured recovery was not entered');
                    })(),
                ]);
                stop.abort();
                await expect(
                    ConnectorPrivateDirectory.open(
                        fixture.history.state,
                        ConnectorDirectoryPurpose.Execution,
                    ),
                ).rejects.toThrow();
                release.resolve(undefined);
                await expect(preparing).rejects.toThrow();
                await original.wait();
                expect((await fixture.history.bytes(ExecutionLane.First)).equals(before)).toBe(
                    true,
                );
                expect(canary.alive).toBe(true);
                expect(recover).toHaveBeenCalledOnce();
            } finally {
                release.resolve(undefined);
                await joined;
            }
        }
        const report: ExecutionHistoryPreparationReport = await ExecutionHistoryPreparation.prepare(
            fixture.history.identity,
            new AbortController().signal,
        );
        expect(report.ready).toBe(false);
        expect(report.lanes[0]?.status).toBe(
            ExecutionHistoryPreparationStatus.InterruptedAwaitingAcknowledgment,
        );
        await original.wait();
        expect(original.alive).toBe(false);
        expect(canary.alive).toBe(true);
        expect(await readFile(join(fixture.history.directory, 'original-effect'), 'utf8')).toBe(
            'x',
        );
        expect(await readFile(join(fixture.history.directory, 'unrelated-effect'), 'utf8')).toBe(
            'x',
        );
        {
            await using journal: ConnectorOperationJournal<
                ExecutionRequest,
                ExecutionResult,
                ExecutionOutput
            > = await fixture.history.load(ExecutionLane.First);
            expect(journal.id).toBe(journalId);
            expect(journal.pending?.requestHash).toBe(dispatch.requestHash);
            expect(journal.pending?.sequence).toBe(dispatch.sequence);
            expect(journal.pending?.effectContext.kind).toBe(ConnectorEffectKind.CapturedExecution);
            const retained: typeof journal.pending = journal.pending;
            expect(
                retained !== null &&
                    ConnectorEffectContextCodec.encode(retained.effectContext) ===
                        ConnectorEffectContextCodec.encode(captured),
            ).toBe(true);
            expect(journal.pending?.response?.failure).toBe(ExecutionFailure.Interrupted);
            expect(journal.pending?.response?.stdoutBase64).toBe('AP8=');
            expect(journal.pending?.response?.stderrBase64).toBe('');
        }
        const terminal: Buffer = await fixture.history.bytes(ExecutionLane.First);
        using terminalRecovery: MockInstance<typeof ExecutionCgroup.recover> = vi.spyOn(
            ExecutionCgroup,
            'recover',
        );
        expect(
            (
                await ExecutionHistoryPreparation.prepare(
                    fixture.history.identity,
                    new AbortController().signal,
                )
            ).lanes[0]?.status,
        ).toBe(ExecutionHistoryPreparationStatus.AwaitingAcknowledgment);
        expect((await fixture.history.bytes(ExecutionLane.First)).equals(terminal)).toBe(true);
        expect(terminalRecovery).not.toHaveBeenCalled();
        expect(loadPolicy).not.toHaveBeenCalled();
        expect(canary.alive).toBe(true);
    },
);
