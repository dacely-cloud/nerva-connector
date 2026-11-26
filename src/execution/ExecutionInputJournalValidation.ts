// SPDX-FileCopyrightText: 2026 Dacely <business@dacely.com>
// SPDX-License-Identifier: LicenseRef-Proprietary

import { ConnectorClock } from '../protocol/ConnectorClock.js';
import { SigningKey } from '../identity/SigningKey.js';
import { SignaturePurpose } from 'nerva-connector-protocol/identity/IdentityFormat.js';
import type { ConnectorClientIdentity } from '../runtime/ConnectorClientConfiguration.js';
import { ConnectorClientSession } from '../runtime/ConnectorClientSession.js';
import { ConnectorAuthorizationProof } from 'nerva-connector-protocol/protocol/ConnectorAuthorizationProof.js';
import type { ConnectorDeviceLease } from 'nerva-connector-protocol/protocol/ConnectorDevice.js';
import { ExecutionInteractiveFields as Fields } from 'nerva-connector-protocol/execution/ExecutionInteractiveFields.js';
import { ExecutionInteractiveCodec } from 'nerva-connector-protocol/execution/ExecutionInteractiveCodec.js';
import { ExecutionInteractiveProof as Proof } from 'nerva-connector-protocol/execution/ExecutionInteractiveProof.js';
import { ExecutionInteractiveRuleCodec } from 'nerva-connector-protocol/execution/ExecutionInteractiveRuleCodec.js';
import { ExecutionInteractiveLaunchCodec } from 'nerva-connector-protocol/execution/ExecutionInteractiveLaunchCodec.js';
import { ExecutionInputPermitCodec } from 'nerva-connector-protocol/execution/ExecutionInputPermitCodec.js';
import { ExecutionInputReceiptCodec } from 'nerva-connector-protocol/execution/ExecutionInputReceiptCodec.js';
import { ExecutionInputAcknowledgmentCodec } from 'nerva-connector-protocol/execution/ExecutionInputAcknowledgmentCodec.js';
import {
    ExecutionInputKind,
    ExecutionInputDisposition,
    type ExecutionInputReceiptContext,
} from 'nerva-connector-protocol/execution/ExecutionInput.js';
import type { ExecutionPermit } from 'nerva-connector-protocol/execution/ExecutionJobs.js';
import { ExecutionJobsCodec } from './ExecutionJobsCodec.js';
import { ExecutionProof } from 'nerva-connector-protocol/execution/ExecutionProof.js';
import { ExecutionInputJournalControls } from './ExecutionInputJournalControls.js';
import { ExecutionInputTerminalResolutionCodec } from 'nerva-connector-protocol/execution/ExecutionInputTerminalResolutionCodec.js';
import {
    ExecutionInputJournalLimits as Limits,
    type ExecutionInputJournalScope,
    type ExecutionInputJournalAdmission,
    ExecutionInputJournalControlKind,
    type ExecutionInputJournalRetainedControl,
} from './ExecutionInputJournalTypes.js';

/** This owner checks storage/proof correlation; the execution owner still admits the actual local program and Joint workspace. */
export class ExecutionInputJournalValidation {
    public constructor(
        public readonly identity: ConnectorClientIdentity,
        public readonly scope: ExecutionInputJournalScope,
    ) {}

    /** Internal callers are detached through the same closed codecs as encrypted external state. */
    public admission(value: ExecutionInputJournalAdmission): ExecutionInputJournalAdmission {
        const raw: Readonly<Record<string, unknown>> = Fields.record(value, [
            'ready',
            'rule',
            'launch',
            'policySha256',
        ]);
        const ready: ReturnType<typeof ExecutionInteractiveCodec.decode> =
            ExecutionInteractiveCodec.decode(ExecutionInteractiveCodec.encode(value.ready));
        const rule: ReturnType<typeof ExecutionInteractiveRuleCodec.body> =
            ExecutionInteractiveRuleCodec.body(value.rule);
        if (Buffer.byteLength(this.json(rule)) > Limits.ruleBytes) {
            throw new Error('Retained interactive grant exceeds its storage bound');
        }
        const launch: ReturnType<typeof ExecutionInteractiveLaunchCodec.decode> =
            ExecutionInteractiveLaunchCodec.decode(
                rule,
                ExecutionInteractiveLaunchCodec.encode(rule, value.launch),
            );
        if (
            ready.authorityId !== this.identity.authority.authorityId ||
            ready.environmentId !== this.identity.settings.environmentId ||
            ready.enrollmentId !== this.identity.settings.enrollmentId ||
            ready.lane !== this.scope.lane ||
            ready.transport !== launch.transport ||
            ready.executionDeadlineMs !== launch.executionDeadlineMs ||
            ready.initialInputBytes !== BigInt(Buffer.byteLength(launch.invocation.stdin)) ||
            ready.initialInputHash !== Proof.dataHash(Buffer.from(launch.invocation.stdin)) ||
            this.json(ready.dimensions) !== this.json(launch.dimensions) ||
            !SigningKey.verify(
                SignaturePurpose.OperationExecutionInteractiveReady,
                this.identity.publicKey,
                Proof.ready(ExecutionInteractiveCodec.unsigned(ready)),
                ready.signature,
            )
        ) {
            throw new Error('Retained Ready changed its captured launch or device proof');
        }
        return Object.freeze({
            ready,
            rule,
            launch,
            policySha256: Fields.digest(raw['policySha256']),
        });
    }

    /** A fresh signed start must cover the exact canonical interactive argument and independent deadline. */
    public fresh(
        value: ExecutionPermit,
        admission: ExecutionInputJournalAdmission,
        session: ConnectorClientSession,
        nowMs: bigint,
    ): void {
        const permit: ExecutionPermit = ExecutionJobsCodec.permit(
            JSON.parse(ExecutionJobsCodec.encode(value)),
        );
        const ready: typeof admission.ready = admission.ready;
        if (
            permit.authorityId !== ready.authorityId ||
            permit.environmentId !== ready.environmentId ||
            permit.enrollmentId !== ready.enrollmentId ||
            permit.lane !== ready.lane ||
            permit.jobId !== ready.jobId ||
            permit.sequence !== ready.sequence ||
            permit.dispatchId !== ready.dispatchId ||
            permit.requestHash !== ready.requestHash ||
            permit.admissionHash !== ready.admissionHash ||
            permit.executionDeadlineMs !== admission.launch.executionDeadlineMs ||
            permit.request.policySha256 !== admission.policySha256 ||
            permit.request.arguments.length !== 1 ||
            permit.request.arguments[0] !==
                ExecutionInteractiveLaunchCodec.encode(admission.rule, admission.launch) ||
            ExecutionProof.requestHash(permit.request) !== permit.requestHash ||
            ConnectorAuthorizationProof.execution(
                permit.requestHash,
                permit.lane,
                permit.authorization,
            ) !== permit.admissionHash ||
            !ConnectorClock.issued(permit.issuedAtMs, nowMs) ||
            permit.expiresAtMs <= nowMs ||
            !SigningKey.verify(
                SignaturePurpose.OperationExecutionPermit,
                this.identity.authority.publicKey,
                ExecutionProof.permit(permit),
                permit.signature,
            )
        ) {
            throw new Error('Fresh interactive cursor requires its exact admitted execution');
        }
        this.lease(session, permit.leaseId, nowMs);
        ExecutionInteractiveLaunchCodec.admit(admission.rule, permit.request.arguments[0], nowMs);
    }

    /** Only an actually confirmed session supplies current lease authority; no caller-selected raw lease is accepted. */
    public lease(session: ConnectorClientSession, leaseId: string, nowMs: bigint): void {
        if (this.current(session, nowMs).leaseId !== leaseId) {
            throw new Error('Interactive input lease changed its enrolled owner');
        }
    }

    /** Read-only retained evidence still requires a live mutually confirmed enrolled session, without a new input permit. */
    public current(session: ConnectorClientSession, nowMs: bigint): ConnectorDeviceLease {
        const lease: ConnectorDeviceLease = ConnectorClientSession.current(session, nowMs);
        if (
            session.identity.publicKey !== this.identity.publicKey ||
            session.identity.authority.publicKey !== this.identity.authority.publicKey ||
            lease.authorityId !== this.identity.authority.authorityId ||
            lease.environmentId !== this.identity.settings.environmentId ||
            lease.enrollmentId !== this.identity.settings.enrollmentId
        ) {
            throw new Error('Interactive input lease changed its enrolled owner');
        }
        return lease;
    }

    public context(value: ExecutionInputJournalRetainedControl): ExecutionInputReceiptContext {
        return ExecutionInputJournalControls.context(value);
    }

    /** A stored wrapper cannot expand the original rule or replace the immutable first Ready commitment. */
    public control(
        value: ExecutionInputJournalRetainedControl,
        admission: ExecutionInputJournalAdmission,
    ): void {
        const { receipt, acknowledgment }: ExecutionInputJournalRetainedControl = value;
        const context: ExecutionInputReceiptContext = this.context(value);
        const input: typeof context.input = context.input;
        if (value.kind === ExecutionInputJournalControlKind.Permit) {
            ExecutionInputPermitCodec.encode(value.permit);
            if (
                !SigningKey.verify(
                    SignaturePurpose.OperationExecutionInputPermit,
                    this.identity.authority.publicKey,
                    Proof.permit(ExecutionInputPermitCodec.unsigned(value.permit), admission.ready),
                    value.permit.signature,
                )
            ) {
                throw new Error('Retained input permit proof rejected');
            }
        } else {
            ExecutionInputTerminalResolutionCodec.encode(value.resolution);
            if (
                this.json(value.prior) !== this.json(value.resolution.prior) ||
                !SigningKey.verify(
                    SignaturePurpose.OperationExecutionInputTerminalResolution,
                    this.identity.authority.publicKey,
                    Proof.resolution(
                        ExecutionInputTerminalResolutionCodec.unsigned(value.resolution),
                        admission.ready,
                    ),
                    value.resolution.signature,
                )
            ) {
                throw new Error('Retained terminal input resolution proof rejected');
            }
            if (
                receipt !== null &&
                (receipt.disposition !== ExecutionInputDisposition.Indeterminate ||
                    receipt.cursor.acceptedOffset !== value.prior.acceptedOffset)
            ) {
                throw new Error('Terminal resolution cannot assert native input acceptance');
            }
        }
        if (
            !admission.rule.controls.includes(input.control.kind) ||
            input.inputSequence >= BigInt(admission.rule.maximumControls) ||
            (input.control.kind === ExecutionInputKind.Data &&
                input.control.offset + input.control.byteLength >
                    admission.rule.maximumInputBytes) ||
            (input.control.kind === ExecutionInputKind.Resize &&
                value.prior.resizeCount >= BigInt(admission.rule.maximumResizes))
        ) {
            throw new Error('Retained input exceeds its original grant');
        }
        if (input.inputSequence === 0n) {
            Proof.initial(
                input,
                ExecutionInteractiveCodec.unsigned(admission.ready),
                Buffer.from(admission.launch.invocation.stdin),
            );
        }
        if (receipt !== null) {
            ExecutionInputReceiptCodec.encode(receipt, context);
        }
        if (acknowledgment !== null && receipt !== null) {
            ExecutionInputAcknowledgmentCodec.encode(acknowledgment, receipt);
        }
        if (
            receipt !== null &&
            !SigningKey.verify(
                SignaturePurpose.OperationExecutionInputReceipt,
                this.identity.publicKey,
                Proof.receipt(ExecutionInputReceiptCodec.unsigned(receipt, context), context),
                receipt.signature,
            )
        ) {
            throw new Error('Retained input receipt proof rejected');
        }
        if (
            acknowledgment !== null &&
            (receipt === null ||
                !SigningKey.verify(
                    SignaturePurpose.OperationExecutionInputAcknowledgment,
                    this.identity.authority.publicKey,
                    Proof.acknowledgment(
                        ExecutionInputAcknowledgmentCodec.unsigned(acknowledgment, receipt),
                        receipt,
                        context,
                    ),
                    acknowledgment.signature,
                ))
        ) {
            throw new Error('Retained input acknowledgment proof rejected');
        }
    }

    /** This serializer only consumes already captured immutable state; external values enter closed codecs first. */
    public json(
        value:
            | ExecutionInputJournalAdmission
            | ExecutionInputJournalRetainedControl
            | ExecutionInputJournalScope
            | ExecutionInputReceiptContext
            | ExecutionInputJournalAdmission['rule']
            | ExecutionInputJournalAdmission['launch']['dimensions']
            | ExecutionInputJournalRetainedControl['prior'],
    ): string {
        return JSON.stringify(value, (_key: string, entry: unknown): unknown =>
            typeof entry === 'bigint' ? entry.toString() : entry,
        );
    }
}
