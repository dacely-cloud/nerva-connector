// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

import { join } from 'node:path';
import type { ConnectorClientIdentity } from '../runtime/ConnectorClientConfiguration.js';
import {
    ConnectorPrivateDirectory,
    ConnectorDirectoryPurpose,
} from '../runtime/ConnectorPrivateDirectory.js';
import { ConnectorOperationJournal } from '../runtime/ConnectorOperationJournal.js';
import type { ConnectorJournalPending } from '../runtime/ConnectorJournalState.js';
import { type ExecutionRequest } from 'nerva-connector-protocol/execution/ExecutionJobs.js';
import { ExecutionLane } from 'nerva-connector-protocol/execution/ExecutionLane.js';
import { ExecutionJournalCodec } from './ExecutionJournalCodec.js';
import type { ExecutionOutput } from 'nerva-connector-protocol/execution/ExecutionOutput.js';
import {
    ExecutionFailure,
    type ExecutionResult,
} from 'nerva-connector-protocol/execution/ExecutionTypes.js';
import { ConnectorEffectKind } from '../runtime/ConnectorEffectContext.js';
import { ExecutionCgroup } from './ExecutionCgroup.js';
import { ExecutionProof } from 'nerva-connector-protocol/execution/ExecutionProof.js';
import { ExecutionResultCodec } from './ExecutionResultCodec.js';

/** Saved terminal results still require their original remote acknowledgment before policy activation. */
export enum ExecutionHistoryPreparationStatus {
    Idle = 'idle',
    AwaitingAcknowledgment = 'awaiting-acknowledgment',
    InterruptedAwaitingAcknowledgment = 'interrupted-awaiting-acknowledgment',
    Blocked = 'blocked',
}

/** Fixed local classifications never contain host paths, command arguments or retained output. */
export enum ExecutionHistoryPreparationBlock {
    CleanupUnproven = 'cleanup-unproven',
    DurabilityUnconfirmed = 'durability-unconfirmed',
}

/** Only exact non-content metadata is returned to the operator. */
export interface ExecutionHistoryPreparationLane {
    readonly lane: ExecutionLane;
    readonly journalId: string;
    readonly acknowledgedSequence: bigint;
    readonly pendingJobId: string | null;
    readonly pendingSequence: bigint | null;
    readonly status: ExecutionHistoryPreparationStatus;
    readonly blocked: ExecutionHistoryPreparationBlock | null;
    readonly remoteAcknowledgmentPending: boolean;
}

/** Ready means every configured lane is idle; sealing interrupted work cannot acknowledge it. */
export interface ExecutionHistoryPreparationReport {
    readonly configured: boolean;
    readonly ready: boolean;
    readonly lanes: readonly ExecutionHistoryPreparationLane[];
}

/** Missing history or a live owner cannot become new empty state during policy preparation. */
export class ExecutionHistoryPreparationError extends Error {
    /** The caller may show this fixed message without exposing underlying filesystem errors. */
    public constructor() {
        super('Command history is unavailable or already owned; existing history was kept');
        this.name = 'ExecutionHistoryPreparationError';
    }
}

/** The preparation owner retains both lane locks until all exact cleanup and durability writes join. */
interface ExecutionHistoryOwner {
    readonly lane: ExecutionLane;
    readonly journal: ConnectorOperationJournal<ExecutionRequest, ExecutionResult, ExecutionOutput>;
}

/** This local consumer never initializes journals, opens executable policies or invokes any program. */
export class ExecutionHistoryPreparation {
    /** The outer stopped-runtime command owns installation/runtime locks; this method owns execution and both original lanes. */
    public static async prepare(
        identity: ConnectorClientIdentity,
        signal: AbortSignal,
    ): Promise<ExecutionHistoryPreparationReport> {
        signal.throwIfAborted();
        if (identity.settings.execution === null) {
            return { configured: false, ready: true, lanes: [] };
        }
        if (identity.settings.slot !== 0 || process.platform !== 'linux') {
            throw new ExecutionHistoryPreparationError();
        }
        const owners: ExecutionHistoryOwner[] = [];
        await using resources: AsyncDisposableStack = new AsyncDisposableStack();
        try {
            resources.use(
                await ConnectorPrivateDirectory.open(
                    identity.settings.execution.stateDirectory,
                    ConnectorDirectoryPurpose.Execution,
                ),
            );
            for (const lane of Object.values(ExecutionLane)) {
                signal.throwIfAborted();
                const journal: ConnectorOperationJournal<
                    ExecutionRequest,
                    ExecutionResult,
                    ExecutionOutput
                > = resources.use(
                    await ConnectorOperationJournal.load(
                        join(identity.settings.execution.stateDirectory, lane),
                        identity.settings.enrollmentId,
                        identity.key,
                        new ExecutionJournalCodec(lane),
                    ),
                );
                owners.push({ lane, journal });
            }
        } catch {
            signal.throwIfAborted();
            throw new ExecutionHistoryPreparationError();
        }
        signal.throwIfAborted();
        const lanes: ExecutionHistoryPreparationLane[] = [];
        for (const owner of owners) {
            signal.throwIfAborted();
            const pending: ConnectorJournalPending<
                ExecutionRequest,
                ExecutionResult,
                ExecutionOutput
            > | null = owner.journal.pending;
            if (pending?.effectContext.kind === ConnectorEffectKind.CapturedInteractiveExecution) {
                lanes.push(
                    this.#view(
                        owner,
                        ExecutionHistoryPreparationStatus.Blocked,
                        ExecutionHistoryPreparationBlock.CleanupUnproven,
                    ),
                );
                continue;
            }
            if (pending === null || pending.response !== null) {
                lanes.push(this.#view(owner));
                continue;
            }
            try {
                if (pending.effectContext.kind === ConnectorEffectKind.CapturedExecution) {
                    await ExecutionCgroup.recover(
                        pending.effectContext,
                        ExecutionProof.cgroupId(owner.journal.id, {
                            ...pending,
                            lane: owner.lane,
                            enrollmentId: identity.settings.enrollmentId,
                        }),
                    );
                } else if (pending.effectContext.kind !== ConnectorEffectKind.ExecutionNotStarted) {
                    throw new Error('Original physical command authority is unproven');
                }
            } catch {
                lanes.push(
                    this.#view(
                        owner,
                        ExecutionHistoryPreparationStatus.Blocked,
                        ExecutionHistoryPreparationBlock.CleanupUnproven,
                    ),
                );
                continue;
            }
            signal.throwIfAborted();
            try {
                await owner.journal.finish(pending, {
                    ...ExecutionResultCodec.interrupted(ExecutionFailure.Interrupted),
                    ...pending.progress,
                });
                lanes.push(
                    this.#view(
                        owner,
                        ExecutionHistoryPreparationStatus.InterruptedAwaitingAcknowledgment,
                    ),
                );
            } catch {
                lanes.push(
                    this.#view(
                        owner,
                        ExecutionHistoryPreparationStatus.Blocked,
                        ExecutionHistoryPreparationBlock.DurabilityUnconfirmed,
                    ),
                );
            }
        }
        signal.throwIfAborted();
        return {
            configured: true,
            ready: lanes.every(
                (lane: ExecutionHistoryPreparationLane): boolean =>
                    lane.status === ExecutionHistoryPreparationStatus.Idle,
            ),
            lanes,
        };
    }

    static #view(
        owner: ExecutionHistoryOwner,
        status?: ExecutionHistoryPreparationStatus,
        blocked: ExecutionHistoryPreparationBlock | null = null,
    ): ExecutionHistoryPreparationLane {
        const pending: ConnectorJournalPending<
            ExecutionRequest,
            ExecutionResult,
            ExecutionOutput
        > | null = owner.journal.pending;
        return {
            lane: owner.lane,
            journalId: owner.journal.id,
            acknowledgedSequence: owner.journal.acknowledgedSequence,
            pendingJobId: pending?.jobId ?? null,
            pendingSequence: pending?.sequence ?? null,
            status:
                status ??
                (pending === null
                    ? ExecutionHistoryPreparationStatus.Idle
                    : ExecutionHistoryPreparationStatus.AwaitingAcknowledgment),
            blocked,
            remoteAcknowledgmentPending: pending !== null && pending.response !== null,
        };
    }
}
