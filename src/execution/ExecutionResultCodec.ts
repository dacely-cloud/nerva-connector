// SPDX-FileCopyrightText: 2026 Dacely <business@dacely.com>
// SPDX-License-Identifier: LicenseRef-Proprietary

import { Boundary } from 'nerva-connector-protocol/protocol/Boundary.js';
import { ExecutionOutputCodec } from './ExecutionOutputCodec.js';
import type { ExecutionOutput } from 'nerva-connector-protocol/execution/ExecutionOutput.js';
import {
    ExecutionTermination,
    ExecutionFailure,
    ExecutionSetupFailure,
    type ExecutionResult,
} from 'nerva-connector-protocol/execution/ExecutionTypes.js';

/** Untrusted remote or retained results must have finite canonical bytes and internally consistent terminal state. */
export class ExecutionResultCodec {
    /** Indeterminate outcomes never contain a successful exit code; setup diagnostics cannot smuggle raw host messages. */
    public static read(raw: unknown): ExecutionResult {
        const value: Readonly<Record<string, unknown>> = Boundary.record(raw, [
            'setupFailure',
            'termination',
            'failure',
            'exitCode',
            'stdoutBase64',
            'stderrBase64',
        ]);
        const termination: ExecutionTermination | undefined = Object.values(
            ExecutionTermination,
        ).find((entry: ExecutionTermination): boolean => entry === value['termination']);
        const failure: ExecutionFailure | null | undefined =
            value['failure'] === null
                ? null
                : Object.values(ExecutionFailure).find(
                      (entry: ExecutionFailure): boolean => entry === value['failure'],
                  );
        const setupFailure: ExecutionSetupFailure | null | undefined =
            value['setupFailure'] === null
                ? null
                : Object.values(ExecutionSetupFailure).find(
                      (entry: ExecutionSetupFailure): boolean => entry === value['setupFailure'],
                  );
        const exitCode: number | null =
            value['exitCode'] === null ? null : Boundary.count(value['exitCode'], 127);
        const output: ExecutionOutput = ExecutionOutputCodec.output(value);
        const { stdoutBase64, stderrBase64 }: ExecutionOutput = output;
        if (
            termination === undefined ||
            failure === undefined ||
            setupFailure === undefined ||
            (termination === ExecutionTermination.Exited
                ? failure !== null || setupFailure !== null || exitCode === null || exitCode === 125
                : failure === null || exitCode !== null) ||
            (setupFailure !== null &&
                (failure !== ExecutionFailure.Sandbox ||
                    stdoutBase64 !== '' ||
                    stderrBase64 !== '')) ||
            (failure === ExecutionFailure.Expired && (stdoutBase64 !== '' || stderrBase64 !== ''))
        ) {
            throw new Error('Invalid execution terminal result');
        }
        return { setupFailure, termination, failure, exitCode, stdoutBase64, stderrBase64 };
    }

    /** Exact normalized property order is shared by signatures and encrypted state. */
    public static encode(value: ExecutionResult): string {
        return JSON.stringify(value);
    }

    /** Recovery is conservative: a started command without a saved result may already have changed its workspace. */
    public static interrupted(
        failure:
            | ExecutionFailure.Interrupted
            | ExecutionFailure.Expired
            | ExecutionFailure.Sandbox
            | ExecutionFailure.Cancelled,
    ): ExecutionResult {
        return {
            setupFailure: null,
            termination: ExecutionTermination.Indeterminate,
            failure,
            exitCode: null,
            stdoutBase64: '',
            stderrBase64: '',
        };
    }
}
