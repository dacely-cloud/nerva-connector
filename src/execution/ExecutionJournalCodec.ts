// SPDX-FileCopyrightText: 2026 Dacely <business@dacely.com>
// SPDX-License-Identifier: LicenseRef-Proprietary

import type { ConnectorAuthorization } from 'nerva-connector-protocol/protocol/ConnectorAuthorization.js';
import { ConnectorAuthorizationProof } from 'nerva-connector-protocol/protocol/ConnectorAuthorizationProof.js';
import {
    ConnectorEffectKind,
    type ConnectorEffectContext,
} from '../runtime/ConnectorEffectContext.js';
import { ConnectorEffectContextCodec } from '../runtime/ConnectorEffectContextCodec.js';
import {
    ConnectorOperationPurpose,
    type ConnectorOperationCodec,
} from '../runtime/ConnectorOperationCodec.js';
import { type ExecutionRequest } from 'nerva-connector-protocol/execution/ExecutionJobs.js';
import { ExecutionLane } from 'nerva-connector-protocol/execution/ExecutionLane.js';
import {
    ExecutionFailure,
    ExecutionTermination,
    type ExecutionResult,
} from 'nerva-connector-protocol/execution/ExecutionTypes.js';
import { ExecutionProof } from 'nerva-connector-protocol/execution/ExecutionProof.js';
import { ExecutionJobsCodec } from './ExecutionJobsCodec.js';
import { ExecutionResultCodec } from './ExecutionResultCodec.js';
import { ExecutionOutputCodec } from './ExecutionOutputCodec.js';
import type { ExecutionOutput } from 'nerva-connector-protocol/execution/ExecutionOutput.js';

/** Command state uses the shared durable owner with separate keys, lock, storage and validated execution semantics. */
export class ExecutionJournalCodec implements ConnectorOperationCodec<
    ExecutionRequest,
    ExecutionResult,
    ExecutionOutput
> {
    /** Progress and terminal output share one encrypted atomic record and one original dispatch. */
    public readonly progress: ExecutionOutputCodec = new ExecutionOutputCodec();
    /** File state and its encryption key can never be used as execution history. */
    public readonly purpose: ConnectorOperationPurpose;
    /** The local lane is part of encryption authority; relabeling a state directory cannot adopt another lane's watermark. */
    public constructor(public readonly lane: ExecutionLane) {
        if (lane === ExecutionLane.First) {
            this.purpose = ConnectorOperationPurpose.ExecutionFirst;
        } else if (lane === ExecutionLane.Second) {
            this.purpose = ConnectorOperationPurpose.ExecutionSecond;
        } else {
            throw new Error('Invalid execution journal lane');
        }
    }
    /** Decrypted requests must identify one exact granted program/root/argument payload. */
    public request(raw: unknown): ExecutionRequest {
        return ExecutionJobsCodec.request(raw);
    }
    /** Captured authority must match the original request; historical tags never establish physical cleanup permission. */
    public effectContext(raw: unknown, request: ExecutionRequest): ConnectorEffectContext {
        const context: ConnectorEffectContext = ConnectorEffectContextCodec.read(raw);
        if (
            context.kind === ConnectorEffectKind.IndependentExecution ||
            context.kind === ConnectorEffectKind.HistoricalUnproven ||
            context.kind === ConnectorEffectKind.ExecutionNotStarted
        ) {
            return context;
        }
        if (
            (context.kind === ConnectorEffectKind.CapturedExecution ||
                context.kind === ConnectorEffectKind.CapturedInteractiveExecution) &&
            context.policySha256 === request.policySha256 &&
            context.rootId === request.rootId
        ) {
            return context;
        }
        throw new Error('Execution history cannot adopt a file effect context');
    }
    /** Indeterminate and terminal states retain their strict output bounds after a restart. */
    public response(
        raw: unknown,
        _request: ExecutionRequest,
        context: ConnectorEffectContext,
    ): ExecutionResult {
        const result: ExecutionResult = ExecutionResultCodec.read(raw);
        if (
            context.kind === ConnectorEffectKind.ExecutionNotStarted ||
            ((context.kind === ConnectorEffectKind.CapturedExecution ||
                context.kind === ConnectorEffectKind.CapturedInteractiveExecution) &&
                context.group === null)
        ) {
            if (
                result.termination !== ExecutionTermination.Indeterminate ||
                result.exitCode !== null ||
                result.stdoutBase64 !== '' ||
                result.stderrBase64 !== '' ||
                result.setupFailure !== null ||
                (context.kind === ConnectorEffectKind.ExecutionNotStarted &&
                    result.failure !== ExecutionFailure.Cancelled &&
                    result.failure !== ExecutionFailure.Expired &&
                    result.failure !== ExecutionFailure.Interrupted)
            ) {
                throw new Error('Command result precedes committed process group authority');
            }
        }
        return result;
    }
    /** Existing history cannot change command arguments under an original dispatch. */
    public requestHash(request: ExecutionRequest): string {
        return ExecutionProof.requestHash(request);
    }
    /** The concrete receiver fixes the operation channel and lane independently of untrusted envelope fields. */
    public admissionHash(requestHash: string, authorization: ConnectorAuthorization): string {
        return ConnectorAuthorizationProof.execution(requestHash, this.lane, authorization);
    }
    /** Retained output and failure classification are committed together. */
    public responseHash(response: ExecutionResult): string {
        return ExecutionProof.responseHash(response);
    }
}
