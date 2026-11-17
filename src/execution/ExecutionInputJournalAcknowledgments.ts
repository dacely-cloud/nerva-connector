// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

import {
    ExecutionInteractiveFields as Fields,
    ExecutionInteractiveEncoding as Encoding,
} from 'nerva-connector-protocol/execution/ExecutionInteractiveFields.js';
import { ExecutionInputIdentityCodec } from 'nerva-connector-protocol/execution/ExecutionInputIdentityCodec.js';
import { ExecutionInputAcknowledgmentCodec } from 'nerva-connector-protocol/execution/ExecutionInputAcknowledgmentCodec.js';
import { ExecutionInputJournalControls } from './ExecutionInputJournalControls.js';
import type {
    ExecutionInputAcknowledgment,
    ExecutionInputIdentity,
} from 'nerva-connector-protocol/execution/ExecutionInput.js';
import type {
    ExecutionInputJournalRetainedControl,
    ExecutionInputJournalState,
} from './ExecutionInputJournalTypes.js';

/** An old receipt can remain the ACK target while a newer immutable input is pending. */
export enum ExecutionInputJournalAcknowledgmentTarget {
    Pending = 'pending',
    Last = 'last',
}

/** Target selection is detached and exact before any current-session or proof verification mutates state. */
export interface ExecutionInputJournalCapturedAcknowledgment {
    readonly target: ExecutionInputJournalAcknowledgmentTarget;
    readonly control: ExecutionInputJournalRetainedControl;
    readonly acknowledgment: ExecutionInputAcknowledgment;
}

/** Receipt identity selects a retained original; it never means whichever control is currently pending. */
export class ExecutionInputJournalAcknowledgments {
    public static capture(
        state: ExecutionInputJournalState,
        value: ExecutionInputAcknowledgment,
    ): ExecutionInputJournalCapturedAcknowledgment {
        const record: Readonly<Record<string, unknown>> = Fields.record(value, [
            ...Fields.inputIdentityFields,
            'receiptSha256',
            'leaseId',
            'writerGeneration',
            'signature',
        ]);
        const identity: ExecutionInputIdentity = ExecutionInputIdentityCodec.capture(
            record,
            Encoding.Internal,
        );
        for (const target of [
            ExecutionInputJournalAcknowledgmentTarget.Pending,
            ExecutionInputJournalAcknowledgmentTarget.Last,
        ]) {
            const control: ExecutionInputJournalRetainedControl | null =
                target === ExecutionInputJournalAcknowledgmentTarget.Pending
                    ? state.pending
                    : state.last;
            if (
                control !== null &&
                control.receipt !== null &&
                ExecutionInputIdentityCodec.matches(
                    identity,
                    ExecutionInputJournalControls.context(control).input,
                    ExecutionInputJournalControls.context(control).inputHash,
                )
            ) {
                return Object.freeze({
                    target,
                    control,
                    acknowledgment: ExecutionInputAcknowledgmentCodec.decode(
                        ExecutionInputAcknowledgmentCodec.encode(value, control.receipt),
                        control.receipt,
                    ),
                });
            }
        }
        throw new Error('Exact first input receipt is unavailable');
    }

    /** A randomized signature is not a new wrapper; keep its first full proof for this exact lease/generation. */
    public static sameWrapper(
        left: ExecutionInputAcknowledgment,
        right: ExecutionInputAcknowledgment,
    ): boolean {
        return left.leaseId === right.leaseId && left.writerGeneration === right.writerGeneration;
    }
}
