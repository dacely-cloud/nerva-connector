// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

import type { ExecutionDeliveryClient } from './ExecutionDeliveryClient.js';
import type { ExecutionDeliveryLink } from './ExecutionDeliveryLink.js';
import type {
    ExecutionPermit,
    ExecutionCancellation,
} from 'nerva-connector-protocol/execution/ExecutionJobs.js';
import type {
    ExecutionOutputUpdate,
    ExecutionOutputAck,
} from 'nerva-connector-protocol/execution/ExecutionOutput.js';
import { ConnectorFrameKind } from '../protocol/ConnectorTransport.js';

/** One acknowledged prefix in flight bounds signing/network work; all newer output remains in the durable journal. */
export class ExecutionOutputDelivery {
    #link: ExecutionDeliveryLink | null = null;
    #original: ExecutionPermit | ExecutionCancellation | null = null;
    #sent: ExecutionOutputUpdate | null = null;
    #acknowledged: string | null = null;
    #idle: PromiseWithResolvers<undefined> = Promise.withResolvers<undefined>();
    /** Network failure closes delivery without aborting or replaying the native original. */
    public constructor(public readonly client: ExecutionDeliveryClient) {
        this.#idle.resolve(undefined);
        client.observeOutput((): void => this.changed());
    }
    /** A replacement connection must receive its own original permit before exposing retained output. */
    public activate(link: ExecutionDeliveryLink): void {
        this.#idle.resolve(undefined);
        this.#link = link;
        this.#original = null;
        this.#sent = null;
        this.#acknowledged = null;
    }
    /** Late replies release only the detached connection's delivery wait. */
    public detach(link: ExecutionDeliveryLink): void {
        if (this.#link === link) {
            this.#link = null;
            this.#original = null;
            this.#sent = null;
            this.#idle.resolve(undefined);
        }
    }
    /** Only a current lane delivery may inspect the retained matching original. */
    public admit(
        original: ExecutionPermit | ExecutionCancellation,
        link: ExecutionDeliveryLink,
    ): void {
        if (this.#link === link) {
            if (
                this.#original !== null &&
                this.#original.jobId === original.jobId &&
                this.#original.admissionHash !== original.admissionHash
            ) {
                throw new Error('Execution output admission changed');
            }
            if (this.#original?.jobId !== original.jobId) {
                this.#acknowledged = null;
            }
            this.#original = original;
            this.changed();
        }
    }
    /** Repeated pipe activity creates no frame queue while the prior prefix is awaiting durable acknowledgment. */
    public changed(): void {
        const link: ExecutionDeliveryLink | null = this.#link;
        if (link === null || this.#original === null || this.#sent !== null) {
            return;
        }
        try {
            const update: ExecutionOutputUpdate | null = this.client.output(
                this.#original,
                link.session,
                this.#acknowledged,
            );
            if (update === null || update.outputHash === this.#acknowledged) {
                return;
            }
            this.#idle = Promise.withResolvers<undefined>();
            this.#sent = update;
            link.send({ kind: ConnectorFrameKind.ExecutionOutput, update });
        } catch {
            link.close();
        }
    }
    /** Both pinned backend signatures must match the exact current in-flight prefix before returning credit. */
    public acknowledge(ack: ExecutionOutputAck, link: ExecutionDeliveryLink): void {
        if (this.#link !== link || this.#sent === null) {
            throw new Error('No execution output in flight');
        }
        this.client.verifyOutputAck(ack, this.#sent, link.session);
        this.#acknowledged = this.#sent.outputHash;
        this.#sent = null;
        this.#idle.resolve(undefined);
        this.changed();
    }
    /** Final result transmission waits for the latest retained bytes or releases promptly on connection replacement. */
    public async finish(link: ExecutionDeliveryLink): Promise<void> {
        this.changed();
        while (this.#link === link && this.#sent !== null) {
            await this.#idle.promise;
        }
    }
}
