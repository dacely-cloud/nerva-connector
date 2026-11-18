// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

import { ConnectorClock } from '../protocol/ConnectorClock.js';
import { SigningKey } from '../identity/SigningKey.js';
import { SignaturePurpose } from 'nerva-connector-protocol/identity/IdentityFormat.js';
import { ConnectorAuthorizationProof } from 'nerva-connector-protocol/protocol/ConnectorAuthorizationProof.js';
import type { ConnectorClientSession } from '../runtime/ConnectorClientSession.js';
import type {
    ExecutionPermit,
    ExecutionCancellation,
} from 'nerva-connector-protocol/execution/ExecutionJobs.js';
import { ExecutionJobsCodec } from './ExecutionJobsCodec.js';
import { ExecutionProof } from 'nerva-connector-protocol/execution/ExecutionProof.js';
import { ExecutionInteractiveLaunchCodec } from 'nerva-connector-protocol/execution/ExecutionInteractiveLaunchCodec.js';
import type { ExecutionInputRecordCodec } from './ExecutionInputRecordCodec.js';
import {
    ExecutionInputJournalSchema,
    ExecutionInputJournalPhase,
    type ExecutionInputJournalRecordState,
    type ExecutionInputJournalPreparedState,
    type ExecutionInputJournalPreparation,
    type ExecutionInputJournalAdmission,
    type ExecutionInputJournalState,
} from './ExecutionInputJournalTypes.js';

/** Phase transitions validate original authority without tying native ownership to a transport observer. */
export class ExecutionInputJournalLifecycle {
    public constructor(public readonly codec: ExecutionInputRecordCodec) {}

    /** A newly admitted main original durably captures its intent before the kernel group can be committed. */
    public prepare(
        previous: ExecutionInputJournalRecordState | null,
        input: ExecutionInputJournalPreparation,
        session: ConnectorClientSession,
        nowMs: bigint,
    ): ExecutionInputJournalPreparedState {
        const preparation: ExecutionInputJournalPreparation = this.codec.preparation.capture(input);
        this.codec.preparation.fresh(preparation, session, nowMs);
        if (previous !== null) {
            const original: typeof preparation.permit | ExecutionInputJournalAdmission['ready'] =
                previous.phase === ExecutionInputJournalPhase.Ready
                    ? previous.admission.ready
                    : previous.preparation.permit;
            const incarnation: string =
                previous.phase === ExecutionInputJournalPhase.Ready
                    ? previous.admission.ready.incarnation
                    : previous.preparation.incarnation;
            if (
                previous.terminal === null ||
                original.sequence >= preparation.permit.sequence ||
                original.jobId === preparation.permit.jobId ||
                incarnation === preparation.incarnation
            ) {
                throw new Error(
                    'Interactive lane cannot replace an active or previously used original',
                );
            }
        }
        return Object.freeze({
            schema: ExecutionInputJournalSchema.Cursor,
            phase: ExecutionInputJournalPhase.Prepared,
            scope: this.codec.validation.scope,
            preparation,
            ownerLost: false,
            terminal: null,
        });
    }
    /** Only exact first native evidence can replace preparation; start-permit expiry and observer loss grant no new authority. */
    public ready(
        previous: ExecutionInputJournalRecordState | null,
        input: ExecutionInputJournalAdmission,
    ): ExecutionInputJournalState {
        const admission: ExecutionInputJournalAdmission = this.codec.validation.admission(input);
        if (
            previous === null ||
            previous.phase !== ExecutionInputJournalPhase.Prepared ||
            previous.ownerLost ||
            previous.terminal !== null
        ) {
            throw new Error('Genuine Ready requires its original durable preparation');
        }
        const prepared: ExecutionInputJournalPreparation = previous.preparation;
        const original: typeof prepared.permit = prepared.permit;
        const ready: typeof admission.ready = admission.ready;
        if (
            ready.authorityId !== original.authorityId ||
            ready.environmentId !== original.environmentId ||
            ready.enrollmentId !== original.enrollmentId ||
            ready.lane !== original.lane ||
            ready.jobId !== original.jobId ||
            ready.sequence !== original.sequence ||
            ready.dispatchId !== original.dispatchId ||
            ready.requestHash !== original.requestHash ||
            ready.admissionHash !== original.admissionHash ||
            ready.incarnation !== prepared.incarnation ||
            admission.policySha256 !== original.request.policySha256 ||
            this.codec.validation.json(admission.rule) !==
                this.codec.validation.json(prepared.rule) ||
            ExecutionInteractiveLaunchCodec.encode(admission.rule, admission.launch) !==
                ExecutionInteractiveLaunchCodec.encode(prepared.rule, prepared.launch)
        ) {
            throw new Error('Native Ready changed its exact prepared original or execution window');
        }
        return Object.freeze({
            schema: ExecutionInputJournalSchema.Cursor,
            phase: ExecutionInputJournalPhase.Ready,
            scope: this.codec.validation.scope,
            admission,
            writerGeneration: 0n,
            cursor: this.codec.cursor.initial(admission),
            ownerLost: false,
            inputStopped: false,
            pending: null,
            last: null,
            terminal: null,
        });
    }
    /** Recovery is authenticated to the current exact main original without creating or refreshing native execution authority. */
    public original(
        state: ExecutionInputJournalRecordState,
        value: ExecutionPermit | ExecutionCancellation,
        session: ConnectorClientSession,
        nowMs: bigint,
    ): void {
        const permit: ExecutionPermit | null =
            'executionDeadlineMs' in value
                ? ExecutionJobsCodec.permit(JSON.parse(ExecutionJobsCodec.encode(value)))
                : null;
        const current: ExecutionCancellation =
            permit ?? ExecutionJobsCodec.cancellation(JSON.parse(ExecutionJobsCodec.encode(value)));
        const proof: Buffer =
            permit === null ? ExecutionProof.cancellation(current) : ExecutionProof.permit(permit);
        const original: ExecutionInputJournalAdmission['ready'] | ExecutionPermit =
            state.phase === ExecutionInputJournalPhase.Ready
                ? state.admission.ready
                : state.preparation.permit;
        const launch: ExecutionInputJournalAdmission['launch'] =
            state.phase === ExecutionInputJournalPhase.Ready
                ? state.admission.launch
                : state.preparation.launch;
        const rule: ExecutionInputJournalAdmission['rule'] =
            state.phase === ExecutionInputJournalPhase.Ready
                ? state.admission.rule
                : state.preparation.rule;
        const policySha256: string =
            state.phase === ExecutionInputJournalPhase.Ready
                ? state.admission.policySha256
                : state.preparation.permit.request.policySha256;
        const lease: ReturnType<ExecutionInputRecordCodec['validation']['current']> =
            this.codec.validation.current(session, nowMs);
        if (
            current.authorityId !== original.authorityId ||
            current.environmentId !== original.environmentId ||
            current.enrollmentId !== original.enrollmentId ||
            current.lane !== original.lane ||
            current.jobId !== original.jobId ||
            current.sequence !== original.sequence ||
            current.dispatchId !== original.dispatchId ||
            current.requestHash !== original.requestHash ||
            current.admissionHash !== original.admissionHash ||
            current.leaseId !== lease.leaseId ||
            current.issuedAtMs < lease.issuedAtMs ||
            !ConnectorClock.issued(current.issuedAtMs, nowMs) ||
            current.expiresAtMs <= nowMs ||
            current.expiresAtMs > lease.expiresAtMs ||
            current.request.policySha256 !== policySha256 ||
            current.request.arguments.length !== 1 ||
            current.request.arguments[0] !== ExecutionInteractiveLaunchCodec.encode(rule, launch) ||
            ExecutionProof.requestHash(current.request) !== current.requestHash ||
            ConnectorAuthorizationProof.execution(
                current.requestHash,
                current.lane,
                current.authorization,
            ) !== current.admissionHash ||
            (permit !== null && permit.executionDeadlineMs !== launch.executionDeadlineMs) ||
            !SigningKey.verify(
                permit !== null
                    ? SignaturePurpose.OperationExecutionPermit
                    : SignaturePurpose.OperationExecutionCancellation,
                this.codec.validation.identity.authority.publicKey,
                proof,
                current.signature,
            )
        ) {
            throw new Error('Recovered input changed its current authenticated main original');
        }
    }
}
