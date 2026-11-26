// SPDX-FileCopyrightText: 2026 Dacely <business@dacely.com>
// SPDX-License-Identifier: LicenseRef-Proprietary

import { ConnectorOperationSchema } from 'nerva-connector-protocol/protocol/ConnectorOperationSchema.js';
import type { ConnectorLocalCapabilitySettings } from '../../src/runtime/ConnectorClientSettings.js';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import {
    ConnectorAuthorizationKind,
    type ConnectorAuthorization,
} from 'nerva-connector-protocol/protocol/ConnectorAuthorization.js';
import { ConnectorAuthorizationProof } from 'nerva-connector-protocol/protocol/ConnectorAuthorizationProof.js';
import { SigningKey } from '../../src/identity/SigningKey.js';
import { SignaturePurpose } from 'nerva-connector-protocol/identity/IdentityFormat.js';
import { ConnectorClientSession } from '../../src/runtime/ConnectorClientSession.js';
import type { ConnectorClientIdentity } from '../../src/runtime/ConnectorClientConfiguration.js';
import type {
    ConnectorDeviceHello,
    ConnectorDeviceChallenge,
    ConnectorDeviceProof,
    ConnectorDeviceLease,
} from 'nerva-connector-protocol/protocol/ConnectorDevice.js';
import { ConnectorDeviceCodec } from 'nerva-connector-protocol/protocol/ConnectorDeviceCodec.js';
import { ExecutionLane } from 'nerva-connector-protocol/execution/ExecutionLane.js';
import { ExecutionProof } from 'nerva-connector-protocol/execution/ExecutionProof.js';
import type {
    ExecutionProfile,
    ExecutionPermit,
    ExecutionRequest,
    ExecutionAcknowledgment,
    ExecutionCompletion,
    ExecutionCancellation,
} from 'nerva-connector-protocol/execution/ExecutionJobs.js';

/** Test-only private authority stays in the controller test; no production module or customer artifact imports it. */
export class ExecutionIdentity implements Disposable {
    readonly #sessions: DisposableStack = new DisposableStack();
    readonly #leases: Map<string, ConnectorClientSession> = new Map();
    public readonly device: SigningKey = SigningKey.generate();
    public readonly authority: SigningKey = SigningKey.generate();
    public readonly identity: ConnectorClientIdentity;
    public constructor(
        directory: string,
        execution: ConnectorLocalCapabilitySettings | null = null,
        files: ConnectorLocalCapabilitySettings | null = null,
    ) {
        this.identity = {
            configurationFile: join(directory, 'device.json'),
            settings: {
                authorityId: 'cloud',
                authorityPublicKeyFile: join(directory, 'authority.json'),
                environmentId: 'environment-owned',
                enrollmentId: 'conn_' + 'a'.repeat(64),
                slot: 0,
                endpoints: ['wss://example.invalid/v1/connector/tunnel'],
                privateKeyFile: join(directory, 'device-key.json'),
                serverCaFile: null,
                files,
                execution:
                    execution === null
                        ? null
                        : {
                              policyFile: execution.policyFile,
                              stateDirectory: execution.stateDirectory,
                          },
            },
            key: this.device,
            publicKey: this.device.publicKey,
            ca: undefined,
            authority: { authorityId: 'cloud', publicKey: this.authority.publicKey },
        };
    }
    /** Actual normal hello/challenge/device-proof/confirmation code establishes each replacement lease. */
    public lease(): ConnectorDeviceLease {
        const session: ConnectorClientSession = this.#sessions.use(
            new ConnectorClientSession(this.identity),
        );
        const now: bigint = BigInt(Date.now());
        const hello: ConnectorDeviceHello = session.begin(now);
        if (
            !SigningKey.verify(
                SignaturePurpose.DeviceHello,
                this.device.publicKey,
                Buffer.from(ConnectorDeviceCodec.helloPayload(hello)),
                hello.signature,
            )
        ) {
            throw new Error('Test device hello did not verify');
        }
        const value: Omit<ConnectorDeviceChallenge, 'signature'> = {
            operationSchema: ConnectorOperationSchema.ExplicitAdmission,
            authorityId: hello.authorityId,
            environmentId: hello.environmentId,
            enrollmentId: hello.enrollmentId,
            slot: hello.slot,
            publicKey: hello.publicKey,
            clientNonce: hello.nonce,
            helloSha256: ExecutionProof.digest(ConnectorDeviceCodec.helloCommitment(hello)),
            challengeId: randomBytes(32).toString('base64url'),
            leaseId: randomBytes(32).toString('base64url'),
            edgeClientId: 'edge',
            edgeWorkloadThumbprint: randomBytes(32).toString('base64url'),
            issuedAtMs: now,
            expiresAtMs: now + 30000n,
        };
        const challenge: ConnectorDeviceChallenge = {
            ...value,
            signature: this.authority.sign(
                SignaturePurpose.ServerChallenge,
                Buffer.from(ConnectorDeviceCodec.challengePayload(value)),
            ),
        };
        const proof: ConnectorDeviceProof = session.prove(challenge, now);
        if (
            !SigningKey.verify(
                SignaturePurpose.ClientAuthentication,
                this.device.publicKey,
                Buffer.from(ConnectorDeviceCodec.proofPayload(challenge)),
                proof.signature,
            )
        ) {
            throw new Error('Test device proof did not verify');
        }
        const lease: Omit<ConnectorDeviceLease, 'signature'> = {
            ...challenge,
            challengeSha256: ExecutionProof.digest(
                ConnectorDeviceCodec.challengeCommitment(challenge),
            ),
            authenticationSha256: ExecutionProof.digest(
                ConnectorDeviceCodec.proofCommitment(proof),
            ),
        };
        const confirmed: ConnectorDeviceLease = session.confirm(
            {
                ...lease,
                signature: this.authority.sign(
                    SignaturePurpose.ServerConfirmation,
                    Buffer.from(ConnectorDeviceCodec.leasePayload(lease)),
                ),
            },
            now,
        );
        this.#leases.set(confirmed.leaseId, session);
        return confirmed;
    }
    /** Only a mutually confirmed fixture session may enter the command owner. */
    public session(lease: ConnectorDeviceLease): ConnectorClientSession {
        const session: ConnectorClientSession | undefined = this.#leases.get(lease.leaseId);
        if (session === undefined) {
            throw new Error('Unknown test session');
        }
        return session;
    }
    /** Tests can deliberately modify the original metadata before signing a negative-case candidate. */
    public permit(
        profile: ExecutionProfile,
        lease: ConnectorDeviceLease,
        action: string = 'effect',
        sequence: bigint = 1n,
        lane: ExecutionLane = ExecutionLane.First,
    ): ExecutionPermit {
        const request: ExecutionRequest = {
            requestId: 'execute-' + sequence.toString(),
            policySha256: profile.policySha256,
            programId: 'probe',
            rootId: 'project',
            arguments: [action],
        };
        const authorization: ConnectorAuthorization = {
            kind: ConnectorAuthorizationKind.Independent,
        };
        const now: bigint = BigInt(Date.now());
        return this.sign({
            lane,
            authorityId: this.identity.authority.authorityId,
            environmentId: lease.environmentId,
            enrollmentId: lease.enrollmentId,
            leaseId: lease.leaseId,
            jobId: 'job-' + sequence.toString(),
            sequence,
            dispatchId: randomBytes(32).toString('base64url'),
            requestHash: ExecutionProof.requestHash(request),
            authorization,
            admissionHash: ConnectorAuthorizationProof.execution(
                ExecutionProof.requestHash(request),
                lane,
                authorization,
            ),
            request,
            issuedAtMs: now,
            expiresAtMs: now + 1000n,
            executionDeadlineMs: now + 5000n < lease.expiresAtMs ? now + 5000n : lease.expiresAtMs,
        });
    }
    /** The test backend signs with both independent components and the execution-specific purpose. */
    public sign(value: Omit<ExecutionPermit, 'signature'>): ExecutionPermit {
        return {
            ...value,
            signature: this.authority.sign(
                SignaturePurpose.OperationExecutionPermit,
                ExecutionProof.permit(value),
            ),
        };
    }
    /** Only the fixture backend can issue an independently purpose-bound stop for a previously admitted original. */
    public cancel(original: ExecutionPermit, lease: ConnectorDeviceLease): ExecutionCancellation {
        const now: bigint = BigInt(Date.now());
        return this.signCancellation({
            authorityId: original.authorityId,
            environmentId: original.environmentId,
            enrollmentId: original.enrollmentId,
            lane: original.lane,
            leaseId: lease.leaseId,
            jobId: original.jobId,
            sequence: original.sequence,
            dispatchId: original.dispatchId,
            requestHash: original.requestHash,
            admissionHash: original.admissionHash,
            authorization: original.authorization,
            request: original.request,
            issuedAtMs: now,
            expiresAtMs: now + 1000n,
        });
    }
    /** Negative tests can sign malformed targets with valid composite cryptography. */
    public signCancellation(
        value: Omit<ExecutionCancellation, 'signature'>,
    ): ExecutionCancellation {
        return {
            ...value,
            signature: this.authority.sign(
                SignaturePurpose.OperationExecutionCancellation,
                ExecutionProof.cancellation(value),
            ),
        };
    }
    /** Acknowledgment is emitted only by the test after independently verifying the device completion. */
    public ack(value: ExecutionCompletion): ExecutionAcknowledgment {
        if (
            !SigningKey.verify(
                SignaturePurpose.OperationExecutionResult,
                this.device.publicKey,
                ExecutionProof.completion(value),
                value.signature,
            ) ||
            ExecutionProof.responseHash(value.response) !== value.responseHash
        ) {
            throw new Error('Test completion did not verify');
        }
        const receipt: Omit<ExecutionAcknowledgment, 'signature'> = {
            lane: value.lane,
            authorityId: this.identity.authority.authorityId,
            environmentId: value.environmentId,
            enrollmentId: value.enrollmentId,
            leaseId: value.leaseId,
            jobId: value.jobId,
            sequence: value.sequence,
            dispatchId: value.dispatchId,
            requestHash: value.requestHash,
            admissionHash: value.admissionHash,
            responseHash: value.responseHash,
        };
        return {
            ...receipt,
            signature: this.authority.sign(
                SignaturePurpose.OperationExecutionAcknowledgment,
                ExecutionProof.acknowledgment(receipt),
            ),
        };
    }
    /** Independent test keys are erased after every assertion path. */
    public [Symbol.dispose](): void {
        this.#sessions[Symbol.dispose]();
        this.#leases.clear();
        this.device[Symbol.dispose]();
        this.authority[Symbol.dispose]();
    }
}
