// SPDX-FileCopyrightText: 2026 Dacely <business@dacely.com>
// SPDX-License-Identifier: LicenseRef-Proprietary

import type { SigningKey } from '../identity/SigningKey.js';
import { SignaturePurpose } from 'nerva-connector-protocol/identity/IdentityFormat.js';
import {
    ExecutionInteractiveFields as Fields,
    ExecutionInteractiveEncoding,
} from 'nerva-connector-protocol/execution/ExecutionInteractiveFields.js';
import { ExecutionInteractiveProof } from 'nerva-connector-protocol/execution/ExecutionInteractiveProof.js';
import {
    ExecutionInputDisposition,
    type ExecutionInputReceipt,
    type ExecutionInputReceiptBody,
} from 'nerva-connector-protocol/execution/ExecutionInput.js';
import { ExecutionInputJournalControls } from './ExecutionInputJournalControls.js';
import type { ExecutionInputJournalRetainedControl } from './ExecutionInputJournalTypes.js';

/** Owner loss and terminal recovery record the last confirmed lower bound without invoking any native channel. */
export class ExecutionInputIndeterminate {
    public static sign(
        control: ExecutionInputJournalRetainedControl,
        key: SigningKey,
    ): ExecutionInputReceipt {
        const context: ReturnType<typeof ExecutionInputJournalControls.context> =
            ExecutionInputJournalControls.context(control);
        const body: ExecutionInputReceiptBody = {
            ...Fields.original(
                Fields.record(context.input, [
                    ...Fields.originalFields,
                    'readySha256',
                    'inputId',
                    'inputSequence',
                    'previousInputHash',
                    'control',
                ]),
                ExecutionInteractiveEncoding.Internal,
            ),
            readySha256: context.input.readySha256,
            inputId: context.input.inputId,
            inputSequence: context.input.inputSequence,
            inputHash: context.inputHash,
            disposition: ExecutionInputDisposition.Indeterminate,
            cursor: { ...context.prior, blocked: true },
        };
        return Object.freeze({
            ...body,
            signature: key.sign(
                SignaturePurpose.OperationExecutionInputReceipt,
                ExecutionInteractiveProof.receipt(body, context),
            ),
        });
    }
}
