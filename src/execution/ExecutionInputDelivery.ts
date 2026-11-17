// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

import {
    ConnectorFrameKind,
    type ConnectorInteractiveServerFrame,
} from '../protocol/ConnectorTransport.js';
import {
    ConnectorInteractiveProtocol,
    type ConnectorInteractiveReadyEnvelope,
} from 'nerva-connector-protocol/protocol/ConnectorInteractiveProtocol.js';
import type { ConnectorClientSession } from '../runtime/ConnectorClientSession.js';
import type { ExecutionDeliveryLink } from './ExecutionDeliveryLink.js';
import type { ExecutionInteractiveReady } from 'nerva-connector-protocol/execution/ExecutionInteractive.js';
import type { ExecutionInputWorkCapture } from 'nerva-connector-protocol/execution/ExecutionInputWorkCapture.js';
import type { ExecutionInputReceiptCapture } from 'nerva-connector-protocol/execution/ExecutionInputReceiptCapture.js';
import { ExecutionInteractiveFields } from 'nerva-connector-protocol/execution/ExecutionInteractiveFields.js';
import type { ExecutionInteractiveDeliveryReply } from './ExecutionInteractiveOwnershipTypes.js';

/** This finite delivery port provides evidence processing without granting sandbox construction or ownership. */
export interface ExecutionInteractiveDeliveryClient {
    readonly failed: boolean;
    interactiveReady(session: ConnectorClientSession): ExecutionInteractiveReady | null;
    input(
        work: ExecutionInputWorkCapture,
        session: ConnectorClientSession,
    ): Promise<ExecutionInteractiveDeliveryReply>;
}
interface ExecutionPendingInputDelivery {
    readonly work: ExecutionInputWorkCapture;
    readonly link: ExecutionDeliveryLink;
}

/** Input has one active delivery and one replacement-link envelope, separate from native execution and cancellation. */
export class ExecutionInputDelivery implements AsyncDisposable {
    #link: ExecutionDeliveryLink | null = null;
    #ready: ConnectorInteractiveReadyEnvelope | null = null;
    #stored: boolean = false;
    #sent: ExecutionInputReceiptCapture | null = null;
    #active: ExecutionPendingInputDelivery | null = null;
    #pending: ExecutionPendingInputDelivery | null = null;
    #task: Promise<void> | null = null;
    #closed: boolean = false;

    /** The enclosing execution owner installs the signal observer and keeps all process cleanup ownership. */
    public constructor(
        public readonly client: ExecutionInteractiveDeliveryClient,
        public readonly progressed: () => void,
    ) {}
    /** New transport authority publishes the retained first proof without resetting or releasing initial input. */
    public activate(link: ExecutionDeliveryLink): void {
        this.#link = link;
        this.#ready = null;
        this.#stored = false;
        this.#sent = null;
        this.#pending = null;
        this.changed();
    }
    /** Detach removes only transport references; active native acceptance and its durable receipt still join. */
    public detach(link: ExecutionDeliveryLink): void {
        if (this.#link === link) {
            this.#link = null;
            this.#ready = null;
            this.#stored = false;
            this.#sent = null;
            this.#pending = null;
        }
    }
    /** A signal publishes only changed genuine Ready; receipt drain always waits for backend ACK-first work. */
    public changed(): void {
        const link: ExecutionDeliveryLink | null = this.#link;
        if (this.#closed || link === null) {
            return;
        }
        try {
            const ready: ExecutionInteractiveReady | null = this.client.interactiveReady(
                link.session,
            );
            if (ready === null) {
                return;
            }
            const submission: ConnectorInteractiveReadyEnvelope = Object.freeze({
                leaseId: link.leaseId,
                ready,
            });
            if (
                this.#ready !== null &&
                ConnectorInteractiveProtocol.encodeReady(submission) ===
                    ConnectorInteractiveProtocol.encodeReady(this.#ready)
            ) {
                return;
            }
            if (this.#sent !== null) {
                throw new Error('New Ready cannot replace outstanding input evidence');
            }
            this.#ready = submission;
            this.#stored = false;
            link.send({ kind: ConnectorFrameKind.ExecutionInteractiveReady, submission });
        } catch {
            if (link === this.#link) {
                link.close();
            }
        }
    }
    /** Stored echoes are flow control only; no initial bytes, native task or input cursor is created here. */
    public receive(frame: ConnectorInteractiveServerFrame, link: ExecutionDeliveryLink): void {
        if (this.#closed || this.#link !== link || this.client.failed) {
            throw new Error('Interactive delivery unavailable');
        }
        if (frame.kind === ConnectorFrameKind.ExecutionInteractiveReadyStored) {
            if (
                this.#ready === null ||
                frame.submission.leaseId !== link.leaseId ||
                ConnectorInteractiveProtocol.encodeReady(frame.submission) !==
                    ConnectorInteractiveProtocol.encodeReady(this.#ready)
            ) {
                throw new Error('Stored Ready changed its exact first proof');
            }
            this.#stored = true;
            return;
        }
        if (
            !this.#stored ||
            this.#ready === null ||
            !ExecutionInteractiveFields.sameOriginal(frame.original, this.#ready.ready) ||
            (frame.work.permit !== null && frame.work.permit.leaseId !== link.leaseId) ||
            (frame.work.acknowledgment !== null &&
                frame.work.acknowledgment.leaseId !== link.leaseId) ||
            (frame.work.resolution !== null && frame.work.resolution.leaseId !== link.leaseId)
        ) {
            throw new Error('Input delivery changed its Ready or lease');
        }
        const empty: boolean =
            frame.work.permit === null &&
            frame.work.acknowledgment === null &&
            frame.work.resolution === null;
        if (this.#active?.link === link) {
            if (empty) {
                return;
            }
            throw new Error('Another input work delivery is in flight');
        }
        if (
            this.#pending !== null &&
            !(
                this.#pending.link === link &&
                this.#pending.work.permit === null &&
                this.#pending.work.acknowledgment === null &&
                this.#pending.work.resolution === null
            )
        ) {
            throw new Error('Input replacement delivery is already bounded');
        }
        this.#pending = { work: frame.work, link };
        this.#start();
    }
    /** The parent joins its native owner first, then releases this bounded delivery continuation. */
    public async [Symbol.asyncDispose](): Promise<void> {
        this.#closed = true;
        this.#link = null;
        this.#pending = null;
        this.#sent = null;
        await this.#task;
    }
    #start(): void {
        if (!this.#closed && this.#task === null && this.#pending !== null) {
            this.#task = this.#drain();
            void this.#observe(this.#task);
        }
    }
    async #drain(): Promise<void> {
        while (!this.#closed && this.#pending !== null) {
            const delivery: ExecutionPendingInputDelivery = this.#pending;
            this.#pending = null;
            this.#active = delivery;
            try {
                const reply: ExecutionInteractiveDeliveryReply = await this.client.input(
                    delivery.work,
                    delivery.link.session,
                );
                if (this.#link !== delivery.link || this.#closed) {
                    continue;
                }
                if (
                    reply.acknowledgment !== null &&
                    this.#sent !== null &&
                    ExecutionInteractiveFields.sameOriginal(
                        reply.acknowledgment,
                        this.#sent.identity,
                    ) &&
                    reply.acknowledgment.readySha256 === this.#sent.identity.readySha256 &&
                    reply.acknowledgment.inputId === this.#sent.identity.inputId &&
                    reply.acknowledgment.inputSequence === this.#sent.identity.inputSequence &&
                    reply.acknowledgment.inputHash === this.#sent.identity.inputHash
                ) {
                    this.#sent = null;
                }
                if (reply.completion !== null) {
                    if (
                        this.#sent !== null &&
                        this.#sent.receiptJson() !== reply.completion.receiptJson()
                    ) {
                        throw new Error('Unacknowledged input evidence cannot be replaced');
                    }
                    if (this.#sent === null) {
                        this.#sent = reply.completion;
                        delivery.link.send({
                            kind: ConnectorFrameKind.ExecutionInputReceipt,
                            completion: reply.completion,
                        });
                    }
                }
                this.progressed();
            } catch {
                if (this.client.failed) {
                    this.#link?.close();
                } else if (this.#link === delivery.link) {
                    delivery.link.close();
                }
            } finally {
                this.#active = null;
            }
        }
    }
    async #observe(task: Promise<void>): Promise<void> {
        try {
            await task;
        } catch {
            this.#closed = true;
            this.#pending = null;
            const link: ExecutionDeliveryLink | null = this.#link;
            this.#link = null;
            link?.close();
        } finally {
            if (this.#task === task) {
                this.#task = null;
                this.#start();
            }
        }
    }
}
