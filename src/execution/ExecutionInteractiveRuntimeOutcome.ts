// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

import type { SigningKey } from '../identity/SigningKey.js';
import { SignaturePurpose } from 'nerva-connector-protocol/identity/IdentityFormat.js';
import {
    ExecutionInteractiveFields as Fields,
    ExecutionInteractiveEncoding as Encoding,
} from 'nerva-connector-protocol/execution/ExecutionInteractiveFields.js';
import { ExecutionInteractiveProof as Proof } from 'nerva-connector-protocol/execution/ExecutionInteractiveProof.js';
import {
    ExecutionInputKind,
    ExecutionInputDisposition,
    type ExecutionInputReceipt,
    type ExecutionInputReceiptBody,
} from 'nerva-connector-protocol/execution/ExecutionInput.js';
import type { ExecutionInputJournalControl } from './ExecutionInputJournalTypes.js';
import {
    ExecutionNativePipeCommandKind,
    type ExecutionNativePipeCommand,
    type ExecutionNativePipeApplied,
} from './ExecutionNativePipeProtocol.js';

/** Finite conversion grants no effects; native acceptance and journal publication remain distinct owners. */
export class ExecutionInteractiveRuntimeOutcome {
    public static command(
        control: ExecutionInputJournalControl,
        deliveryExpiresAtMs: bigint,
    ): ExecutionNativePipeCommand {
        const input: typeof control.permit.input = control.permit.input;
        if (input.control.kind === ExecutionInputKind.Resize) {
            throw new Error('A Pipe cannot accept PTY resizing');
        }
        const original: Omit<ExecutionNativePipeCommand, 'kind'> = {
            incarnation: input.incarnation,
            inputSequence: input.inputSequence,
            offset: input.control.offset,
            inputHash: control.permit.inputHash,
            deliveryExpiresAtMs,
        };
        return input.control.kind === ExecutionInputKind.Data
            ? {
                  ...original,
                  kind: ExecutionNativePipeCommandKind.Data,
                  dataHash: input.control.dataHash,
                  byteLength: input.control.byteLength,
                  dataBase64: input.control.dataBase64,
              }
            : { ...original, kind: ExecutionNativePipeCommandKind.End };
    }

    /** Null native result preserves the last confirmed lower bound and never guesses a partial write or consumption. */
    public static receipt(
        control: ExecutionInputJournalControl,
        native: ExecutionNativePipeApplied | null,
        key: SigningKey,
    ): ExecutionInputReceipt {
        const input: typeof control.permit.input = control.permit.input;
        const cursor: typeof control.prior =
            native === null
                ? { ...control.prior, blocked: true }
                : {
                      ...control.prior,
                      processedSequence: native.inputSequence,
                      processedInputHash: native.inputHash,
                      initialAccepted: true,
                      acceptedOffset: native.acceptedOffset,
                      ended: native.ended,
                  };
        if (native !== null && native.incarnation !== input.incarnation) {
            throw new Error('Native input result changed its exact incarnation');
        }
        const body: ExecutionInputReceiptBody = {
            ...Fields.original(
                Fields.record(input, [
                    ...Fields.originalFields,
                    'readySha256',
                    'inputId',
                    'inputSequence',
                    'previousInputHash',
                    'control',
                ]),
                Encoding.Internal,
            ),
            readySha256: input.readySha256,
            inputId: input.inputId,
            inputSequence: input.inputSequence,
            inputHash: control.permit.inputHash,
            disposition:
                native === null
                    ? ExecutionInputDisposition.Indeterminate
                    : ExecutionInputDisposition.Applied,
            cursor,
        };
        const context: ReturnType<typeof Fields.record> = Fields.record(control, [
            'kind',
            'permit',
            'prior',
            'receipt',
            'acknowledgment',
        ]);
        if (context['receipt'] !== null) {
            throw new Error('A retained signed input outcome cannot be replaced');
        }
        return Object.freeze({
            ...body,
            signature: key.sign(
                SignaturePurpose.OperationExecutionInputReceipt,
                Proof.receipt(body, {
                    input,
                    inputHash: control.permit.inputHash,
                    prior: control.prior,
                }),
            ),
        });
    }
}
