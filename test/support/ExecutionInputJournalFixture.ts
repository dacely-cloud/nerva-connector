// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

import { randomBytes } from 'node:crypto';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { ConnectorSessionFixture } from './ConnectorSessionFixture.js';
import { ExecutionMachineFixture } from './ExecutionMachineFixture.js';
import { ExecutionMachineRuleCodec } from 'nerva-connector-protocol/execution/ExecutionMachineRuleCodec.js';
import { ConnectorClientSession } from '../../src/runtime/ConnectorClientSession.js';
import type { ConnectorDeviceLease } from 'nerva-connector-protocol/protocol/ConnectorDevice.js';
import { ConnectorAuthorizationKind } from 'nerva-connector-protocol/protocol/ConnectorAuthorization.js';
import { ConnectorAuthorizationProof } from 'nerva-connector-protocol/protocol/ConnectorAuthorizationProof.js';
import { ExecutionArgumentKind } from 'nerva-connector-protocol/execution/ExecutionArgumentKind.js';
import {
    ExecutionInteractiveTransport,
    type ExecutionInteractiveReady,
    type ExecutionInteractiveOriginal,
} from 'nerva-connector-protocol/execution/ExecutionInteractive.js';
import type {
    ExecutionInteractiveInvocationRule,
    ExecutionInteractiveLaunch,
} from 'nerva-connector-protocol/execution/ExecutionInteractiveInvocation.js';
import { ExecutionInteractiveLaunchCodec } from 'nerva-connector-protocol/execution/ExecutionInteractiveLaunchCodec.js';
import { ExecutionInteractiveProof as Proof } from 'nerva-connector-protocol/execution/ExecutionInteractiveProof.js';
import {
    ExecutionInputKind,
    ExecutionInputDisposition,
    type ExecutionInputOriginal,
    type ExecutionInputPermit,
    type ExecutionInputReceipt,
    type ExecutionInputReceiptBody,
    type ExecutionInputAcknowledgment,
    type ExecutionInputCursor,
} from 'nerva-connector-protocol/execution/ExecutionInput.js';
import {
    type ExecutionPermit,
    type ExecutionRequest,
    type ExecutionCompletion,
    type ExecutionAcknowledgment,
} from 'nerva-connector-protocol/execution/ExecutionJobs.js';
import { ExecutionLane } from 'nerva-connector-protocol/execution/ExecutionLane.js';
import { ExecutionProof } from 'nerva-connector-protocol/execution/ExecutionProof.js';
import {
    ExecutionTermination,
    type ExecutionResult,
} from 'nerva-connector-protocol/execution/ExecutionTypes.js';
import { SignaturePurpose } from 'nerva-connector-protocol/identity/IdentityFormat.js';
import type {
    ExecutionInputJournalAdmission,
    ExecutionInputJournalControl,
    ExecutionInputJournalScope,
    ExecutionInputJournalState,
} from '../../src/execution/ExecutionInputJournalTypes.js';
import type { ExecutionInputJournalOwner } from '../../src/execution/ExecutionInputJournalOwner.js';

/** Fixture signatures validate storage authority, not an actual execution, native write or real account admission. */
export class ExecutionInputJournalFixture implements AsyncDisposable {
    /** Storage tests explicitly prepare then confirm their synthetic signed proof, without claiming native execution. */
    public async initialize(
        owner: ExecutionInputJournalOwner,
        admission: ExecutionInputJournalAdmission,
        permit: ExecutionPermit,
        session: ConnectorClientSession,
        nowMs: bigint,
    ): Promise<ExecutionInputJournalState> {
        await owner.prepareFresh(
            {
                permit,
                rule: admission.rule,
                launch: admission.launch,
                incarnation: admission.ready.incarnation,
            },
            session,
            nowMs,
        );
        return await owner.confirmReady(admission);
    }
    public readonly peer: ConnectorSessionFixture = new ConnectorSessionFixture();
    public readonly session: ConnectorClientSession = new ConnectorClientSession(
        this.peer.identity,
    );
    public readonly lease: ConnectorDeviceLease;
    public readonly scope: ExecutionInputJournalScope = {
        lane: ExecutionLane.First,
        journalId: 'a'.repeat(64),
    };
    public readonly directory: string;
    public readonly file: string;
    private constructor(public readonly root: string) {
        this.directory = join(root, 'first');
        this.file = join(this.directory, 'execution-input');
        const challenge: ReturnType<ConnectorSessionFixture['challenge']> = this.peer.challenge(
            this.session.begin(this.peer.now),
        );
        this.lease = this.session.confirm(
            this.peer.confirmation(challenge, this.session.prove(challenge, this.peer.now)),
            this.peer.now,
        );
    }

    public static async create(): Promise<ExecutionInputJournalFixture> {
        const root: string = await mkdtemp(join(homedir(), '.nerva-input-journal-'));
        try {
            const fixture: ExecutionInputJournalFixture = new ExecutionInputJournalFixture(root);
            await mkdir(fixture.directory, { mode: 0o700 });
            return fixture;
        } catch (caught: unknown) {
            await rm(root, { recursive: true, force: true });
            throw caught;
        }
    }

    public admission(
        sequence: bigint = 1n,
        stdin: string = '',
        rule: ExecutionInteractiveInvocationRule = this.rule(),
    ): ExecutionInputJournalAdmission {
        const launch: ExecutionInteractiveLaunch = {
            transport: ExecutionInteractiveTransport.Pipe,
            invocation: { ...ExecutionMachineFixture.shell(), stdin, timeoutMs: 5000 },
            executionDeadlineMs: this.peer.now + 4000n,
            dimensions: null,
        };
        const request: ExecutionRequest = this.request(launch, rule, sequence);
        const requestHash: string = ExecutionProof.requestHash(request);
        const body: Omit<ExecutionInteractiveReady, 'signature'> = {
            authorityId: this.peer.identity.authority.authorityId,
            environmentId: this.peer.identity.settings.environmentId,
            enrollmentId: this.peer.identity.settings.enrollmentId,
            lane: this.scope.lane,
            jobId: 'job-' + sequence.toString(),
            sequence,
            dispatchId: randomBytes(32).toString('base64url'),
            requestHash,
            admissionHash: ConnectorAuthorizationProof.execution(requestHash, this.scope.lane, {
                kind: ConnectorAuthorizationKind.Independent,
            }),
            transport: launch.transport,
            incarnation: randomBytes(32).toString('hex'),
            initialInputSequence: 0n,
            initialInputBytes: BigInt(Buffer.byteLength(stdin)),
            initialInputHash: Proof.dataHash(Buffer.from(stdin)),
            executionDeadlineMs: launch.executionDeadlineMs,
            dimensions: launch.dimensions,
        };
        return {
            ready: {
                ...body,
                signature: this.peer.device.sign(
                    SignaturePurpose.OperationExecutionInteractiveReady,
                    Proof.ready(body),
                ),
            },
            rule,
            launch,
            policySha256: 'b'.repeat(64),
        };
    }

    public rule(): ExecutionInteractiveInvocationRule {
        return {
            kind: ExecutionArgumentKind.InteractiveInvocation,
            invocation: ExecutionMachineFixture.rule(),
            transports: [ExecutionInteractiveTransport.Pipe],
            controls: [ExecutionInputKind.Data, ExecutionInputKind.End],
            maximumInputBytes: 65536n,
            maximumControls: 256,
            maximumResizes: 0,
        };
    }

    /** Every local Machine collection and byte budget reaches its independent maximum, including sixfold JSON escaping. */
    public maximumRule(): ExecutionInteractiveInvocationRule {
        return {
            ...this.rule(),
            invocation: ExecutionMachineRuleCodec.read({
                kind: ExecutionArgumentKind.MachineInvocation,
                shell: {
                    executableIndex: 8,
                    fixedArguments: Array.from({ length: 16 }, (): string => '\u0001'.repeat(128)),
                },
                commands: Array.from(
                    { length: 9 },
                    (
                        _value: unknown,
                        index: number,
                    ): import('nerva-connector-protocol/execution/ExecutionMachineInvocation.js').ExecutionMachineCommand => ({
                        alias: ('alias-' + index.toString()).padEnd(128, 'a'),
                        executableIndex: index,
                    }),
                ),
                maximumCwdBytes: 512,
                environment: Array.from(
                    { length: 16 },
                    (
                        _value: unknown,
                        index: number,
                    ): import('nerva-connector-protocol/execution/ExecutionMachineInvocation.js').ExecutionMachineEnvironmentGrant => ({
                        name: ('ENV_' + index.toString().padStart(2, '0')).padEnd(64, 'X'),
                        maximumBytes: 1024,
                    }),
                ),
                maximumEnvironmentBytes: 1024,
                maximumStdinBytes: 1024,
                maximumTimeoutMs: 30000,
                maximumArguments: 32,
                maximumArgumentBytes: 1024,
                maximumArgumentsBytes: 2048,
                maximumScriptBytes: 2048,
            }),
            transports: [ExecutionInteractiveTransport.Pipe, ExecutionInteractiveTransport.Pty],
            controls: [ExecutionInputKind.Data, ExecutionInputKind.End, ExecutionInputKind.Resize],
            maximumResizes: 16,
        };
    }

    public permit(admission: ExecutionInputJournalAdmission): ExecutionPermit {
        const body: Omit<ExecutionPermit, 'signature'> & ExecutionInteractiveOriginal = {
            ...this.original(admission.ready),
            leaseId: this.lease.leaseId,
            request: this.request(admission.launch, admission.rule, admission.ready.sequence),
            authorization: { kind: ConnectorAuthorizationKind.Independent },
            issuedAtMs: this.peer.now,
            expiresAtMs: this.peer.now + 1000n,
            executionDeadlineMs: admission.launch.executionDeadlineMs,
        };
        const {
            transport: _transport,
            incarnation: _incarnation,
            ...permit
        }: typeof body & ExecutionInteractiveOriginal = body;
        return {
            ...permit,
            signature: this.peer.authority.sign(
                SignaturePurpose.OperationExecutionPermit,
                ExecutionProof.permit(permit),
            ),
        };
    }

    public input(
        admission: ExecutionInputJournalAdmission,
        bytes: Buffer = Buffer.from(admission.launch.invocation.stdin),
        sequence: bigint = 0n,
        prior: ExecutionInputCursor | null = null,
        generation: bigint = 1n,
    ): ExecutionInputPermit {
        const input: ExecutionInputOriginal = {
            ...this.original(admission.ready),
            readySha256: Proof.readySha256(admission.ready),
            inputId: sequence === 0n ? 'initial' : 'input-' + sequence.toString(),
            inputSequence: sequence,
            previousInputHash: prior?.processedInputHash ?? '0'.repeat(64),
            control: {
                kind: ExecutionInputKind.Data,
                offset: prior?.acceptedOffset ?? 0n,
                byteLength: BigInt(bytes.byteLength),
                dataHash: Proof.dataHash(bytes),
                dataBase64: bytes.toString('base64'),
            },
        };
        const body: Omit<ExecutionInputPermit, 'signature'> = {
            input,
            inputHash: Proof.inputHash(input),
            leaseId: this.lease.leaseId,
            writerGeneration: generation,
            issuedAtMs: this.peer.now,
            expiresAtMs: this.peer.now + 1000n,
            executionDeadlineMs: admission.launch.executionDeadlineMs,
        };
        return {
            ...body,
            signature: this.peer.authority.sign(
                SignaturePurpose.OperationExecutionInputPermit,
                Proof.permit(body, admission.ready),
            ),
        };
    }

    public receipt(
        control: ExecutionInputJournalControl,
        disposition: ExecutionInputDisposition = ExecutionInputDisposition.Applied,
    ): ExecutionInputReceipt {
        const input: typeof control.permit.input = control.permit.input;
        const cursor: ExecutionInputCursor =
            disposition === ExecutionInputDisposition.Applied
                ? {
                      ...control.prior,
                      processedSequence: input.inputSequence,
                      processedInputHash: control.permit.inputHash,
                      initialAccepted: true,
                      acceptedOffset:
                          control.prior.acceptedOffset +
                          (input.control.kind === ExecutionInputKind.Data
                              ? input.control.byteLength
                              : 0n),
                      ended: input.control.kind === ExecutionInputKind.End,
                  }
                : { ...control.prior, blocked: true };
        const body: ExecutionInputReceiptBody = {
            ...this.original(input),
            readySha256: input.readySha256,
            inputId: input.inputId,
            inputSequence: input.inputSequence,
            inputHash: control.permit.inputHash,
            disposition,
            cursor,
        };
        return {
            ...body,
            signature: this.peer.device.sign(
                SignaturePurpose.OperationExecutionInputReceipt,
                Proof.receipt(body, {
                    input,
                    inputHash: control.permit.inputHash,
                    prior: control.prior,
                }),
            ),
        };
    }

    public acknowledgment(
        control: ExecutionInputJournalControl,
        receipt: ExecutionInputReceipt,
    ): ExecutionInputAcknowledgment {
        const body: Omit<ExecutionInputAcknowledgment, 'signature'> = {
            ...this.original(receipt),
            readySha256: receipt.readySha256,
            inputId: receipt.inputId,
            inputSequence: receipt.inputSequence,
            inputHash: receipt.inputHash,
            receiptSha256: Proof.receiptSha256(receipt, {
                input: control.permit.input,
                inputHash: control.permit.inputHash,
                prior: control.prior,
            }),
            leaseId: this.lease.leaseId,
            writerGeneration: control.permit.writerGeneration,
        };
        return {
            ...body,
            signature: this.peer.authority.sign(
                SignaturePurpose.OperationExecutionInputAcknowledgment,
                Proof.acknowledgment(body, receipt, {
                    input: control.permit.input,
                    inputHash: control.permit.inputHash,
                    prior: control.prior,
                }),
            ),
        };
    }

    public terminal(admission: ExecutionInputJournalAdmission): ExecutionCompletion {
        const response: ExecutionResult = {
            setupFailure: null,
            termination: ExecutionTermination.Exited,
            failure: null,
            exitCode: 0,
            stdoutBase64: '',
            stderrBase64: '',
        };
        const body: Omit<ExecutionCompletion, 'signature'> = {
            lane: admission.ready.lane,
            environmentId: admission.ready.environmentId,
            enrollmentId: admission.ready.enrollmentId,
            leaseId: this.lease.leaseId,
            jobId: admission.ready.jobId,
            sequence: admission.ready.sequence,
            dispatchId: admission.ready.dispatchId,
            requestHash: admission.ready.requestHash,
            admissionHash: admission.ready.admissionHash,
            responseHash: ExecutionProof.responseHash(response),
            response,
        };
        return {
            ...body,
            signature: this.peer.device.sign(
                SignaturePurpose.OperationExecutionResult,
                ExecutionProof.completion(body),
            ),
        };
    }

    public terminalAck(completion: ExecutionCompletion): ExecutionAcknowledgment {
        const {
            response: _response,
            signature: _signature,
            ...receipt
        }: ExecutionCompletion = completion;
        const body: Omit<ExecutionAcknowledgment, 'signature'> = {
            ...receipt,
            authorityId: this.peer.identity.authority.authorityId,
        };
        return {
            ...body,
            signature: this.peer.authority.sign(
                SignaturePurpose.OperationExecutionAcknowledgment,
                ExecutionProof.acknowledgment(body),
            ),
        };
    }

    public original(value: ExecutionInteractiveOriginal): ExecutionInteractiveOriginal {
        return {
            authorityId: value.authorityId,
            environmentId: value.environmentId,
            enrollmentId: value.enrollmentId,
            lane: value.lane,
            jobId: value.jobId,
            sequence: value.sequence,
            dispatchId: value.dispatchId,
            requestHash: value.requestHash,
            admissionHash: value.admissionHash,
            transport: value.transport,
            incarnation: value.incarnation,
        };
    }

    public request(
        launch: ExecutionInteractiveLaunch,
        rule: ExecutionInteractiveInvocationRule,
        sequence: bigint,
    ): ExecutionRequest {
        return {
            requestId: 'request-' + sequence.toString(),
            policySha256: 'b'.repeat(64),
            programId: 'machine',
            rootId: 'project',
            arguments: [ExecutionInteractiveLaunchCodec.encode(rule, launch)],
        };
    }

    public async [Symbol.asyncDispose](): Promise<void> {
        this.session[Symbol.dispose]();
        this.peer[Symbol.dispose]();
        await rm(this.root, { recursive: true, force: true });
    }
}
