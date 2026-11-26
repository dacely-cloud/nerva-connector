// SPDX-FileCopyrightText: 2026 Dacely <business@dacely.com>
// SPDX-License-Identifier: LicenseRef-Proprietary

import { Boundary } from 'nerva-connector-protocol/protocol/Boundary.js';
import type { ConnectorProgressCodec } from '../runtime/ConnectorProgressCodec.js';
import type { ExecutionRequest } from 'nerva-connector-protocol/execution/ExecutionJobs.js';
import type { ExecutionResult } from 'nerva-connector-protocol/execution/ExecutionTypes.js';
import type { ExecutionOutput } from 'nerva-connector-protocol/execution/ExecutionOutput.js';
import {
    ConnectorEffectKind,
    type ConnectorEffectContext,
} from '../runtime/ConnectorEffectContext.js';

/** Exact original journal ownership and append-only binary prefixes protect output through process replacement. */
export class ExecutionOutputCodec implements ConnectorProgressCodec<
    ExecutionRequest,
    ExecutionResult,
    ExecutionOutput
> {
    /** Decrypted output must be canonical, finite and nonempty before becoming retained progress. */
    public read(
        raw: unknown,
        _request: ExecutionRequest,
        context: ConnectorEffectContext,
    ): ExecutionOutput {
        if (
            context.kind === ConnectorEffectKind.ExecutionNotStarted ||
            ((context.kind === ConnectorEffectKind.CapturedExecution ||
                context.kind === ConnectorEffectKind.CapturedInteractiveExecution) &&
                context.group === null)
        ) {
            throw new Error('Command output precedes committed process group authority');
        }
        const value: Readonly<Record<string, unknown>> = Boundary.record(raw, [
            'stdoutBase64',
            'stderrBase64',
        ]);
        const output: ExecutionOutput = ExecutionOutputCodec.output(value);
        if (output.stdoutBase64 === '' && output.stderrBase64 === '') {
            throw new Error('Empty execution progress');
        }
        return output;
    }
    /** Repeated prefixes are harmless; replacement or truncation of either byte stream is forbidden. */
    public advance(previous: ExecutionOutput | null, next: ExecutionOutput): void {
        if (previous !== null) {
            this.#prefix(previous, next);
        }
    }
    /** Terminal compaction can discard the intermediate copy only when the final bytes preserve both prefixes. */
    public finish(progress: ExecutionOutput, response: ExecutionResult): void {
        this.#prefix(progress, response);
    }
    #prefix(progress: ExecutionOutput, response: ExecutionOutput): void {
        for (const key of ['stdoutBase64', 'stderrBase64'] as const) {
            const prefix: Buffer = Buffer.from(progress[key], 'base64');
            const final: Buffer = Buffer.from(response[key], 'base64');
            if (!final.subarray(0, prefix.byteLength).equals(prefix)) {
                throw new Error('Retained execution output changed');
            }
        }
    }
    /** Results and intermediate prefixes use the same canonical aggregate byte budget. */
    public static output(value: Readonly<Record<string, unknown>>): ExecutionOutput {
        const stdoutBase64: string = this.#bytes(value['stdoutBase64']);
        const stderrBase64: string = this.#bytes(value['stderrBase64']);
        if (
            Buffer.byteLength(stdoutBase64, 'base64') + Buffer.byteLength(stderrBase64, 'base64') >
            65536
        ) {
            throw new Error('Execution output exceeds its bound');
        }
        return { stdoutBase64, stderrBase64 };
    }
    static #bytes(raw: unknown): string {
        if (typeof raw !== 'string' || raw.length > 87384) {
            throw new Error('Execution output exceeds its bound');
        }
        const bytes: Buffer = Buffer.from(raw, 'base64');
        if (bytes.byteLength > 65536 || bytes.toString('base64') !== raw) {
            throw new Error('Invalid canonical execution output');
        }
        return raw;
    }
}
