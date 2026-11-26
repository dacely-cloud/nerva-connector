// SPDX-FileCopyrightText: 2026 Dacely <business@dacely.com>
// SPDX-License-Identifier: LicenseRef-Proprietary

import type { ExecutionInputReceiptContext } from 'nerva-connector-protocol/execution/ExecutionInput.js';
import {
    ExecutionInputJournalControlKind,
    type ExecutionInputJournalRetainedControl,
} from './ExecutionInputJournalTypes.js';

/** Shared context is data only; callers must retain the authority discriminant before selecting any native effect. */
export class ExecutionInputJournalControls {
    /** The first input and pre-effect cursor remain unchanged across current-lease delivery wrappers. */
    public static context(
        control: ExecutionInputJournalRetainedControl,
    ): ExecutionInputReceiptContext {
        return control.kind === ExecutionInputJournalControlKind.Permit
            ? {
                  input: control.permit.input,
                  inputHash: control.permit.inputHash,
                  prior: control.prior,
              }
            : {
                  input: control.resolution.input,
                  inputHash: control.resolution.inputHash,
                  prior: control.prior,
              };
    }
    /** Retained authority and ACK wrappers cannot exceed the lane's monotonic writer generation. */
    public static generation(control: ExecutionInputJournalRetainedControl): bigint {
        return control.kind === ExecutionInputJournalControlKind.Permit
            ? control.permit.writerGeneration
            : control.resolution.writerGeneration;
    }
}
