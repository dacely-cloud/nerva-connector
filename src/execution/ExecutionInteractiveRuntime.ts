// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

import { ConnectorClock } from '../protocol/ConnectorClock.js';
import { SignaturePurpose } from 'nerva-connector-protocol/identity/IdentityFormat.js';
import { ConnectorClientSession } from '../runtime/ConnectorClientSession.js';
import type { ConnectorDeviceLease } from 'nerva-connector-protocol/protocol/ConnectorDevice.js';
import { ExecutionInteractiveFields as Fields } from 'nerva-connector-protocol/execution/ExecutionInteractiveFields.js';
import {
    ExecutionInteractiveTransport,
    type ExecutionInteractiveReady,
    type ExecutionInteractiveReadyBody,
} from 'nerva-connector-protocol/execution/ExecutionInteractive.js';
import { ExecutionInteractiveRuleCodec } from './ExecutionInteractiveRuleCodec.js';
import { ExecutionInteractiveLaunchCodec } from './ExecutionInteractiveLaunchCodec.js';
import { ExecutionInteractiveProof as Proof } from 'nerva-connector-protocol/execution/ExecutionInteractiveProof.js';
import { ExecutionJobsCodec } from './ExecutionJobsCodec.js';
import type { ExecutionPermit } from './ExecutionJobs.js';
import type {
    ExecutionInputPermit,
    ExecutionInputReceipt,
} from 'nerva-connector-protocol/execution/ExecutionInput.js';
import { ExecutionInputPermitCodec } from 'nerva-connector-protocol/execution/ExecutionInputPermitCodec.js';
import type { ExecutionInputJournalOwner } from './ExecutionInputJournalOwner.js';
import type {
    ExecutionInputJournalControl,
    ExecutionInputJournalAdmission,
    ExecutionInputJournalState,
} from './ExecutionInputJournalTypes.js';
import { ExecutionInputJournalControlKind } from './ExecutionInputJournalTypes.js';
import type {
    ExecutionNativePipeApplied,
    ExecutionNativePipeReady,
} from './ExecutionNativePipeProtocol.js';
import { ExecutionInteractiveRuntimeOutcome as Outcome } from './ExecutionInteractiveRuntimeOutcome.js';
import type {
    ExecutionInteractiveRuntimeSettings,
    ExecutionInteractiveRuntimeContext,
    ExecutionInteractiveRuntimeWork,
    ExecutionInteractiveRuntimeReply,
} from './ExecutionInteractiveRuntimeTypes.js';

/** An execution-owned Pipe adapter signs only native evidence and durable journal outcomes; it owns no process or transport. */
export class ExecutionInteractiveRuntime {
    #busy: boolean = false;
    #stopped: boolean = false;
    readonly #settings: ExecutionInteractiveRuntimeContext;
    private constructor(
        settings: ExecutionInteractiveRuntimeContext,
        public readonly admission: ExecutionInputJournalAdmission,
    ) {
        this.#settings = settings;
    }

    /** Genuine native exec readiness precedes fresh cursor initialization; no initial application byte is released here. */
    public static async create(
        settings: ExecutionInteractiveRuntimeSettings,
    ): Promise<ExecutionInteractiveRuntime> {
        const rule: ReturnType<typeof ExecutionInteractiveRuleCodec.body> =
            ExecutionInteractiveRuleCodec.body(settings.rule);
        const launch: ReturnType<typeof ExecutionInteractiveLaunchCodec.decode> =
            ExecutionInteractiveLaunchCodec.decode(
                rule,
                ExecutionInteractiveLaunchCodec.encode(rule, settings.launch),
            );
        if (launch.transport !== ExecutionInteractiveTransport.Pipe) {
            throw new Error('Only qualified native Pipe transport is available');
        }
        const permit: ExecutionPermit = ExecutionJobsCodec.permit(
            JSON.parse(ExecutionJobsCodec.encode(settings.permit)),
        );
        const incarnation: string = Fields.digest(settings.incarnation);
        settings.native.assertBootstrap(
            incarnation,
            launch.invocation.stdin,
            rule.maximumInputBytes,
            rule.maximumControls,
            launch.executionDeadlineMs,
        );
        const native: ExecutionNativePipeReady = await settings.native.ready;
        if (
            native.incarnation !== incarnation ||
            native.initialInputBytes !== Buffer.byteLength(launch.invocation.stdin) ||
            native.initialInputHash !== Proof.dataHash(Buffer.from(launch.invocation.stdin))
        ) {
            throw new Error('Native Ready changed its exact captured initial input');
        }
        settings.native.assertBootstrap(
            incarnation,
            launch.invocation.stdin,
            rule.maximumInputBytes,
            rule.maximumControls,
            launch.executionDeadlineMs,
        );
        const body: ExecutionInteractiveReadyBody = {
            authorityId: permit.authorityId,
            environmentId: permit.environmentId,
            enrollmentId: permit.enrollmentId,
            lane: permit.lane,
            jobId: permit.jobId,
            sequence: permit.sequence,
            dispatchId: permit.dispatchId,
            requestHash: permit.requestHash,
            admissionHash: permit.admissionHash,
            transport: launch.transport,
            incarnation,
            initialInputSequence: 0n,
            initialInputBytes: BigInt(native.initialInputBytes),
            initialInputHash: native.initialInputHash,
            dimensions: null,
            executionDeadlineMs: launch.executionDeadlineMs,
        };
        const ready: ExecutionInteractiveReady = Object.freeze({
            ...body,
            signature: settings.identity.key.sign(
                SignaturePurpose.OperationExecutionInteractiveReady,
                Proof.ready(body),
            ),
        });
        const admission: ExecutionInputJournalAdmission = Object.freeze({
            ready,
            rule,
            launch,
            policySha256: permit.request.policySha256,
        });
        await settings.journal.confirmReady(admission);
        return new ExecutionInteractiveRuntime(
            Object.freeze({ ...settings, permit, rule, launch }),
            admission,
        );
    }

    /** A restored lost owner can drain only exact durable receipt evidence and ACKs, never resume native input. */
    public static recovered(
        settings: Omit<ExecutionInteractiveRuntimeContext, 'native'>,
    ): ExecutionInteractiveRuntime {
        const state: ReturnType<ExecutionInputJournalOwner['snapshot']> =
            settings.journal.snapshot();
        if (state.terminal === null && (!state.ownerLost || !state.inputStopped)) {
            throw new Error('Recovered input requires a durably lost native owner');
        }
        const runtime: ExecutionInteractiveRuntime = new ExecutionInteractiveRuntime(
            { ...settings, native: null },
            state.admission,
        );
        runtime.stopInput();
        return runtime;
    }

    /** One bounded poll applies the previous exact ACK before admitting its next immutable input. Detaching an observer calls neither this nor stopInput. */
    public async process(
        work: ExecutionInteractiveRuntimeWork,
        session: ConnectorClientSession,
    ): Promise<ExecutionInteractiveRuntimeReply> {
        if (this.#busy) {
            throw new Error('Another interactive input delivery is in flight');
        }
        this.#busy = true;
        try {
            Fields.record(work, ['acknowledgment', 'permit']);
            const acknowledgment: ExecutionInteractiveRuntimeReply['acknowledgment'] =
                work.acknowledgment === null
                    ? null
                    : await this.#settings.journal.acknowledge(
                          work.acknowledgment,
                          session,
                          this.#settings.nowMs(),
                      );
            const receipt: ExecutionInputReceipt | null =
                work.permit === null
                    ? this.#settings.journal.pendingReceipt(session, this.#settings.nowMs())
                    : await this.#accept(work.permit, session);
            return Object.freeze({ acknowledgment, receipt });
        } finally {
            this.#busy = false;
        }
    }

    /** This logical cancellation cannot kill or replace the borrowed sandbox; that lifecycle remains with its existing execution owner. */
    public stopInput(): void {
        this.#stopped = true;
    }

    async #accept(
        permit: ExecutionInputPermit,
        session: ConnectorClientSession,
    ): Promise<ExecutionInputReceipt> {
        const delivery: ExecutionInputPermit = ExecutionInputPermitCodec.decode(
            ExecutionInputPermitCodec.encode(permit),
        );
        const control: ExecutionInputJournalControl = await this.#settings.journal.stage(
            delivery,
            session,
            this.#settings.nowMs(),
        );
        if (control.receipt !== null) {
            return control.receipt;
        }
        let native: ExecutionNativePipeApplied | null = null;
        if (!this.#stopped && this.#settings.native !== null) {
            try {
                this.#assertDelivery(delivery, control, session);
                native = await this.#settings.native.send(
                    Outcome.command(control, delivery.expiresAtMs),
                );
            } catch {
                this.#stopped = true;
            }
        }
        if (this.#stopped) {
            native = null;
        }
        const receipt: ExecutionInputReceipt = Outcome.receipt(
            control,
            native,
            this.#settings.identity.key,
        );
        /** A publication fault escapes without transmitting an unsaved result or guessing a replacement receipt. */
        return await this.#settings.journal.record(receipt);
    }

    /** Journal publication may await storage: only a still-current captured delivery can cross the subsequent native call boundary. */
    #assertDelivery(
        delivery: ExecutionInputPermit,
        control: ExecutionInputJournalControl,
        session: ConnectorClientSession,
    ): void {
        const nowMs: bigint = this.#settings.nowMs();
        const lease: ConnectorDeviceLease = ConnectorClientSession.current(session, nowMs);
        const state: ExecutionInputJournalState = this.#settings.journal.snapshot();
        if (
            session.identity.publicKey !== this.#settings.identity.publicKey ||
            session.identity.authority.publicKey !== this.#settings.identity.authority.publicKey ||
            lease.authorityId !== this.admission.ready.authorityId ||
            lease.environmentId !== this.admission.ready.environmentId ||
            lease.enrollmentId !== this.admission.ready.enrollmentId ||
            delivery.leaseId !== lease.leaseId ||
            delivery.issuedAtMs < lease.issuedAtMs ||
            !ConnectorClock.issued(delivery.issuedAtMs, nowMs) ||
            delivery.expiresAtMs <= nowMs ||
            delivery.expiresAtMs > lease.expiresAtMs ||
            delivery.executionDeadlineMs !== this.admission.ready.executionDeadlineMs ||
            delivery.executionDeadlineMs <= nowMs ||
            state.ownerLost ||
            state.inputStopped ||
            state.terminal !== null ||
            state.writerGeneration !== delivery.writerGeneration ||
            state.pending === null ||
            state.pending.kind !== ExecutionInputJournalControlKind.Permit ||
            state.pending.receipt !== null ||
            state.pending.permit.inputHash !== control.permit.inputHash ||
            delivery.inputHash !== control.permit.inputHash
        ) {
            throw new Error('Interactive input delivery expired or changed during publication');
        }
    }
}
