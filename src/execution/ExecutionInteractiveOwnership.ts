// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

import { ConnectorClientSession } from '../runtime/ConnectorClientSession.js';
import type { ConnectorClientIdentity } from '../runtime/ConnectorClientConfiguration.js';
import type { ConnectorCapturedInteractiveExecutionEffect } from '../runtime/ConnectorEffectContext.js';
import { ConnectorEffectKind } from '../runtime/ConnectorEffectContext.js';
import type { ConnectorOperationJournal } from '../runtime/ConnectorOperationJournal.js';
import { ExecutionInteractiveMain } from './ExecutionInteractiveMain.js';
import { ExecutionInteractiveInput } from './ExecutionInteractiveInput.js';
import { ExecutionInputJournalOwner } from './ExecutionInputJournalOwner.js';
import {
    ExecutionInputJournalPhase,
    type ExecutionInputJournalRecordState,
} from './ExecutionInputJournalTypes.js';
import { ExecutionInputWorkCapture } from 'nerva-connector-protocol/execution/ExecutionInputWorkCapture.js';
import { ExecutionInteractiveRuntime } from './ExecutionInteractiveRuntime.js';
import { ExecutionNativePipeHandle } from './ExecutionNativePipeHandle.js';
import { ExecutionConfiguration } from './ExecutionConfiguration.js';
import {
    ExecutionInteractiveTransport,
    type ExecutionInteractiveReady,
} from 'nerva-connector-protocol/execution/ExecutionInteractive.js';
import type { ExecutionClientSettings } from './ExecutionClientSettings.js';
import type {
    ExecutionRequest,
    ExecutionPermit,
    ExecutionCancellation,
    ExecutionCompletion,
    ExecutionAcknowledgment,
} from './ExecutionJobs.js';
import type { ExecutionResult } from './ExecutionTypes.js';
import type { ExecutionOutput } from './ExecutionOutput.js';
import type {
    ExecutionInteractiveResolution,
    ExecutionInteractiveNativeBinding,
    ExecutionInteractiveDeliveryReply,
} from './ExecutionInteractiveOwnershipTypes.js';
import { ExecutionInteractiveRetirementPending } from './ExecutionInteractiveRetirementPending.js';

/** One permanent lane owns input evidence and borrows its current sandbox; sockets can observe but never replace it. */
export class ExecutionInteractiveOwnership implements AsyncDisposable {
    #runtime: ExecutionInteractiveRuntime | null = null;
    #native: ExecutionNativePipeHandle | null = null;
    #readiness: Promise<boolean> | null = null;
    readonly #binding: ExecutionInteractiveMain;
    readonly #inputs: ExecutionInteractiveInput;
    #abort: (() => void) | null = null;
    #stopped: boolean = false;
    #failed: boolean = false;
    #closed: boolean = false;
    private constructor(
        public readonly identity: ConnectorClientIdentity,
        public readonly journal: ExecutionInputJournalOwner,
        public readonly main: ConnectorOperationJournal<
            ExecutionRequest,
            ExecutionResult,
            ExecutionOutput
        >,
        public readonly committed: () => void,
    ) {
        this.#binding = new ExecutionInteractiveMain(main, journal);
        this.#inputs = new ExecutionInteractiveInput(
            journal,
            this.#binding,
            committed,
            (): boolean => this.#stopped,
            (): void => {
                this.#failed = true;
                this.stopInput();
                this.#abort?.();
            },
        );
    }

    /** The already-owned main lane identity scopes the single existing private input file and independent lock. */
    public static async open(
        identity: ConnectorClientIdentity,
        settings: ExecutionClientSettings,
        main: ConnectorOperationJournal<ExecutionRequest, ExecutionResult, ExecutionOutput>,
        committed: () => void,
    ): Promise<ExecutionInteractiveOwnership> {
        const journal: ExecutionInputJournalOwner = await ExecutionInputJournalOwner.open(
            ExecutionConfiguration.journalDirectory(settings),
            identity,
            { lane: settings.lane, journalId: main.id },
        );
        return new ExecutionInteractiveOwnership(identity, journal, main, committed);
    }
    /** Durability failure forbids publishing an ordinary completed native lifecycle. */
    public get failed(): boolean {
        return this.#failed || this.journal.failed;
    }

    /** Fresh main Started and its explicit captured mode precede preparation; no native launch occurs in this method. */
    public async prepare(
        permit: ExecutionPermit,
        session: ConnectorClientSession,
        resolved: ExecutionInteractiveResolution,
        context: ConnectorCapturedInteractiveExecutionEffect,
        abort: () => void,
    ): Promise<ExecutionInteractiveNativeBinding> {
        this.#available();
        this.#binding.original(permit);
        const current: ConnectorCapturedInteractiveExecutionEffect = this.#binding.context(context);
        if (current.group !== null) {
            throw new Error('Interactive preparation must precede captured group binding');
        }
        if (
            this.#native !== null ||
            this.#inputs.busy ||
            resolved.launch.transport !== ExecutionInteractiveTransport.Pipe ||
            context.incarnation.length !== 64 ||
            context.policySha256 !== permit.request.policySha256 ||
            context.rootId !== permit.request.rootId ||
            resolved.launch.executionDeadlineMs !== permit.executionDeadlineMs
        ) {
            throw new Error('Interactive native preparation changed its main original');
        }
        await this.journal.prepareFresh(
            {
                permit,
                rule: resolved.rule,
                launch: resolved.launch,
                incarnation: context.incarnation,
            },
            session,
            BigInt(Date.now()),
        );
        const native: ExecutionNativePipeHandle = new ExecutionNativePipeHandle(
            context.incarnation,
            resolved.launch.invocation.stdin,
            {
                maximumInputBytes: resolved.rule.maximumInputBytes,
                maximumControls: resolved.rule.maximumControls,
            },
            resolved.launch.executionDeadlineMs,
        );
        this.#native = native;
        this.#runtime = null;
        this.#readiness = null;
        this.#abort = abort;
        this.#stopped = false;
        return Object.freeze({
            pipe: native,
            incarnation: context.incarnation,
            ready: async (): Promise<boolean> => {
                this.#readiness ??= this.#ready(native, permit, resolved, context.incarnation);
                return await this.#readiness;
            },
            completed: async (): Promise<void> => this.completed(),
        });
    }
    /** Recovery follows the saved mode and planned incarnation, never the current policy's interpretation of argument text. */
    public async recover(
        original: ExecutionPermit | ExecutionCancellation,
        session: ConnectorClientSession,
        context: ConnectorCapturedInteractiveExecutionEffect,
    ): Promise<void> {
        this.#available();
        this.#binding.original(original);
        this.#binding.context(context);
        if (!this.journal.loaded) {
            const retained: ExecutionInputJournalRecordState | null =
                await this.journal.inspectExisting();
            if (retained !== null) {
                this.#binding.terminalResolutions(retained);
            }
            if (
                context.group === null &&
                (retained === null || this.#binding.priorTerminal(retained))
            ) {
                this.#stopped = true;
                return;
            }
            await this.journal.recoverOriginal(
                original,
                session,
                BigInt(Date.now()),
                context.incarnation,
            );
        }
        const state: ExecutionInputJournalRecordState | null = this.#binding.record();
        if (state === null) {
            if (context.group !== null) {
                throw new Error('Bound interactive original has no current input record');
            }
            this.#stopped = true;
            return;
        }
        this.#binding.terminalResolutions(state);
        const incarnation: string =
            state.phase === ExecutionInputJournalPhase.Ready
                ? state.admission.ready.incarnation
                : state.preparation.incarnation;
        if (incarnation !== context.incarnation) {
            throw new Error('Recovered main incarnation changed');
        }
        if (state.phase === ExecutionInputJournalPhase.Ready && this.#runtime === null) {
            this.#runtime = ExecutionInteractiveRuntime.recovered({
                identity: this.identity,
                journal: this.journal,
                nowMs: (): bigint => BigInt(Date.now()),
            });
        }
        this.#stopped = true;
        this.committed();
    }
    /** Startup can drain a completed original without a fresh start permit, native handle or current-policy interpretation. */
    public async restoreCompleted(): Promise<void> {
        this.#available();
        const pending: typeof this.main.pending = this.main.pending;
        if (
            pending?.effectContext.kind !== ConnectorEffectKind.CapturedInteractiveExecution ||
            pending.response === null
        ) {
            return;
        }
        if (this.journal.loaded) {
            throw new Error('Terminal input owner already loaded');
        }
        const context: ConnectorCapturedInteractiveExecutionEffect = this.#binding.context(
            pending.effectContext,
        );
        const retained: ExecutionInputJournalRecordState | null =
            await this.journal.inspectExisting();
        this.#stopped = true;
        if (retained === null || this.#binding.priorTerminal(retained)) {
            if (context.group !== null) {
                throw new Error('Bound completed original requires its existing input record');
            }
            return;
        }
        this.#binding.captured(retained);
        this.#binding.terminalResolutions(retained);
        const state: ExecutionInputJournalRecordState =
            await this.journal.restoreCaptured(retained);
        if (state.phase === ExecutionInputJournalPhase.Ready) {
            this.#runtime = ExecutionInteractiveRuntime.recovered({
                identity: this.identity,
                journal: this.journal,
                nowMs: (): bigint => BigInt(Date.now()),
            });
        }
        this.committed();
    }
    /** Current mutually confirmed observers can read only this main pending original's first durable native proof. */
    public ready(session: ConnectorClientSession): ExecutionInteractiveReady | null {
        this.#session(session);
        if (!this.journal.loaded) {
            return null;
        }
        if (
            this.main.pending?.effectContext.kind !==
            ConnectorEffectKind.CapturedInteractiveExecution
        ) {
            return null;
        }
        const state: ExecutionInputJournalRecordState | null = this.#binding.record();
        if (state === null || state.phase !== ExecutionInputJournalPhase.Ready) {
            return null;
        }
        this.#binding.original(state.admission.ready);
        return state.admission.ready;
    }
    /** ACK selection searches both retained originals before a single independently bounded live input operation. */
    public async input(
        work: ExecutionInputWorkCapture,
        session: ConnectorClientSession,
    ): Promise<ExecutionInteractiveDeliveryReply> {
        this.#session(session);
        if (this.#runtime === null) {
            throw new Error('Interactive input delivery unavailable');
        }
        return await this.#inputs.input(work, session, this.#runtime);
    }
    /** A verified original stop blocks later positive input outcomes before its caller aborts native descendants. */
    public stopInput(): void {
        this.#stopped = true;
        this.#runtime?.stopInput();
    }

    /** Join native input evidence before the main command can publish its terminal result. */
    public async completed(): Promise<void> {
        this.stopInput();
        this.#native?.close();
        await this.#inputs.idle();
        this.#native = null;
        this.#abort = null;
        if (this.failed) {
            throw new Error('Interactive input durability is unproven');
        }
    }
    /** Main result compaction cannot leave an active or unacknowledged input cursor reusable. */
    public async retire(
        completion: ExecutionCompletion,
        acknowledgment: ExecutionAcknowledgment,
        session: ConnectorClientSession,
    ): Promise<void> {
        this.#session(session);
        if (!this.journal.loaded) {
            return;
        }
        await this.#inputs.idle();
        const state: ExecutionInputJournalRecordState | null = this.#binding.record();
        if (state === null) {
            if (
                this.main.pending?.effectContext.kind ===
                    ConnectorEffectKind.CapturedInteractiveExecution &&
                this.main.pending.effectContext.group !== null
            ) {
                throw new Error('Bound interactive retirement requires its durable input record');
            }
            return;
        }
        if (state.phase === ExecutionInputJournalPhase.Ready) {
            if (state.pending !== null) {
                throw new ExecutionInteractiveRetirementPending();
            }
            await this.journal.retire(completion, acknowledgment, session, BigInt(Date.now()));
        } else {
            await this.journal.retirePrepared(
                completion,
                acknowledgment,
                session,
                BigInt(Date.now()),
            );
        }
    }
    /** The parent stops/joins sandbox effects first, then releases this fixed lane's private input owner. */
    public async [Symbol.asyncDispose](): Promise<void> {
        this.#closed = true;
        this.stopInput();
        this.#native?.close();
        await Promise.allSettled([this.#readiness, this.#inputs.idle()]);
        await this.journal[Symbol.asyncDispose]();
    }
    async #ready(
        native: ExecutionNativePipeHandle,
        permit: ExecutionPermit,
        resolved: ExecutionInteractiveResolution,
        incarnation: string,
    ): Promise<boolean> {
        try {
            await native.ready;
        } catch {
            return false;
        }
        try {
            this.#runtime = await ExecutionInteractiveRuntime.create({
                identity: this.identity,
                permit,
                rule: resolved.rule,
                launch: resolved.launch,
                incarnation,
                native,
                journal: this.journal,
                nowMs: (): bigint => BigInt(Date.now()),
            });
            if (this.#stopped) {
                this.#runtime.stopInput();
            }
            this.committed();
            return true;
        } catch (caught: unknown) {
            this.#failed = true;
            this.stopInput();
            this.#abort?.();
            throw caught;
        }
    }
    #session(session: ConnectorClientSession): void {
        this.#available();
        if (session.identity !== this.identity) {
            throw new Error('Interactive session belongs to another owner');
        }
        ConnectorClientSession.current(session, BigInt(Date.now()));
    }
    #available(): void {
        if (this.#closed || this.failed) {
            throw new Error('Interactive execution owner unavailable');
        }
    }
}
