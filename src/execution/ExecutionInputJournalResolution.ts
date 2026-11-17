// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

import { ConnectorClock } from '../protocol/ConnectorClock.js';
import { SigningKey } from '../identity/SigningKey.js';
import { SignaturePurpose } from 'nerva-connector-protocol/identity/IdentityFormat.js';
import type { ConnectorClientSession } from '../runtime/ConnectorClientSession.js';
import { ExecutionInputTerminalResolutionCodec } from 'nerva-connector-protocol/execution/ExecutionInputTerminalResolutionCodec.js';
import type { ExecutionInputTerminalResolution } from 'nerva-connector-protocol/execution/ExecutionInputTerminalResolution.js';
import { ExecutionInteractiveProof } from 'nerva-connector-protocol/execution/ExecutionInteractiveProof.js';
import { ExecutionInputControlCodec } from 'nerva-connector-protocol/execution/ExecutionInputControlCodec.js';
import { ExecutionInputCorrelation } from 'nerva-connector-protocol/execution/ExecutionInputCorrelation.js';
import { ExecutionInputJournalControls } from './ExecutionInputJournalControls.js';
import type { ExecutionInputJournalValidation } from './ExecutionInputJournalValidation.js';
import {
    ExecutionInputJournalControlKind,
    type ExecutionInputJournalRetainedControl,
    type ExecutionInputJournalState,
} from './ExecutionInputJournalTypes.js';

/** A terminal decision preserves an existing immutable control/proof or captures one new no-effect authority. */
export interface ExecutionInputResolutionDecision {
    readonly control: ExecutionInputJournalRetainedControl;
    readonly writerGeneration: bigint;
}

/** This owner has no native handle; a terminal resolution can record uncertainty but cannot become a write permit. */
export class ExecutionInputJournalResolution {
    public constructor(public readonly validation: ExecutionInputJournalValidation) {}

    /** Actual retained main response and current lease are mandatory before any exact receipt retry or durable admission. */
    public capture(
        state: ExecutionInputJournalState,
        input: ExecutionInputTerminalResolution,
        actualResponseHash: string,
        session: ConnectorClientSession,
        nowMs: bigint,
    ): ExecutionInputResolutionDecision {
        const value: ExecutionInputTerminalResolution =
            ExecutionInputTerminalResolutionCodec.decode(
                ExecutionInputTerminalResolutionCodec.encode(input),
            );
        const lease: ReturnType<ExecutionInputJournalValidation['current']> =
            this.validation.current(session, nowMs);
        if (
            value.leaseId !== lease.leaseId ||
            value.writerGeneration < state.writerGeneration ||
            value.issuedAtMs < lease.issuedAtMs ||
            !ConnectorClock.issued(value.issuedAtMs, nowMs) ||
            value.deliveryExpiresAtMs <= nowMs ||
            value.deliveryExpiresAtMs > lease.expiresAtMs ||
            value.executionDeadlineMs !== state.admission.launch.executionDeadlineMs ||
            value.responseHash !== actualResponseHash ||
            !SigningKey.verify(
                SignaturePurpose.OperationExecutionInputTerminalResolution,
                this.validation.identity.authority.publicKey,
                ExecutionInteractiveProof.resolution(
                    ExecutionInputTerminalResolutionCodec.unsigned(value),
                    state.admission.ready,
                ),
                value.signature,
            )
        ) {
            throw new Error('Signed terminal input resolution denied');
        }
        const resolved: ExecutionInputJournalRetainedControl = {
            kind: ExecutionInputJournalControlKind.TerminalResolution,
            resolution: value,
            prior: value.prior,
            receipt: null,
            acknowledgment: null,
        };
        this.validation.control(resolved, state.admission);
        const context: ReturnType<typeof ExecutionInputJournalControls.context> =
            ExecutionInputCorrelation.context(ExecutionInputJournalControls.context(resolved));
        for (const retained of [state.pending, state.last]) {
            if (retained === null) {
                continue;
            }
            const previous: typeof context = ExecutionInputJournalControls.context(retained);
            if (
                previous.inputHash === context.inputHash &&
                ExecutionInputControlCodec.encode(previous.input) ===
                    ExecutionInputControlCodec.encode(context.input) &&
                this.validation.json(previous.prior) === this.validation.json(context.prior)
            ) {
                if (retained.receipt !== null || retained === state.pending) {
                    return Object.freeze({
                        control: retained,
                        writerGeneration: value.writerGeneration,
                    });
                }
            }
        }
        if (
            state.terminal !== null ||
            state.pending !== null ||
            this.validation.json(context.prior) !== this.validation.json(state.cursor)
        ) {
            throw new Error(
                'Terminal input resolution changed its immutable pending control or confirmed lower bound',
            );
        }
        return Object.freeze({ control: resolved, writerGeneration: value.writerGeneration });
    }
}
