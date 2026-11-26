// SPDX-FileCopyrightText: 2026 Dacely <business@dacely.com>
// SPDX-License-Identifier: LicenseRef-Proprietary

import type { ConnectorStorageCodec } from '../runtime/ConnectorOperationCodec.js';
import { ExecutionInputJournalCodec } from './ExecutionInputJournalCodec.js';
import { ExecutionInputPreparationCodec } from './ExecutionInputPreparationCodec.js';
import type { ExecutionInputJournalValidation } from './ExecutionInputJournalValidation.js';
import {
    ExecutionInputJournalPhase,
    type ExecutionInputJournalRecordState,
} from './ExecutionInputJournalTypes.js';

/** One mandatory phase selects a closed codec; historical records without that phase cannot become Ready. */
export class ExecutionInputRecordCodec implements ConnectorStorageCodec<ExecutionInputJournalRecordState> {
    public readonly cursor: ExecutionInputJournalCodec;
    public readonly preparation: ExecutionInputPreparationCodec;
    public constructor(public readonly validation: ExecutionInputJournalValidation) {
        this.cursor = new ExecutionInputJournalCodec(validation);
        this.preparation = new ExecutionInputPreparationCodec(validation);
    }
    /** Phase access is descriptor-only until the selected complete record decoder validates all fields. */
    public read(raw: unknown): ExecutionInputJournalRecordState {
        if (
            typeof raw !== 'object' ||
            raw === null ||
            Array.isArray(raw) ||
            Object.getPrototypeOf(raw) !== Object.prototype
        ) {
            throw new Error('Explicit input journal record required');
        }
        const descriptor: PropertyDescriptor | undefined = Object.getOwnPropertyDescriptor(
            raw,
            'phase',
        );
        const phase: unknown = descriptor?.value;
        if (phase === ExecutionInputJournalPhase.Prepared) {
            return this.preparation.read(raw);
        }
        if (phase === ExecutionInputJournalPhase.Ready) {
            return this.cursor.read(raw);
        }
        throw new Error('Explicit input journal phase required');
    }
    /** No phase transition is inferred from omitted fields or a failed decoder. */
    public encode(state: ExecutionInputJournalRecordState): string {
        return state.phase === ExecutionInputJournalPhase.Prepared
            ? this.preparation.encode(state)
            : this.cursor.encode(state);
    }
}
