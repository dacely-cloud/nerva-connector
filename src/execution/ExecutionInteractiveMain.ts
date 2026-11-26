// SPDX-FileCopyrightText: 2026 Dacely <business@dacely.com>
// SPDX-License-Identifier: LicenseRef-Proprietary

import type { ConnectorOperationJournal } from '../runtime/ConnectorOperationJournal.js';
import type { ConnectorJournalPending } from '../runtime/ConnectorJournalState.js';
import type { ConnectorCapturedInteractiveExecutionEffect } from '../runtime/ConnectorEffectContext.js';
import { ConnectorEffectKind } from '../runtime/ConnectorEffectContext.js';
import { ConnectorEffectContextCodec } from '../runtime/ConnectorEffectContextCodec.js';
import {
    ExecutionInputJournalPhase,
    ExecutionInputJournalControlKind,
    type ExecutionInputJournalRecordState,
} from './ExecutionInputJournalTypes.js';
import type { ExecutionInputJournalOwner } from './ExecutionInputJournalOwner.js';
import type {
    ExecutionPermit,
    ExecutionRequest,
} from 'nerva-connector-protocol/execution/ExecutionJobs.js';
import type { ExecutionInteractiveReady } from 'nerva-connector-protocol/execution/ExecutionInteractive.js';
import type { ExecutionResult } from 'nerva-connector-protocol/execution/ExecutionTypes.js';
import type { ExecutionOutput } from 'nerva-connector-protocol/execution/ExecutionOutput.js';
import { ExecutionProof } from 'nerva-connector-protocol/execution/ExecutionProof.js';

/** Captured main mode, original and incarnation authenticate input recovery and terminal evidence. */
export class ExecutionInteractiveMain {
    public constructor(
        public readonly main: ConnectorOperationJournal<
            ExecutionRequest,
            ExecutionResult,
            ExecutionOutput
        >,
        public readonly journal: ExecutionInputJournalOwner,
    ) {}
    /** Only an actual durable local result authorizes no-effect terminal resolution. */
    public responseHash(): string | null {
        const response: ExecutionResult | null = this.main.pending?.response ?? null;
        return response === null ? null : ExecutionProof.responseHash(response);
    }
    /** Match every retained main original field before exposing input evidence. */
    public original(
        value: Pick<
            ExecutionPermit,
            'jobId' | 'sequence' | 'dispatchId' | 'requestHash' | 'admissionHash'
        >,
    ): void {
        const pending: ConnectorJournalPending<
            ExecutionRequest,
            ExecutionResult,
            ExecutionOutput
        > | null = this.main.pending;
        if (
            pending === null ||
            pending.effectContext.kind !== ConnectorEffectKind.CapturedInteractiveExecution ||
            pending.jobId !== value.jobId ||
            pending.sequence !== value.sequence ||
            pending.dispatchId !== value.dispatchId ||
            pending.requestHash !== value.requestHash ||
            pending.admissionHash !== value.admissionHash
        ) {
            throw new Error('Interactive input changed its retained main original');
        }
    }
    /** Normalize and compare the entire captured physical mode before preparing or recovering. */
    public context(
        context: ConnectorCapturedInteractiveExecutionEffect,
    ): ConnectorCapturedInteractiveExecutionEffect {
        const current: typeof this.main.pending = this.main.pending;
        const normalized: ReturnType<typeof ConnectorEffectContextCodec.read> =
            ConnectorEffectContextCodec.read(
                JSON.parse(ConnectorEffectContextCodec.encode(context)),
            );
        if (
            current?.effectContext.kind !== ConnectorEffectKind.CapturedInteractiveExecution ||
            ConnectorEffectContextCodec.encode(normalized) !==
                ConnectorEffectContextCodec.encode(current.effectContext)
        ) {
            throw new Error('Interactive physical main context changed');
        }
        return current.effectContext;
    }
    /** Recovered no-effect authorities remain tied to the actual retained main result. */
    public terminalResolutions(state: ExecutionInputJournalRecordState): void {
        if (state.phase !== ExecutionInputJournalPhase.Ready) {
            return;
        }
        for (const control of [state.pending, state.last]) {
            if (control?.kind !== ExecutionInputJournalControlKind.TerminalResolution) {
                continue;
            }
            const response: ExecutionResult | null = this.main.pending?.response ?? null;
            if (
                response === null ||
                ExecutionProof.responseHash(response) !== control.resolution.responseHash
            ) {
                throw new Error('Retained input resolution changed its actual local main result');
            }
        }
    }
    /** Only a genuinely retired older sequence is inactive for a later main original. */
    public priorTerminal(state: ExecutionInputJournalRecordState): boolean {
        const original: ExecutionPermit | ExecutionInteractiveReady =
            state.phase === ExecutionInputJournalPhase.Ready
                ? state.admission.ready
                : state.preparation.permit;
        return (
            state.terminal !== null &&
            this.main.pending !== null &&
            original.sequence < this.main.pending.sequence
        );
    }
    /** The fixed input file must match the current saved main incarnation exactly. */
    public record(): ExecutionInputJournalRecordState | null {
        return this.captured(this.journal.recordState());
    }
    /** A decrypted candidate is checked before it can be adopted as terminal recovery evidence. */
    public captured(
        state: ExecutionInputJournalRecordState,
    ): ExecutionInputJournalRecordState | null {
        if (this.priorTerminal(state)) {
            return null;
        }
        this.original(
            state.phase === ExecutionInputJournalPhase.Ready
                ? state.admission.ready
                : state.preparation.permit,
        );
        const incarnation: string =
            state.phase === ExecutionInputJournalPhase.Ready
                ? state.admission.ready.incarnation
                : state.preparation.incarnation;
        if (
            this.main.pending?.effectContext.kind !==
                ConnectorEffectKind.CapturedInteractiveExecution ||
            this.main.pending.effectContext.incarnation !== incarnation
        ) {
            throw new Error('Interactive record changed its captured main incarnation');
        }
        return state;
    }
}
