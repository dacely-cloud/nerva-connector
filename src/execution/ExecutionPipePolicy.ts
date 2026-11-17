// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

import { ExecutionInteractiveRuleCodec } from './ExecutionInteractiveRuleCodec.js';
import { ExecutionInteractiveTransport } from 'nerva-connector-protocol/execution/ExecutionInteractive.js';
import { ExecutionInputKind } from 'nerva-connector-protocol/execution/ExecutionInput.js';
import { ExecutionMachineRuleCodec } from './ExecutionMachineRuleCodec.js';
import type { ExecutionInteractiveInvocationRule } from 'nerva-connector-protocol/execution/ExecutionInteractiveInvocation.js';
import type { ExecutionProgramPolicy } from './ExecutionPolicyTypes.js';

/** Local Linux admission supports bounded Pipe input only; public PTY metadata grants no local capability. */
export class ExecutionPipePolicy {
    /** Canonical validation preserves bigint limits and checks nested aliases against this exact pinned binary table. */
    public static program(
        program: ExecutionProgramPolicy,
        timeoutMs: number,
    ): ExecutionInteractiveInvocationRule | null {
        const selected: ExecutionInteractiveInvocationRule | null =
            ExecutionInteractiveRuleCodec.placement(program.arguments);
        if (selected === null) {
            ExecutionMachineRuleCodec.program(program, timeoutMs);
            return null;
        }
        const rule: ExecutionInteractiveInvocationRule =
            ExecutionInteractiveRuleCodec.body(selected);
        if (
            rule.transports.length !== 1 ||
            rule.transports[0] !== ExecutionInteractiveTransport.Pipe ||
            rule.maximumResizes !== 0 ||
            rule.maximumControls < 2 ||
            rule.controls.length !== 2 ||
            !rule.controls.includes(ExecutionInputKind.Data) ||
            !rule.controls.includes(ExecutionInputKind.End)
        ) {
            throw new Error('Only bounded local Pipe input is supported');
        }
        ExecutionMachineRuleCodec.program({ ...program, arguments: [rule.invocation] }, timeoutMs);
        return rule;
    }
}
