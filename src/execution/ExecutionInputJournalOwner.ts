// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

import { ConnectorClock } from '../protocol/ConnectorClock.js';
import type { ConnectorClientIdentity } from '../runtime/ConnectorClientConfiguration.js';
import type { ConnectorClientSession } from '../runtime/ConnectorClientSession.js';
import { ExecutionInputPermitCodec } from 'nerva-connector-protocol/execution/ExecutionInputPermitCodec.js';
import { ExecutionInputControlCodec } from 'nerva-connector-protocol/execution/ExecutionInputControlCodec.js';
import { ExecutionInputReceiptCodec } from 'nerva-connector-protocol/execution/ExecutionInputReceiptCodec.js';
import {
    ExecutionInputJournalAcknowledgments,
    ExecutionInputJournalAcknowledgmentTarget,
    type ExecutionInputJournalCapturedAcknowledgment,
} from './ExecutionInputJournalAcknowledgments.js';
import { ExecutionInputCorrelation } from 'nerva-connector-protocol/execution/ExecutionInputCorrelation.js';
import { ExecutionInteractiveProof as Proof } from 'nerva-connector-protocol/execution/ExecutionInteractiveProof.js';
import {
    ExecutionInputDisposition,
    type ExecutionInputPermit,
    type ExecutionInputReceipt,
    type ExecutionInputAcknowledgment,
    type ExecutionInputReceiptContext,
} from 'nerva-connector-protocol/execution/ExecutionInput.js';
import type {
    ExecutionPermit,
    ExecutionCancellation,
    ExecutionCompletion,
    ExecutionAcknowledgment,
} from 'nerva-connector-protocol/execution/ExecutionJobs.js';
import { ExecutionInputJournalTerminalProof } from './ExecutionInputJournalTerminalProof.js';
import { ExecutionInputJournalStore } from './ExecutionInputJournalStore.js';
import { ExecutionInputJournalStorage } from './ExecutionInputJournalStorage.js';
import { ExecutionInputJournalPhases } from './ExecutionInputJournalPhases.js';
import { ExecutionInputIndeterminate } from './ExecutionInputIndeterminate.js';
import { ExecutionInputJournalResolution } from './ExecutionInputJournalResolution.js';
import type { ExecutionInputTerminalResolution } from 'nerva-connector-protocol/execution/ExecutionInputTerminalResolution.js';
import {
    type ExecutionInputJournalScope,
    type ExecutionInputJournalAdmission,
    type ExecutionInputJournalState,
    type ExecutionInputJournalRecordState,
    type ExecutionInputJournalPreparation,
    type ExecutionInputJournalPreparedState,
    ExecutionInputJournalControlKind,
    type ExecutionInputJournalControl,
    type ExecutionInputJournalRetainedControl,
} from './ExecutionInputJournalTypes.js';

/** One lane owner durably captures before native input and never creates a replacement native process during recovery. */
export class ExecutionInputJournalOwner implements AsyncDisposable {
    readonly #storage: ExecutionInputJournalStorage;
    readonly #phases: ExecutionInputJournalPhases;
    private constructor(store: ExecutionInputJournalStore) {
        this.#storage = new ExecutionInputJournalStorage(store);
        this.#phases = new ExecutionInputJournalPhases(this.#storage);
    }

    public static async open(
        directory: string,
        identity: ConnectorClientIdentity,
        scope: ExecutionInputJournalScope,
    ): Promise<ExecutionInputJournalOwner> {
        return new ExecutionInputJournalOwner(
            await ExecutionInputJournalStore.open(directory, identity, scope),
        );
    }

    /** A failed atomic publication forbids further native input or ordinary command completion. */
    public get failed(): boolean {
        return this.#storage.failed;
    }

    /** Loading is explicit; absence never synthesizes an original or resets a used input cursor. */
    public get loaded(): boolean {
        return this.#storage.loaded;
    }

    /** A caller may identify an inactive prior terminal record without adopting it as the current original. */
    public async inspectExisting(): Promise<ExecutionInputJournalRecordState | null> {
        return await this.#storage.run(
            async (): Promise<ExecutionInputJournalRecordState | null> =>
                (await this.#storage.existing())?.state ?? null,
        );
    }

    /** The lifecycle owner can distinguish prepared recovery from genuine Ready without inventing a cursor. */
    public recordState(): ExecutionInputJournalRecordState {
        return this.#storage.state();
    }

    /** The main journal must own this fresh original before any kernel group binding. */
    public async prepareFresh(
        input: ExecutionInputJournalPreparation,
        session: ConnectorClientSession,
        nowMs: bigint,
    ): Promise<ExecutionInputJournalPreparedState> {
        return await this.#phases.prepare(input, session, nowMs);
    }
    /** Genuine native evidence confirms the original durable preparation. */
    public async confirmReady(
        admission: ExecutionInputJournalAdmission,
    ): Promise<ExecutionInputJournalState> {
        return await this.#phases.confirm(admission);
    }
    /** Restoring expected first evidence never creates a missing original. */
    public async restore(
        expected: ExecutionInputJournalAdmission,
    ): Promise<ExecutionInputJournalState> {
        return await this.#phases.restore(expected);
    }
    /** No-effect terminal recovery requires the caller's exact captured main binding and an already-existing encrypted record. */
    public async restoreCaptured(
        expected: ExecutionInputJournalRecordState,
    ): Promise<ExecutionInputJournalRecordState> {
        return await this.#phases.restoreCaptured(expected);
    }
    /** Recovery verifies main exact original and captured incarnation before recording owner loss. */
    public async recoverOriginal(
        original: ExecutionPermit | ExecutionCancellation,
        session: ConnectorClientSession,
        nowMs: bigint,
        expectedIncarnation: string,
    ): Promise<ExecutionInputJournalRecordState> {
        return await this.#phases.recover(original, session, nowMs, expectedIncarnation);
    }

    /** A non-null receipt is read-only evidence: return it without native I/O. Only an unreceipted capture may attempt its exact bytes. */
    public async stage(
        value: ExecutionInputPermit,
        session: ConnectorClientSession,
        nowMs: bigint,
    ): Promise<ExecutionInputJournalControl> {
        return await this.#run(async (): Promise<ExecutionInputJournalControl> => {
            const state: ExecutionInputJournalState = this.#state();
            const permit: ExecutionInputPermit = ExecutionInputPermitCodec.decode(
                ExecutionInputPermitCodec.encode(value),
            );
            this.#delivery(permit.leaseId, permit.writerGeneration, session, nowMs, state);
            if (!ConnectorClock.issued(permit.issuedAtMs, nowMs) || permit.expiresAtMs <= nowMs) {
                throw new Error('Original interactive input delivery has expired');
            }
            for (const retained of [state.pending, state.last]) {
                if (
                    retained !== null &&
                    retained.kind === ExecutionInputJournalControlKind.Permit &&
                    retained.receipt !== null &&
                    retained.permit.inputHash === permit.inputHash &&
                    ExecutionInputControlCodec.encode(retained.permit.input) ===
                        ExecutionInputControlCodec.encode(permit.input)
                ) {
                    this.#storage.codec.validation.control(
                        { ...retained, permit },
                        state.admission,
                    );
                    if (permit.writerGeneration !== state.writerGeneration) {
                        await this.#commit({ ...state, writerGeneration: permit.writerGeneration });
                    }
                    return retained;
                }
            }
            if (
                state.ownerLost ||
                state.inputStopped ||
                state.terminal !== null ||
                (state.pending === null && (state.cursor.blocked || state.cursor.ended))
            ) {
                throw new Error('Original interactive native owner is unavailable');
            }
            const prior: typeof state.cursor = state.pending?.prior ?? state.cursor;
            const control: ExecutionInputJournalControl = {
                kind: ExecutionInputJournalControlKind.Permit,
                permit,
                prior,
                receipt: null,
                acknowledgment: null,
            };
            const context: ExecutionInputReceiptContext = ExecutionInputCorrelation.context(
                this.#storage.codec.validation.context(control),
            );
            this.#storage.codec.validation.control(control, state.admission);
            if (state.pending !== null) {
                if (
                    state.pending.kind !== ExecutionInputJournalControlKind.Permit ||
                    state.pending.permit.inputHash !== permit.inputHash ||
                    this.#storage.codec.validation.json(
                        this.#storage.codec.validation.context(state.pending),
                    ) !== this.#storage.codec.validation.json(context)
                ) {
                    throw new Error('Another immutable input control is pending');
                }
                /** The first permit proof remains retained even when a verified current delivery wrapper changes. */
                if (permit.writerGeneration !== state.writerGeneration) {
                    await this.#commit({ ...state, writerGeneration: permit.writerGeneration });
                }
                return state.pending;
            }
            await this.#commit({
                ...state,
                pending: control,
                writerGeneration: permit.writerGeneration,
            });
            const saved: ExecutionInputJournalRetainedControl = this.#pending(this.#state());
            if (saved.kind !== ExecutionInputJournalControlKind.Permit) {
                throw new Error('Native control publication changed its authority kind');
            }
            return saved;
        });
    }

    /** Distinct terminal authority records only uncertainty after the local main outcome is durable, never native I/O. */
    public async resolveTerminal(
        value: ExecutionInputTerminalResolution,
        actualResponseHash: string,
        session: ConnectorClientSession,
        nowMs: bigint,
    ): Promise<ExecutionInputReceipt> {
        return await this.#run(async (): Promise<ExecutionInputReceipt> => {
            const state: ExecutionInputJournalState = this.#state();
            const decision: ReturnType<ExecutionInputJournalResolution['capture']> =
                new ExecutionInputJournalResolution(this.#storage.codec.validation).capture(
                    state,
                    value,
                    actualResponseHash,
                    session,
                    nowMs,
                );
            if (decision.control.receipt !== null) {
                if (decision.writerGeneration !== state.writerGeneration) {
                    await this.#commit({ ...state, writerGeneration: decision.writerGeneration });
                }
                return decision.control.receipt;
            }
            await this.#commit({
                ...state,
                pending: decision.control,
                inputStopped: true,
                writerGeneration: decision.writerGeneration,
            });
            const receipt: ExecutionInputReceipt = ExecutionInputIndeterminate.sign(
                decision.control,
                this.#storage.codec.validation.identity.key,
            );
            this.#storage.codec.validation.control(
                { ...decision.control, receipt },
                state.admission,
            );
            await this.#commit({
                ...this.#state(),
                pending: { ...decision.control, receipt },
                cursor: receipt.cursor,
            });
            return receipt;
        });
    }

    /** The first signed native outcome is immutable; a new randomized proof cannot replace it. */
    public async record(receipt: ExecutionInputReceipt): Promise<ExecutionInputReceipt> {
        return await this.#run(async (): Promise<ExecutionInputReceipt> => {
            const state: ExecutionInputJournalState = this.#state();
            const pending: ExecutionInputJournalRetainedControl = this.#pending(state);
            const context: ExecutionInputReceiptContext =
                this.#storage.codec.validation.context(pending);
            const captured: ExecutionInputReceipt = ExecutionInputReceiptCodec.decode(
                ExecutionInputReceiptCodec.encode(receipt, context),
                context,
            );
            if (pending.receipt !== null) {
                if (
                    Proof.receiptSha256(pending.receipt, context) !==
                    Proof.receiptSha256(captured, context)
                ) {
                    throw new Error('First signed input receipt cannot be replaced');
                }
                return pending.receipt;
            }
            if (state.ownerLost) {
                throw new Error('Lost native ownership cannot report a new applied input');
            }
            this.#storage.codec.validation.control(
                { ...pending, receipt: captured },
                state.admission,
            );
            await this.#commit({
                ...state,
                pending: { ...pending, receipt: captured },
                cursor: captured.cursor,
                /** Stop on the first refusal/uncertainty. Applied cursor totals therefore also bound admitted work. */
                inputStopped: captured.disposition !== ExecutionInputDisposition.Applied,
            });
            return captured;
        });
    }

    /** Credit is released only after the pinned authority signs this full first retained receipt proof. */
    public async acknowledge(
        value: ExecutionInputAcknowledgment,
        session: ConnectorClientSession,
        nowMs: bigint,
    ): Promise<ExecutionInputAcknowledgment> {
        return await this.#run(async (): Promise<ExecutionInputAcknowledgment> => {
            const state: ExecutionInputJournalState = this.#state();
            const captured: ExecutionInputJournalCapturedAcknowledgment =
                ExecutionInputJournalAcknowledgments.capture(state, value);
            const { control, acknowledgment }: ExecutionInputJournalCapturedAcknowledgment =
                captured;
            this.#delivery(
                acknowledgment.leaseId,
                acknowledgment.writerGeneration,
                session,
                nowMs,
                state,
            );
            this.#storage.codec.validation.control({ ...control, acknowledgment }, state.admission);
            if (
                control.acknowledgment !== null &&
                ExecutionInputJournalAcknowledgments.sameWrapper(
                    control.acknowledgment,
                    acknowledgment,
                )
            ) {
                return control.acknowledgment;
            }
            await this.#commit({
                ...state,
                pending:
                    captured.target === ExecutionInputJournalAcknowledgmentTarget.Pending
                        ? null
                        : state.pending,
                last: { ...control, acknowledgment },
                writerGeneration: acknowledgment.writerGeneration,
            });
            return acknowledgment;
        });
    }

    /** Read-only snapshots distinguish local owner loss, signed receipt and backend acknowledgment. */
    public snapshot(): ExecutionInputJournalState {
        return this.#state();
    }

    /** Post-deadline evidence drains under a live enrolled session; no permit, signature, cursor advance or native authority is created. */
    public pendingReceipt(
        session: ConnectorClientSession,
        nowMs: bigint,
    ): ExecutionInputReceipt | null {
        const state: ExecutionInputJournalState = this.#state();
        this.#storage.codec.validation.current(session, nowMs);
        return state.pending?.receipt ?? null;
    }

    /** Terminal result and backend compaction authority must both match; unresolved input receipts retain their credit. */
    public async retire(
        completion: ExecutionCompletion,
        acknowledgment: ExecutionAcknowledgment,
        session: ConnectorClientSession,
        nowMs: bigint,
    ): Promise<ExecutionInputJournalState> {
        return await this.#run(async (): Promise<ExecutionInputJournalState> => {
            const state: ExecutionInputJournalState = this.#state();
            if (state.pending !== null) {
                throw new Error('Input receipt acknowledgment is required before cursor reuse');
            }
            this.#storage.codec.validation.lease(session, acknowledgment.leaseId, nowMs);
            const terminal: NonNullable<ExecutionInputJournalState['terminal']> =
                ExecutionInputJournalTerminalProof.verify(
                    this.#storage.codec.validation,
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
            return await this.#commit({ ...state, terminal });
        });
    }

    /** A prepared original also requires both actual terminal proofs before monotonic fixed-file reuse. */
    public async retirePrepared(
        completion: ExecutionCompletion,
        acknowledgment: ExecutionAcknowledgment,
        session: ConnectorClientSession,
        nowMs: bigint,
    ): Promise<ExecutionInputJournalPreparedState> {
        return await this.#phases.retire(completion, acknowledgment, session, nowMs);
    }
    /** All mutations must join before the independent kernel lock and encryption owner are released. */
    public async [Symbol.asyncDispose](): Promise<void> {
        await this.#storage[Symbol.asyncDispose]();
    }

    #delivery(
        leaseId: string,
        generation: bigint,
        session: ConnectorClientSession,
        nowMs: bigint,
        state: ExecutionInputJournalState,
    ): void {
        this.#storage.codec.validation.lease(session, leaseId, nowMs);
        if (generation < state.writerGeneration) {
            throw new Error('Stale interactive writer generation');
        }
    }
    #pending(state: ExecutionInputJournalState): ExecutionInputJournalRetainedControl {
        if (state.pending === null) {
            throw new Error('No immutable input control is pending');
        }
        return state.pending;
    }
    #state(): ExecutionInputJournalState {
        return this.#storage.ready();
    }
    async #commit(state: ExecutionInputJournalState): Promise<ExecutionInputJournalState> {
        return await this.#storage.publishReady(state);
    }
    async #run<T>(action: () => Promise<T>): Promise<T> {
        return await this.#storage.run(action);
    }
}
