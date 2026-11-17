// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

import { createHash } from 'node:crypto';
import { AuthorizedOperationFixture } from './AuthorizedOperationFixture.js';
import { ConnectorAuthorizationProof } from '../../src/protocol/ConnectorAuthorizationProof.js';
import type { ConnectorAuthorization } from 'nerva-connector-protocol/protocol/ConnectorAuthorization.js';
import { ConnectorOperationSchema } from 'nerva-connector-protocol/protocol/ConnectorOperationSchema.js';
import { ExecutionLane } from 'nerva-connector-protocol/execution/ExecutionLane.js';
import { ConnectorAdmissionMigrationProof } from '../../src/protocol/ConnectorAdmissionMigrationProof.js';
import {
    ConnectorMigrationLane,
    type ConnectorMigrationPlan,
    type ConnectorMigrationPlanBody,
    type ConnectorMigrationSource,
    type ConnectorMigrationOriginal,
    type ConnectorMigrationAuthorization,
    type ConnectorMigrationAdmission,
    type ConnectorMigrationApproval,
    type ConnectorMigrationApprovalBody,
    type ConnectorMigrationAppliedBody,
    type ConnectorMigrationTarget,
} from 'nerva-connector-protocol/protocol/ConnectorAdmissionMigration.js';

/** Synthetic stopped encrypted history qualifies immutable metadata/crypto, without claiming any local grant or backend fence. */
export class AdmissionMigrationFixture extends AuthorizedOperationFixture {
    public readonly plan: ConnectorMigrationPlan = ConnectorAdmissionMigrationProof.signPlan(
        this.device,
        this.planBody(),
    );

    /** All three permanent original journal IDs and exact >53-bit watermarks are retained. */
    public planBody(): ConnectorMigrationPlanBody {
        return {
            ...this.expected,
            planId: 'explicit-stopped-plan',
            targetOperationSchema: ConnectorOperationSchema.ExplicitAdmission,
            sources: [
                this.source(ConnectorMigrationLane.Files),
                this.source(ConnectorMigrationLane.ExecutionFirst),
                this.source(ConnectorMigrationLane.ExecutionSecond),
            ],
        };
    }

    /** Public source metadata contains only full-ciphertext commitments and original correlation headers. */
    public source(lane: ConnectorMigrationLane): ConnectorMigrationSource {
        const journalId: string =
            lane === ConnectorMigrationLane.Files
                ? this.descriptor.binding.fileJournalId
                : lane === ConnectorMigrationLane.ExecutionFirst
                  ? this.descriptor.binding.executionJournals.first
                  : this.descriptor.binding.executionJournals.second;
        const requestHash: string =
            lane === ConnectorMigrationLane.Files
                ? this.filePermit().requestHash
                : this.executionPermit(
                      lane === ConnectorMigrationLane.ExecutionFirst
                          ? ExecutionLane.First
                          : ExecutionLane.Second,
                  ).requestHash;
        const original: ConnectorMigrationOriginal = {
            jobId: lane + '-pending',
            sequence: 9007199254740994n,
            dispatchId: this.dispatchId,
            requestHash,
        };
        return {
            lane,
            sourceSha256: createHash('sha256')
                .update('complete-encrypted-source:' + lane)
                .digest('hex'),
            journalId,
            acknowledgedSequence: 9007199254740993n,
            receipt: {
                ...original,
                jobId: lane + '-acknowledged',
                sequence: 9007199254740993n,
                responseHash: createHash('sha256')
                    .update('original-response:' + lane)
                    .digest('hex'),
            },
            pending: original,
        };
    }

    /** Both retained receipt and pending original receive independently explicit authority. */
    public approvalBody(
        plan: ConnectorMigrationPlan = this.plan,
        authorization: ConnectorAuthorization = this.independent,
    ): ConnectorMigrationApprovalBody {
        return {
            plan,
            fenceId: 'durably-fenced-backend-originals',
            authorizations: plan.sources.map(
                (source: ConnectorMigrationSource): ConnectorMigrationAuthorization => ({
                    lane: source.lane,
                    backendSourceSha256: createHash('sha256')
                        .update('backend-snapshot:' + source.lane)
                        .digest('hex'),
                    receipt: this.admission(source.lane, source.receipt, authorization),
                    pending: this.admission(source.lane, source.pending, authorization),
                }),
            ),
        };
    }

    /** Device attestation retains original complete signed certificate hashes without inventing any ACK. */
    public appliedBody(approval: ConnectorMigrationApproval): ConnectorMigrationAppliedBody {
        return {
            planSha256: ConnectorAdmissionMigrationProof.planSha256(approval.plan),
            approvalSha256: ConnectorAdmissionMigrationProof.approvalSha256(approval),
            targets: approval.plan.sources.map(
                (source: ConnectorMigrationSource): ConnectorMigrationTarget => ({
                    lane: source.lane,
                    plainSha256: createHash('sha256')
                        .update('exact-converted-plaintext:' + source.lane)
                        .digest('hex'),
                    cipherSha256: createHash('sha256')
                        .update('exact-converted-ciphertext:' + source.lane)
                        .digest('hex'),
                }),
            ),
        };
    }

    /** Receiver-selected lane is distinct from every untrusted original hash and authorization body. */
    public admission(
        lane: ConnectorMigrationLane,
        original: ConnectorMigrationOriginal | null,
        authorization: ConnectorAuthorization,
    ): ConnectorMigrationAdmission | null {
        if (original === null) {
            return null;
        }
        return {
            authorization,
            admissionHash:
                lane === ConnectorMigrationLane.Files
                    ? ConnectorAuthorizationProof.file(original.requestHash, authorization)
                    : ConnectorAuthorizationProof.execution(
                          original.requestHash,
                          lane === ConnectorMigrationLane.ExecutionFirst
                              ? ExecutionLane.First
                              : ExecutionLane.Second,
                          authorization,
                      ),
        };
    }
}
