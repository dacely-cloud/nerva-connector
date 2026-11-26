// SPDX-FileCopyrightText: 2026 Dacely <business@dacely.com>
// SPDX-License-Identifier: LicenseRef-Proprietary

import { SigningKey } from '../identity/SigningKey.js';
import { SignaturePurpose } from 'nerva-connector-protocol/identity/IdentityFormat.js';
import { ExecutionJobsCodec } from './ExecutionJobsCodec.js';
import { ExecutionProof } from 'nerva-connector-protocol/execution/ExecutionProof.js';
import type {
    ExecutionCompletion,
    ExecutionAcknowledgment,
    ExecutionPermit,
} from 'nerva-connector-protocol/execution/ExecutionJobs.js';
import type { ExecutionInteractiveReady } from 'nerva-connector-protocol/execution/ExecutionInteractive.js';
import { ExecutionInputJournalValidation } from './ExecutionInputJournalValidation.js';
import {
    ExecutionInputJournalPhase,
    type ExecutionInputJournalRecordState,
    type ExecutionInputJournalTerminal,
} from './ExecutionInputJournalTypes.js';

/** Cursor reuse requires genuine terminal/authority commitments; a local boolean cannot authorize compaction. */
export class ExecutionInputJournalTerminalProof {
    public static verify(
        validation: ExecutionInputJournalValidation,
        state: ExecutionInputJournalRecordState,
        result: ExecutionCompletion,
        ack: ExecutionAcknowledgment,
    ): ExecutionInputJournalTerminal {
        const completion: ExecutionCompletion = ExecutionJobsCodec.completion(
            JSON.parse(ExecutionJobsCodec.encode(result)),
        );
        const acknowledgment: ExecutionAcknowledgment = ExecutionJobsCodec.acknowledgment(
            JSON.parse(ExecutionJobsCodec.encode(ack)),
        );
        const original: ExecutionInteractiveReady | ExecutionPermit =
            state.phase === ExecutionInputJournalPhase.Ready
                ? state.admission.ready
                : state.preparation.permit;
        for (const value of [completion, acknowledgment]) {
            if (
                value.environmentId !== original.environmentId ||
                value.enrollmentId !== original.enrollmentId ||
                value.lane !== original.lane ||
                value.jobId !== original.jobId ||
                value.sequence !== original.sequence ||
                value.dispatchId !== original.dispatchId ||
                value.requestHash !== original.requestHash ||
                value.admissionHash !== original.admissionHash ||
                value.responseHash !== completion.responseHash
            ) {
                throw new Error('Interactive terminal commitment changed its exact original');
            }
        }
        if (
            acknowledgment.authorityId !== original.authorityId ||
            completion.leaseId !== acknowledgment.leaseId ||
            ExecutionProof.responseHash(completion.response) !== completion.responseHash ||
            !SigningKey.verify(
                SignaturePurpose.OperationExecutionResult,
                validation.identity.publicKey,
                ExecutionProof.completion(completion),
                completion.signature,
            ) ||
            !SigningKey.verify(
                SignaturePurpose.OperationExecutionAcknowledgment,
                validation.identity.authority.publicKey,
                ExecutionProof.acknowledgment(acknowledgment),
                acknowledgment.signature,
            )
        ) {
            throw new Error('Interactive terminal requires both genuine signed proofs');
        }
        return Object.freeze({
            completionSha256: ExecutionProof.digest(ExecutionJobsCodec.encode(completion)),
            acknowledgmentSha256: ExecutionProof.digest(ExecutionJobsCodec.encode(acknowledgment)),
            responseHash: completion.responseHash,
        });
    }
}
