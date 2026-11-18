// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

import { ConnectorClock } from '../protocol/ConnectorClock.js';
import { ConnectorClientSession } from '../runtime/ConnectorClientSession.js';
import type { ConnectorClientIdentity } from '../runtime/ConnectorClientConfiguration.js';
import type { ConnectorOperationJournal } from '../runtime/ConnectorOperationJournal.js';
import type {
    ExecutionPermit,
    ExecutionRequest,
} from 'nerva-connector-protocol/execution/ExecutionJobs.js';
import { ExecutionJobsCodec } from './ExecutionJobsCodec.js';
import type { ExecutionResult } from 'nerva-connector-protocol/execution/ExecutionTypes.js';
import type { ExecutionOutput } from 'nerva-connector-protocol/execution/ExecutionOutput.js';

/** Reuses captured verified start authority across local awaits without renewing it or bounding already-running lifetime. */
export class ExecutionLaunchAdmission {
    readonly #permit: ExecutionPermit;
    readonly #identity: ConnectorClientIdentity;
    /** Native setup receives this same immutable absolute host-clock expiry. */
    public readonly expiresAtMs: bigint;
    public constructor(
        permit: ExecutionPermit,
        public readonly session: ConnectorClientSession,
        public readonly journal: ConnectorOperationJournal<
            ExecutionRequest,
            ExecutionResult,
            ExecutionOutput
        >,
        public readonly signal: AbortSignal,
    ) {
        this.#permit = ExecutionJobsCodec.permit(JSON.parse(ExecutionJobsCodec.encode(permit)));
        this.#identity = session.identity;
        this.expiresAtMs =
            this.#permit.expiresAtMs < this.#permit.executionDeadlineMs
                ? this.#permit.expiresAtMs
                : this.#permit.executionDeadlineMs;
    }
    /** Only the same current lease and captured main original may cross another pre-execution boundary. */
    public assert(): void {
        this.signal.throwIfAborted();
        const now: bigint = BigInt(Date.now());
        const lease: ReturnType<typeof ConnectorClientSession.current> =
            ConnectorClientSession.current(this.session, now);
        const permit: ExecutionPermit = this.#permit;
        const pending: typeof this.journal.pending = this.journal.pending;
        if (
            this.session.identity !== this.#identity ||
            now >= this.expiresAtMs ||
            !ConnectorClock.issued(permit.issuedAtMs, now) ||
            permit.issuedAtMs < lease.issuedAtMs ||
            permit.expiresAtMs > lease.expiresAtMs ||
            lease.leaseId !== permit.leaseId ||
            lease.authorityId !== permit.authorityId ||
            lease.environmentId !== permit.environmentId ||
            lease.enrollmentId !== permit.enrollmentId ||
            lease.slot !== 0 ||
            pending === null ||
            pending.response !== null ||
            pending.jobId !== permit.jobId ||
            pending.sequence !== permit.sequence ||
            pending.dispatchId !== permit.dispatchId ||
            pending.requestHash !== permit.requestHash ||
            pending.admissionHash !== permit.admissionHash
        ) {
            throw new Error('Captured execution launch authority expired or changed');
        }
    }
}
