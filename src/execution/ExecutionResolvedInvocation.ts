// SPDX-FileCopyrightText: 2026 Dacely <business@dacely.com>
// SPDX-License-Identifier: LicenseRef-Proprietary

import {
    ExecutionBootstrapInputKind,
    type ExecutionBootstrapInput,
} from './ExecutionBootstrapInput.js';
import { ExecutionInputCodec } from 'nerva-connector-protocol/execution/ExecutionInputCodec.js';
import { ExecutionMachineInvocationCodec } from 'nerva-connector-protocol/execution/ExecutionMachineInvocationCodec.js';
import { ExecutionMachineRuleCodec } from 'nerva-connector-protocol/execution/ExecutionMachineRuleCodec.js';
import { ExecutionInteractiveRuleCodec } from 'nerva-connector-protocol/execution/ExecutionInteractiveRuleCodec.js';
import { ExecutionInteractiveLaunchCodec } from 'nerva-connector-protocol/execution/ExecutionInteractiveLaunchCodec.js';
import { ExecutionInteractiveTransport } from 'nerva-connector-protocol/execution/ExecutionInteractive.js';
import type {
    ExecutionInteractiveInvocationRule,
    ExecutionInteractiveLaunch,
} from 'nerva-connector-protocol/execution/ExecutionInteractiveInvocation.js';
import type { ExecutionInteractiveResolution } from './ExecutionInteractiveOwnershipTypes.js';
import type {
    ExecutionMachineInvocationRule,
    ExecutionMachinePlan,
} from 'nerva-connector-protocol/execution/ExecutionMachineInvocation.js';
import type {
    ExecutionBinaryPolicy,
    ExecutionInvocation,
    ExecutionProgramPolicy,
} from 'nerva-connector-protocol/execution/ExecutionPolicyTypes.js';

/** An immutable trusted launch captures exactly the locally pinned binary and all signed application inputs. */
export interface ExecutionResolvedInvocation {
    readonly program: ExecutionBinaryPolicy;
    readonly arguments: readonly string[];
    readonly input: ExecutionBootstrapInput;
    readonly timeoutMs: number;
    readonly interactive: ExecutionInteractiveResolution | null;
}

/** No executable name, argument prefix or text rule can create Machine invocation authority. */
export class ExecutionInvocationResolution {
    /** Both inputs have passed their closed codecs; resolution finishes before any asynchronous effect admission. */
    public static capture(
        program: ExecutionProgramPolicy,
        invocation: ExecutionInvocation,
        timeoutMs: number,
    ): ExecutionResolvedInvocation {
        ExecutionMachineRuleCodec.program(program, timeoutMs);
        const interactiveRule: ExecutionInteractiveInvocationRule | null =
            ExecutionInteractiveRuleCodec.placement(program.arguments);
        let interactive: ExecutionInteractiveResolution | null = null;
        let payload: string | undefined = invocation.arguments[0];
        if (interactiveRule !== null) {
            ExecutionInteractiveRuleCodec.profile(program.arguments, timeoutMs);
            ExecutionMachineRuleCodec.program(
                { ...program, arguments: [interactiveRule.invocation] },
                timeoutMs,
            );
            if (invocation.arguments.length !== 1 || payload === undefined) {
                throw new Error('One complete canonical interactive invocation is required');
            }
            const rule: ExecutionInteractiveInvocationRule =
                ExecutionInteractiveRuleCodec.body(interactiveRule);
            const launch: ExecutionInteractiveLaunch = ExecutionInteractiveLaunchCodec.decode(
                rule,
                payload,
            );
            if (launch.transport !== ExecutionInteractiveTransport.Pipe) {
                throw new Error('Only qualified native Pipe execution is available');
            }
            interactive = Object.freeze({ rule, launch });
            payload = ExecutionMachineInvocationCodec.encode(rule.invocation, launch.invocation);
        }
        const rule: ExecutionMachineInvocationRule | null =
            interactive?.rule.invocation ?? ExecutionMachineRuleCodec.placement(program.arguments);
        if (rule === null) {
            return Object.freeze({
                program: Object.freeze({ path: program.path, sha256: program.sha256 }),
                arguments: Object.freeze([
                    ...ExecutionInputCodec.arguments(program, invocation.arguments),
                ]),
                input: Object.freeze({ kind: ExecutionBootstrapInputKind.Fixed }),
                timeoutMs,
                interactive: null,
            });
        }
        const value: string | undefined = payload;
        if (invocation.arguments.length !== 1 || value === undefined) {
            throw new Error('One complete canonical Machine invocation is required');
        }
        const plan: ExecutionMachinePlan = ExecutionMachineInvocationCodec.resolve(rule, value);
        const selected: ExecutionBinaryPolicy | undefined = [program, ...program.children][
            plan.executableIndex
        ];
        if (selected === undefined || plan.timeoutMs > timeoutMs) {
            throw new Error('Resolved Machine invocation exceeds its local program authority');
        }
        return Object.freeze({
            program: Object.freeze({ path: selected.path, sha256: selected.sha256 }),
            arguments: plan.arguments,
            input: Object.freeze({
                kind: ExecutionBootstrapInputKind.Machine,
                cwd: plan.cwd,
                environment: plan.environment,
                stdin: plan.stdin,
            }),
            timeoutMs: plan.timeoutMs,
            interactive,
        });
    }
}
