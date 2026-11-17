// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

import type { ConnectorJournalRecord } from '../runtime/ConnectorJournalRecord.js';
import type { ConnectorClientSession } from '../runtime/ConnectorClientSession.js';
import type {
    ExecutionPermit,
    ExecutionCancellation,
    ExecutionCompletion,
    ExecutionAcknowledgment,
} from './ExecutionJobs.js';
import { ExecutionInteractiveFields } from 'nerva-connector-protocol/execution/ExecutionInteractiveFields.js';
import { ExecutionInputJournalLifecycle } from './ExecutionInputJournalLifecycle.js';
import { ExecutionInputJournalTerminalProof } from './ExecutionInputJournalTerminalProof.js';
import { ExecutionInputIndeterminate } from './ExecutionInputIndeterminate.js';
import type { ExecutionInputReceipt } from 'nerva-connector-protocol/execution/ExecutionInput.js';
import {
    ExecutionInputJournalPhase,
    type ExecutionInputJournalRecordState,
    type ExecutionInputJournalPreparation,
    type ExecutionInputJournalPreparedState,
    type ExecutionInputJournalAdmission,
    type ExecutionInputJournalState,
    type ExecutionInputJournalRetainedControl,
} from './ExecutionInputJournalTypes.js';
import type { ExecutionInputJournalStorage } from './ExecutionInputJournalStorage.js';

/** Prepared/Ready ownership transitions share one storage mutex and never own a native handle or transport. */
export class ExecutionInputJournalPhases {
    public constructor(public readonly storage: ExecutionInputJournalStorage) {}

    /** Fresh main admission is required before preparing a new monotonic original. */
    public async prepare(
        input: ExecutionInputJournalPreparation,
        session: ConnectorClientSession,
        nowMs: bigint,
    ): Promise<ExecutionInputJournalPreparedState> {
        return await this.storage.run(async (): Promise<ExecutionInputJournalPreparedState> => {
            const previous: ConnectorJournalRecord<ExecutionInputJournalRecordState> | null =
                await this.storage.existing();
            const state: ExecutionInputJournalPreparedState = new ExecutionInputJournalLifecycle(
                this.storage.codec,
            ).prepare(previous?.state ?? null, input, session, nowMs);
            this.storage.adopt(previous);
            const saved: ExecutionInputJournalRecordState = await this.storage.publish(state);
            if (saved.phase !== ExecutionInputJournalPhase.Prepared) {
                throw new Error('Prepared publication changed its phase');
            }
            return saved;
        });
    }
    /** Actual native Ready confirms its exact original preparation without renewing start authority. */
    public async confirm(
        admission: ExecutionInputJournalAdmission,
    ): Promise<ExecutionInputJournalState> {
        return await this.storage.run(async (): Promise<ExecutionInputJournalState> => {
            if (!this.storage.loaded) {
                throw new Error('Ready requires this process original preparation owner');
            }
            return await this.storage.publishReady(
                new ExecutionInputJournalLifecycle(this.storage.codec).ready(
                    this.storage.state(),
                    admission,
                ),
            );
        });
    }
    /** Explicit expected first evidence can restore only an already existing Ready record. */
    public async restore(
        expected: ExecutionInputJournalAdmission,
    ): Promise<ExecutionInputJournalState> {
        return await this.storage.run(async (): Promise<ExecutionInputJournalState> => {
            if (this.storage.loaded) {
                throw new Error('Interactive cursor already loaded');
            }
            const admission: ExecutionInputJournalAdmission =
                this.storage.codec.validation.admission(expected);
            const record: ConnectorJournalRecord<ExecutionInputJournalRecordState> =
                await this.storage.read();
            if (
                record.state.phase !== ExecutionInputJournalPhase.Ready ||
                this.storage.codec.validation.json(admission) !==
                    this.storage.codec.validation.json(record.state.admission)
            ) {
                throw new Error('Restored interactive original or grant changed');
            }
            this.storage.adopt(record);
            return await this.#lost(record.state);
        });
    }
    /** The owning main journal has already authenticated this exact terminal original; this cannot create native authority. */
    public async restoreCaptured(
        expected: ExecutionInputJournalRecordState,
    ): Promise<ExecutionInputJournalRecordState> {
        return await this.storage.run(async (): Promise<ExecutionInputJournalRecordState> => {
            if (this.storage.loaded) {
                throw new Error('Interactive input record already loaded');
            }
            const record: ConnectorJournalRecord<ExecutionInputJournalRecordState> =
                await this.storage.read();
            if (this.storage.codec.encode(expected) !== this.storage.codec.encode(record.state)) {
                throw new Error('Captured terminal input source changed');
            }
            this.storage.adopt(record);
            if (record.state.phase === ExecutionInputJournalPhase.Ready) {
                return await this.#lost(record.state);
            }
            if (record.state.terminal !== null || record.state.ownerLost) {
                return record.state;
            }
            return await this.storage.publish({ ...record.state, ownerLost: true });
        });
    }
    /** Main exact original/incarnation authenticate recovery before any restored lower-bound receipt is signed. */
    public async recover(
        original: ExecutionPermit | ExecutionCancellation,
        session: ConnectorClientSession,
        nowMs: bigint,
        expectedIncarnation: string,
    ): Promise<ExecutionInputJournalRecordState> {
        return await this.storage.run(async (): Promise<ExecutionInputJournalRecordState> => {
            if (this.storage.loaded) {
                throw new Error('Interactive input record already loaded');
            }
            const record: ConnectorJournalRecord<ExecutionInputJournalRecordState> =
                await this.storage.read();
            const incarnation: string =
                record.state.phase === ExecutionInputJournalPhase.Ready
                    ? record.state.admission.ready.incarnation
                    : record.state.preparation.incarnation;
            if (incarnation !== ExecutionInteractiveFields.digest(expectedIncarnation)) {
                throw new Error('Recovered input changed its captured main incarnation');
            }
            new ExecutionInputJournalLifecycle(this.storage.codec).original(
                record.state,
                original,
                session,
                nowMs,
            );
            this.storage.adopt(record);
            if (record.state.phase === ExecutionInputJournalPhase.Ready) {
                return await this.#lost(record.state);
            }
            if (record.state.terminal !== null || record.state.ownerLost) {
                return record.state;
            }
            return await this.storage.publish({ ...record.state, ownerLost: true });
        });
    }
    /** Prepared uncertainty still requires actual completion and backend acknowledgment before fixed-file reuse. */
    public async retire(
        completion: ExecutionCompletion,
        acknowledgment: ExecutionAcknowledgment,
        session: ConnectorClientSession,
        nowMs: bigint,
    ): Promise<ExecutionInputJournalPreparedState> {
        return await this.storage.run(async (): Promise<ExecutionInputJournalPreparedState> => {
            const state: ExecutionInputJournalRecordState = this.storage.state();
            if (state.phase !== ExecutionInputJournalPhase.Prepared) {
                throw new Error('Prepared retirement cannot replace a Ready cursor');
            }
            this.storage.codec.validation.lease(session, acknowledgment.leaseId, nowMs);
            const terminal: NonNullable<ExecutionInputJournalPreparedState['terminal']> =
                ExecutionInputJournalTerminalProof.verify(
                    this.storage.codec.validation,
                    state,
                    completion,
                    acknowledgment,
                );
            if (state.terminal !== null) {
                if (state.terminal.responseHash !== terminal.responseHash) {
                    throw new Error('First terminal outcome cannot be replaced');
                }
                return state;
            }
            const saved: ExecutionInputJournalRecordState = await this.storage.publish({
                ...state,
                terminal,
            });
            if (saved.phase !== ExecutionInputJournalPhase.Prepared) {
                throw new Error('Prepared retirement changed its phase');
            }
            return saved;
        });
    }
    async #lost(state: ExecutionInputJournalState): Promise<ExecutionInputJournalState> {
        if (state.terminal !== null) {
            return state;
        }
        let pending: ExecutionInputJournalRetainedControl | null = state.pending;
        if (pending !== null && pending.receipt === null) {
            const receipt: ExecutionInputReceipt = ExecutionInputIndeterminate.sign(
                pending,
                this.storage.codec.validation.identity.key,
            );
            pending = { ...pending, receipt };
        }
        return await this.storage.publishReady({
            ...state,
            ownerLost: true,
            inputStopped: true,
            pending,
            cursor: pending?.receipt?.cursor ?? state.cursor,
        });
    }
}
