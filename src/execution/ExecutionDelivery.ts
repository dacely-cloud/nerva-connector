// SPDX-FileCopyrightText: 2026 Dacely <business@dacely.com>
// SPDX-License-Identifier: LicenseRef-Proprietary

import type { ExecutionDeliveryLink } from './ExecutionDeliveryLink.js';

import { ExecutionOutputDelivery } from './ExecutionOutputDelivery.js';
import { ExecutionInputDelivery } from './ExecutionInputDelivery.js';
import { ExecutionInteractiveRetirementPending } from './ExecutionInteractiveRetirementPending.js';
import {
    ConnectorFrameKind,
    type ConnectorExecutionServerFrame,
    type ConnectorInteractiveServerFrame,
} from '../protocol/ConnectorTransport.js';
import type { ExecutionClient } from './ExecutionClient.js';
import type { ExecutionDeliveryClient } from './ExecutionDeliveryClient.js';
import type {
    ExecutionCompletion,
    ExecutionAcknowledged,
} from 'nerva-connector-protocol/execution/ExecutionJobs.js';
import {
    ExecutionDeliveryChannel,
    type ExecutionPendingDelivery,
} from './ExecutionDeliveryChannel.js';

/** Independent finite start and stop channels share one native owner and deliver one exact result per current connection/original. */
export class ExecutionDelivery<
    Client extends ExecutionDeliveryClient = ExecutionClient,
> implements AsyncDisposable {
    readonly #output: ExecutionOutputDelivery;
    readonly #ordinary: ExecutionDeliveryChannel;
    readonly #stops: ExecutionDeliveryChannel;
    readonly #input: ExecutionInputDelivery;
    #retirement: ExecutionPendingDelivery | null = null;
    #retiring: Promise<void> | null = null;
    #link: ExecutionDeliveryLink | null = null;
    #resultJobId: string | null = null;
    #resultAdmissionHash: string | null = null;
    #closed: boolean = false;
    /** Both channels retain the same durable original rather than creating an interrupt process or a second command. */
    public constructor(public readonly client: Client) {
        this.#output = new ExecutionOutputDelivery(client);
        this.#input = new ExecutionInputDelivery(client, (): void => this.#retryRetirement());
        client.observeInteractive((): void => {
            this.#input.changed();
            this.#retryRetirement();
        });
        const perform: (delivery: ExecutionPendingDelivery) => Promise<void> = async (
            delivery: ExecutionPendingDelivery,
        ): Promise<void> => this.#perform(delivery);
        const failed: (link: ExecutionDeliveryLink) => void = (
            link: ExecutionDeliveryLink,
        ): void => {
            if (this.client.failed) {
                this.#link?.close();
            } else if (link === this.#link) {
                link.close();
            }
        };
        this.#ordinary = new ExecutionDeliveryChannel(perform, failed);
        this.#stops = new ExecutionDeliveryChannel(perform, failed);
    }
    /** Renewal changes result delivery authority, never the original task's execution deadline. */
    public activate(link: ExecutionDeliveryLink): void {
        this.#link = link;
        this.#retirement = null;
        this.#input.activate(link);
        this.#output.activate(link);
        this.#resultJobId = null;
        this.#resultAdmissionHash = null;
        this.#ordinary.activate(link);
        this.#stops.activate(link);
    }
    /** Socket loss is never interpreted as a signed stop. */
    public detach(link: ExecutionDeliveryLink): void {
        this.#output.detach(link);
        this.#input.detach(link);
        if (this.#link === link) {
            this.#link = null;
            this.#retirement = null;
            this.#resultJobId = null;
            this.#resultAdmissionHash = null;
        }
        this.#ordinary.detach(link);
        this.#stops.detach(link);
    }
    /** Stops remain independently bounded and may enter while an ordinary original is awaiting native completion. */
    public receive(
        frame: ConnectorExecutionServerFrame | ConnectorInteractiveServerFrame,
        link: ExecutionDeliveryLink,
    ): void {
        if (this.#closed || this.client.failed || this.#link !== link) {
            throw new Error('Connector execution delivery unavailable');
        }
        if (
            frame.kind === ConnectorFrameKind.ExecutionInteractiveReadyStored ||
            frame.kind === ConnectorFrameKind.ExecutionInputWork
        ) {
            this.#input.receive(frame, link);
            return;
        }
        if (frame.kind === ConnectorFrameKind.ExecutionOutputAck) {
            this.#output.acknowledge(frame.acknowledgment, link);
            return;
        }
        const leaseId: string =
            frame.kind === ConnectorFrameKind.ExecutionPermit
                ? frame.permit.leaseId
                : frame.kind === ConnectorFrameKind.ExecutionCancellation
                  ? frame.cancellation.leaseId
                  : frame.acknowledgment.leaseId;
        if (leaseId !== link.leaseId) {
            throw new Error('Execution delivery lease changed');
        }
        (frame.kind === ConnectorFrameKind.ExecutionCancellation
            ? this.#stops
            : this.#ordinary
        ).receive(frame, link);
    }
    /** Stop and join native work before releasing either channel's bounded session references. */
    public async [Symbol.asyncDispose](): Promise<void> {
        this.#closed = true;
        if (this.#link !== null) {
            this.#output.detach(this.#link);
        }
        this.client.observeOutput(null);
        this.client.observeInteractive(null);
        this.#retirement = null;
        this.#link = null;
        try {
            await this.client[Symbol.asyncDispose]();
        } finally {
            await Promise.all([
                this.#ordinary[Symbol.asyncDispose](),
                this.#stops[Symbol.asyncDispose](),
                this.#input[Symbol.asyncDispose](),
                this.#retiring,
            ]);
        }
    }
    async #perform(delivery: ExecutionPendingDelivery): Promise<void> {
        if (delivery.frame.kind === ConnectorFrameKind.ExecutionAcknowledgment) {
            const previous: Promise<void> | null = this.#retiring;
            if (previous !== null) {
                try {
                    await previous;
                } catch {
                    /** The previous current-link observer already applied its failure policy. */
                }
                if (delivery.link !== this.#link || this.#closed) {
                    return;
                }
            }
            let receipt: ExecutionAcknowledged;
            try {
                receipt = await this.client.acknowledge(
                    delivery.frame.acknowledgment,
                    delivery.link.session,
                );
            } catch (caught: unknown) {
                if (
                    caught instanceof ExecutionInteractiveRetirementPending &&
                    delivery.link === this.#link &&
                    !this.#closed
                ) {
                    this.#retirement = delivery;
                    return;
                }
                throw caught;
            }
            if (this.#retirement === delivery) {
                this.#retirement = null;
            }
            if (delivery.link === this.#link && !this.#closed) {
                delivery.link.send({ kind: ConnectorFrameKind.ExecutionAcknowledged, receipt });
            }
            return;
        }
        const pending: Promise<ExecutionCompletion> =
            delivery.frame.kind === ConnectorFrameKind.ExecutionCancellation
                ? this.client.cancel(delivery.frame.cancellation, delivery.link.session)
                : this.client.execute(delivery.frame.permit, delivery.link.session);
        this.#output.admit(
            delivery.frame.kind === ConnectorFrameKind.ExecutionCancellation
                ? delivery.frame.cancellation
                : delivery.frame.permit,
            delivery.link,
        );
        const completion: ExecutionCompletion = await pending;
        await this.#output.finish(delivery.link);
        if (
            delivery.link === this.#link &&
            !this.#closed &&
            (this.#resultJobId !== completion.jobId ||
                this.#resultAdmissionHash !== completion.admissionHash)
        ) {
            this.#resultJobId = completion.jobId;
            this.#resultAdmissionHash = completion.admissionHash;
            delivery.link.send({ kind: ConnectorFrameKind.ExecutionResult, completion });
        }
    }
    #retryRetirement(): void {
        const delivery: ExecutionPendingDelivery | null = this.#retirement;
        if (
            this.#closed ||
            this.#retiring !== null ||
            delivery === null ||
            delivery.link !== this.#link
        ) {
            return;
        }
        this.#retirement = null;
        const task: Promise<void> = this.#perform(delivery);
        this.#retiring = task;
        void this.#observeRetirement(task, delivery.link);
    }
    async #observeRetirement(task: Promise<void>, link: ExecutionDeliveryLink): Promise<void> {
        try {
            await task;
        } catch {
            if (this.client.failed) {
                this.#link?.close();
            } else if (link === this.#link) {
                link.close();
            }
        } finally {
            if (this.#retiring === task) {
                this.#retiring = null;
            }
        }
    }
}
