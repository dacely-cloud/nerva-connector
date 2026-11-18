// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

import type { ConnectorStorageCodec } from '../runtime/ConnectorOperationCodec.js';
import { ExecutionJobsCodec } from './ExecutionJobsCodec.js';
import {
    ExecutionInteractiveFields as Fields,
    ExecutionInteractiveEncoding as Encoding,
} from 'nerva-connector-protocol/execution/ExecutionInteractiveFields.js';
import { ExecutionInteractiveCodec } from 'nerva-connector-protocol/execution/ExecutionInteractiveCodec.js';
import { ExecutionInteractiveRuleCodec } from 'nerva-connector-protocol/execution/ExecutionInteractiveRuleCodec.js';
import { ExecutionInteractiveLaunchCodec } from 'nerva-connector-protocol/execution/ExecutionInteractiveLaunchCodec.js';
import { ExecutionInputCursorCodec } from 'nerva-connector-protocol/execution/ExecutionInputCursorCodec.js';
import { ExecutionInputPermitCodec } from 'nerva-connector-protocol/execution/ExecutionInputPermitCodec.js';
import { ExecutionInputReceiptCodec } from 'nerva-connector-protocol/execution/ExecutionInputReceiptCodec.js';
import { ExecutionInputAcknowledgmentCodec } from 'nerva-connector-protocol/execution/ExecutionInputAcknowledgmentCodec.js';
import { ExecutionInputCorrelation } from 'nerva-connector-protocol/execution/ExecutionInputCorrelation.js';
import { ExecutionInputJournalControls } from './ExecutionInputJournalControls.js';
import { ExecutionInputTerminalResolutionCodec } from 'nerva-connector-protocol/execution/ExecutionInputTerminalResolutionCodec.js';
import {
    ExecutionInputDisposition,
    type ExecutionInputCursor,
    type ExecutionInputReceiptContext,
} from 'nerva-connector-protocol/execution/ExecutionInput.js';
import { ExecutionInputJournalValidation } from './ExecutionInputJournalValidation.js';
import {
    ExecutionInputJournalSchema,
    ExecutionInputJournalPhase,
    ExecutionInputJournalLimits as Limits,
    type ExecutionInputJournalAdmission,
    ExecutionInputJournalControlKind,
    type ExecutionInputJournalRetainedControl,
    type ExecutionInputJournalState,
    type ExecutionInputJournalTerminal,
} from './ExecutionInputJournalTypes.js';

/** Encrypted plaintext remains untrusted until its complete shape, proofs and cursor relationships agree. */
export class ExecutionInputJournalCodec implements ConnectorStorageCodec<ExecutionInputJournalState> {
    public constructor(public readonly validation: ExecutionInputJournalValidation) {}

    public read(raw: unknown): ExecutionInputJournalState {
        const value: Readonly<Record<string, unknown>> = Fields.record(raw, [
            'schema',
            'phase',
            'scope',
            'admission',
            'writerGeneration',
            'cursor',
            'ownerLost',
            'inputStopped',
            'pending',
            'last',
            'terminal',
        ]);
        if (
            value['schema'] !== ExecutionInputJournalSchema.Cursor ||
            value['phase'] !== ExecutionInputJournalPhase.Ready
        ) {
            throw new Error('Explicit interactive cursor schema required');
        }
        const scope: Readonly<Record<string, unknown>> = Fields.record(value['scope'], [
            'lane',
            'journalId',
        ]);
        if (
            ExecutionJobsCodec.lane(scope['lane']) !== this.validation.scope.lane ||
            Fields.digest(scope['journalId']) !== this.validation.scope.journalId
        ) {
            throw new Error('Interactive cursor belongs to another permanent lane');
        }
        const admission: ExecutionInputJournalAdmission = this.#admission(value['admission']);
        const cursor: ExecutionInputCursor = ExecutionInputCursorCodec.capture(
            value['cursor'],
            admission.ready.transport,
            Encoding.Wire,
        );
        const pending: ExecutionInputJournalRetainedControl | null =
            value['pending'] === null ? null : this.#control(value['pending'], admission);
        const last: ExecutionInputJournalRetainedControl | null =
            value['last'] === null ? null : this.#control(value['last'], admission);
        const writerGeneration: bigint = Fields.counter(
            value['writerGeneration'],
            Encoding.Wire,
            0n,
        );
        const terminal: ExecutionInputJournalTerminal | null =
            value['terminal'] === null ? null : this.#terminal(value['terminal']);
        const baseline: ExecutionInputCursor = last?.receipt?.cursor ?? this.initial(admission);
        const ownerLost: boolean = Fields.boolean(value['ownerLost']);
        const inputStopped: boolean = Fields.boolean(value['inputStopped']);
        if (
            (last !== null && (last.receipt === null || last.acknowledgment === null)) ||
            (pending !== null && pending.acknowledgment !== null) ||
            (pending !== null &&
                this.validation.json(pending.prior) !== this.validation.json(baseline)) ||
            this.validation.json(cursor) !==
                this.validation.json(pending?.receipt?.cursor ?? baseline) ||
            cursor.acceptedOffset > admission.rule.maximumInputBytes ||
            (cursor.processedSequence !== null &&
                cursor.processedSequence >= BigInt(admission.rule.maximumControls)) ||
            cursor.resizeCount > BigInt(admission.rule.maximumResizes) ||
            (terminal !== null && pending !== null) ||
            (ownerLost && !inputStopped) ||
            (!inputStopped &&
                [pending, last].some(
                    (control: ExecutionInputJournalRetainedControl | null): boolean =>
                        control?.kind === ExecutionInputJournalControlKind.TerminalResolution,
                )) ||
            (!inputStopped &&
                [pending, last].some(
                    (control: ExecutionInputJournalRetainedControl | null): boolean =>
                        control?.receipt !== null &&
                        control?.receipt !== undefined &&
                        control.receipt.disposition !== ExecutionInputDisposition.Applied,
                )) ||
            [pending, last].some(
                (control: ExecutionInputJournalRetainedControl | null): boolean =>
                    control !== null &&
                    (ExecutionInputJournalControls.generation(control) > writerGeneration ||
                        (control.acknowledgment !== null &&
                            control.acknowledgment.writerGeneration > writerGeneration)),
            )
        ) {
            throw new Error('Interactive cursor contradicts its retained controls');
        }
        return Object.freeze({
            schema: ExecutionInputJournalSchema.Cursor,
            phase: ExecutionInputJournalPhase.Ready,
            scope: this.validation.scope,
            admission,
            writerGeneration,
            cursor,
            ownerLost,
            inputStopped,
            pending,
            last,
            terminal,
        });
    }

    /** Every write reuses the decoder, so typed internal data cannot bypass storage invariants. */
    public encode(state: ExecutionInputJournalState): string {
        const json: string = this.#json(state);
        if (Buffer.byteLength(json) > Limits.plainBytes) {
            throw new Error('Interactive cursor exceeds its plaintext bound');
        }
        const raw: unknown = JSON.parse(json);
        return this.#json(this.read(raw));
    }

    /** Empty initial input is not implicitly accepted and cannot be replaced by an omitted cursor. */
    public initial(admission: ExecutionInputJournalAdmission): ExecutionInputCursor {
        return Object.freeze({
            processedSequence: null,
            processedInputHash: null,
            initialAccepted: false,
            blocked: false,
            acceptedOffset: 0n,
            ended: false,
            dimensions: admission.ready.dimensions,
            resizeCount: 0n,
        });
    }

    #admission(raw: unknown): ExecutionInputJournalAdmission {
        const value: Readonly<Record<string, unknown>> = Fields.record(raw, [
            'ready',
            'rule',
            'launch',
            'policySha256',
        ]);
        const rule: ReturnType<typeof ExecutionInteractiveRuleCodec.read> =
            ExecutionInteractiveRuleCodec.read(value['rule']);
        return this.validation.admission({
            ready: ExecutionInteractiveCodec.read(value['ready']),
            rule,
            launch: ExecutionInteractiveLaunchCodec.decode(rule, JSON.stringify(value['launch'])),
            policySha256: Fields.digest(value['policySha256']),
        });
    }

    #control(
        raw: unknown,
        admission: ExecutionInputJournalAdmission,
    ): ExecutionInputJournalRetainedControl {
        if (
            typeof raw !== 'object' ||
            raw === null ||
            Array.isArray(raw) ||
            Object.getPrototypeOf(raw) !== Object.prototype
        ) {
            throw new Error('Explicit retained input authority required');
        }
        const kind: unknown = Object.getOwnPropertyDescriptor(raw, 'kind')?.value;
        if (
            kind !== ExecutionInputJournalControlKind.Permit &&
            kind !== ExecutionInputJournalControlKind.TerminalResolution
        ) {
            throw new Error('Explicit retained input authority kind required');
        }
        const value: Readonly<Record<string, unknown>> = Fields.record(raw, [
            'kind',
            kind === ExecutionInputJournalControlKind.Permit ? 'permit' : 'resolution',
            'prior',
            'receipt',
            'acknowledgment',
        ]);
        const prior: ExecutionInputCursor = ExecutionInputCursorCodec.capture(
            value['prior'],
            admission.ready.transport,
            Encoding.Wire,
        );
        const authorization: ExecutionInputJournalRetainedControl =
            kind === ExecutionInputJournalControlKind.Permit
                ? {
                      kind,
                      permit: ExecutionInputPermitCodec.read(value['permit']),
                      prior,
                      receipt: null,
                      acknowledgment: null,
                  }
                : {
                      kind,
                      resolution: ExecutionInputTerminalResolutionCodec.read(value['resolution']),
                      prior,
                      receipt: null,
                      acknowledgment: null,
                  };
        const context: ExecutionInputReceiptContext = ExecutionInputCorrelation.context(
            ExecutionInputJournalControls.context(authorization),
        );
        const receipt: ReturnType<typeof ExecutionInputReceiptCodec.read> | null =
            value['receipt'] === null
                ? null
                : ExecutionInputReceiptCodec.read(value['receipt'], context);
        if (receipt === null && value['acknowledgment'] !== null) {
            throw new Error('Input acknowledgment requires its first retained receipt');
        }
        const acknowledgment: ReturnType<typeof ExecutionInputAcknowledgmentCodec.read> | null =
            value['acknowledgment'] === null || receipt === null
                ? null
                : ExecutionInputAcknowledgmentCodec.read(value['acknowledgment'], receipt);
        const control: ExecutionInputJournalRetainedControl = Object.freeze({
            ...authorization,
            prior,
            receipt,
            acknowledgment,
        });
        this.validation.control(control, admission);
        return control;
    }

    #terminal(raw: unknown): ExecutionInputJournalTerminal {
        const value: Readonly<Record<string, unknown>> = Fields.record(raw, [
            'completionSha256',
            'acknowledgmentSha256',
            'responseHash',
        ]);
        return Object.freeze({
            completionSha256: Fields.digest(value['completionSha256']),
            acknowledgmentSha256: Fields.digest(value['acknowledgmentSha256']),
            responseHash: Fields.digest(value['responseHash']),
        });
    }

    #json(state: ExecutionInputJournalState): string {
        return JSON.stringify(state, (_key: string, entry: unknown): unknown =>
            typeof entry === 'bigint' ? entry.toString() : entry,
        );
    }
}
