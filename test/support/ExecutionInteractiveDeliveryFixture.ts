// SPDX-FileCopyrightText: 2026 Dacely <business@dacely.com>
// SPDX-License-Identifier: LicenseRef-Proprietary

import type { ExecutionDeliveryClient } from '../../src/execution/ExecutionDeliveryClient.js';
import type { ExecutionInteractiveOwnershipFixture } from './ExecutionInteractiveOwnershipFixture.js';
import { ConnectorClientSession } from '../../src/runtime/ConnectorClientSession.js';
import type { ExecutionInputWorkCapture } from 'nerva-connector-protocol/execution/ExecutionInputWorkCapture.js';
import type { ExecutionInteractiveDeliveryReply } from '../../src/execution/ExecutionInteractiveOwnershipTypes.js';
import type { ExecutionInteractiveReady } from 'nerva-connector-protocol/execution/ExecutionInteractive.js';
import type {
    ExecutionAcknowledgment,
    ExecutionAcknowledged,
    ExecutionCompletion,
} from 'nerva-connector-protocol/execution/ExecutionJobs.js';
import { ExecutionProof } from 'nerva-connector-protocol/execution/ExecutionProof.js';
import { SignaturePurpose } from 'nerva-connector-protocol/identity/IdentityFormat.js';

/** An explicit delivery port borrows real kernel/encrypted ownership without enabling an installed interactive policy. */
export class ExecutionInteractiveDeliveryFixture implements ExecutionDeliveryClient {
    public constructor(public readonly fixture: ExecutionInteractiveOwnershipFixture) {}
    /** Actual journal/native failure is never replaced by fixture connection state. */
    public get failed(): boolean {
        return this.fixture.owner.failed;
    }
    /** Existing output flow is outside this terminal input-ordering fixture. */
    public observeOutput(_observer: (() => void) | null): void {}
    /** Input reply progress drives the real delivery retirement continuation in this fixture. */
    public observeInteractive(_observer: (() => void) | null): void {}
    /** The real owner verifies current mutual authority before exposing its first proof. */
    public interactiveReady(session: ConnectorClientSession): ExecutionInteractiveReady | null {
        return this.fixture.owner.ready(session);
    }
    /** Signature/current-session checks and all native/durable effects use the production input owner. */
    public async input(
        work: ExecutionInputWorkCapture,
        session: ConnectorClientSession,
    ): Promise<ExecutionInteractiveDeliveryReply> {
        return await this.fixture.owner.input(work, session);
    }
    /** This already-completed test original has no provisional output delivery. */
    public output(): null {
        return null;
    }
    /** Unexpected output credit must fail instead of weakening output proof checks. */
    public verifyOutputAck(): never {
        throw new Error('No output admission in terminal fixture');
    }
    /** Native admission occurred only in the owning real fixture. */
    public execute(): Promise<ExecutionCompletion> {
        return Promise.reject(new Error('No fresh execution in terminal fixture'));
    }
    /** This fixture stops its owned probe before supplying any terminal acknowledgment. */
    public cancel(): Promise<ExecutionCompletion> {
        return Promise.reject(new Error('No cancellation delivery in terminal fixture'));
    }
    /** Current lease wrappers retain the exact actual main response and genuine device signature. */
    public completion(session: ConnectorClientSession): ExecutionCompletion {
        const response: typeof this.fixture.main.pending = this.fixture.main.pending;
        if (response?.response === null || response?.response === undefined) {
            throw new Error('Actual durable main result required');
        }
        const { signature: _signature, ...original }: ExecutionCompletion = this.fixture.completion(
            response.response,
        );
        const body: Omit<ExecutionCompletion, 'signature'> = {
            ...original,
            leaseId: ConnectorClientSession.current(session, BigInt(Date.now())).leaseId,
        };
        return {
            ...body,
            signature: this.fixture.signed.peer.device.sign(
                SignaturePurpose.OperationExecutionResult,
                ExecutionProof.completion(body),
            ),
        };
    }
    /** Both input retirement and main compaction must really commit before signing the device receipt. */
    public async acknowledge(
        ack: ExecutionAcknowledgment,
        session: ConnectorClientSession,
    ): Promise<ExecutionAcknowledged> {
        await this.fixture.owner.retire(this.completion(session), ack, session);
        await this.fixture.main.acknowledge(ack);
        const {
            authorityId: _authorityId,
            signature: _signature,
            ...body
        }: ExecutionAcknowledgment = ack;
        return {
            ...body,
            signature: this.fixture.signed.peer.device.sign(
                SignaturePurpose.OperationExecutionAcknowledged,
                ExecutionProof.acknowledged(body),
            ),
        };
    }
    /** The enclosing fixture alone owns native tasks, journals and keys. */
    public async [Symbol.asyncDispose](): Promise<void> {
        await Promise.resolve();
    }
}
