// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

import { ConnectorClientSession } from '../runtime/ConnectorClientSession.js';
import { ExecutionInputWorkCapture } from 'nerva-connector-protocol/execution/ExecutionInputWorkCapture.js';
import { ExecutionInputIdentityCodec } from 'nerva-connector-protocol/execution/ExecutionInputIdentityCodec.js';
import { ExecutionInputJournalControls } from './ExecutionInputJournalControls.js';
import { ExecutionInputReceiptCapture } from 'nerva-connector-protocol/execution/ExecutionInputReceiptCapture.js';
import type { ExecutionInputJournalOwner } from './ExecutionInputJournalOwner.js';
import type { ExecutionInputJournalRetainedControl } from './ExecutionInputJournalTypes.js';
import type {
    ExecutionInputAcknowledgment,
    ExecutionInputReceipt,
} from 'nerva-connector-protocol/execution/ExecutionInput.js';
import type { ExecutionInteractiveRuntime } from './ExecutionInteractiveRuntime.js';
import type { ExecutionInteractiveRuntimeReply } from './ExecutionInteractiveRuntimeTypes.js';
import type { ExecutionInteractiveDeliveryReply } from './ExecutionInteractiveOwnershipTypes.js';
import type { ExecutionInteractiveMain } from './ExecutionInteractiveMain.js';

/** One independently bounded input operation joins durable ACK, native acceptance and retained receipt evidence. */
export class ExecutionInteractiveInput {
    #input: Promise<ExecutionInteractiveDeliveryReply> | null = null;
    public constructor(
        public readonly journal: ExecutionInputJournalOwner,
        public readonly main: ExecutionInteractiveMain,
        public readonly committed: () => void,
        public readonly stopped: () => boolean,
        public readonly failed: () => void,
    ) {}
    /** A new original cannot replace an existing native input mutation. */
    public get busy(): boolean {
        return this.#input !== null;
    }
    /** Lifecycle joins current bounded input work without acquiring new input authority. */
    public async idle(): Promise<void> {
        await Promise.allSettled([this.#input]);
    }
    /** ACK-first processing returns only committed first receipts, including readonly terminal retries. */
    public async input(
        work: ExecutionInputWorkCapture,
        session: ConnectorClientSession,
        runtime: ExecutionInteractiveRuntime,
    ): Promise<ExecutionInteractiveDeliveryReply> {
        if (this.#input !== null) {
            throw new Error('Interactive input delivery unavailable');
        }
        const task: Promise<ExecutionInteractiveDeliveryReply> = this.#process(
            work,
            session,
            runtime,
        );
        this.#input = task;
        try {
            return await task;
        } finally {
            if (this.#input === task) {
                this.#input = null;
            }
        }
    }
    async #process(
        work: ExecutionInputWorkCapture,
        session: ConnectorClientSession,
        runtime: ExecutionInteractiveRuntime,
    ): Promise<ExecutionInteractiveDeliveryReply> {
        const state: ReturnType<ExecutionInputJournalOwner['snapshot']> = this.journal.snapshot();
        this.main.original(state.admission.ready);
        const capture: ExecutionInputWorkCapture = ExecutionInputWorkCapture.read(
            JSON.parse(work.encode()),
        );
        let acknowledgment: ExecutionInputAcknowledgment | null = null;
        const candidate: typeof capture.acknowledgment = capture.acknowledgment;
        if (candidate !== null) {
            const retained: ExecutionInputJournalRetainedControl | undefined = [
                state.pending,
                state.last,
            ].find(
                (
                    value: ExecutionInputJournalRetainedControl | null,
                ): value is ExecutionInputJournalRetainedControl =>
                    value?.receipt !== null &&
                    value?.receipt !== undefined &&
                    ExecutionInputIdentityCodec.matches(
                        candidate.identity,
                        ExecutionInputJournalControls.context(value).input,
                        ExecutionInputJournalControls.context(value).inputHash,
                    ),
            );
            if (retained?.receipt === null || retained?.receipt === undefined) {
                throw new Error('Exact retained input ACK original unavailable');
            }
            acknowledgment = candidate.acknowledgment(retained.receipt);
        }
        try {
            let reply: ExecutionInteractiveRuntimeReply = await runtime.process(
                { acknowledgment, permit: capture.permit },
                session,
            );
            if (capture.resolution !== null) {
                const responseHash: string | null = this.main.responseHash();
                if (!this.stopped() || responseHash === null) {
                    throw new Error(
                        'Terminal input resolution requires the actual durable local main result',
                    );
                }
                const resolved: ExecutionInputReceipt = await this.journal.resolveTerminal(
                    capture.resolution,
                    responseHash,
                    session,
                    BigInt(Date.now()),
                );
                reply = Object.freeze({ acknowledgment: reply.acknowledgment, receipt: resolved });
            }
            const receipt: ExecutionInputReceipt | null = reply.receipt;
            const current: ReturnType<ExecutionInputJournalOwner['snapshot']> =
                this.journal.snapshot();
            const control: ExecutionInputJournalRetainedControl | undefined = [
                current.pending,
                current.last,
            ].find(
                (
                    value: ExecutionInputJournalRetainedControl | null,
                ): value is ExecutionInputJournalRetainedControl =>
                    receipt !== null &&
                    value !== null &&
                    ExecutionInputIdentityCodec.matches(
                        receipt,
                        ExecutionInputJournalControls.context(value).input,
                        ExecutionInputJournalControls.context(value).inputHash,
                    ),
            );
            if (receipt !== null && control === undefined) {
                throw new Error('Durable input receipt context disappeared');
            }
            const completion: ExecutionInputReceiptCapture | null =
                receipt === null || control === undefined
                    ? null
                    : ExecutionInputReceiptCapture.create(
                          ConnectorClientSession.current(session, BigInt(Date.now())).leaseId,
                          receipt,
                          {
                              input: ExecutionInputJournalControls.context(control).input,
                              inputHash: ExecutionInputJournalControls.context(control).inputHash,
                              prior: control.prior,
                          },
                      );
            if (reply.acknowledgment !== null || receipt !== null) {
                this.committed();
            }
            return Object.freeze({ acknowledgment: reply.acknowledgment, completion });
        } catch (caught: unknown) {
            if (this.journal.failed) {
                this.failed();
            }
            throw caught;
        }
    }
}
