// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

import { createHash, randomBytes } from 'node:crypto';
import { SigningKey } from '../../src/identity/SigningKey.js';
import { SignaturePurpose } from 'nerva-connector-protocol/identity/IdentityFormat.js';
import { ConnectorOperationSchema } from 'nerva-connector-protocol/protocol/ConnectorOperationSchema.js';
import { ConnectorDeviceCodec } from 'nerva-connector-protocol/protocol/ConnectorDeviceCodec.js';
import type {
    ConnectorDeviceHello,
    ConnectorDeviceChallenge,
    ConnectorDeviceProof,
    ConnectorDeviceLease,
} from 'nerva-connector-protocol/protocol/ConnectorDevice.js';
import type { ConnectorClientIdentity } from '../../src/runtime/ConnectorClientConfiguration.js';

/** Unit peers sign candidate frames; real workload/account authorization is tested through the actual private API. */
export class ConnectorSessionFixture implements Disposable {
    /** Device private material belongs only to this test fixture and is erased on disposal. */
    public readonly device: SigningKey = SigningKey.generate();
    /** The independent fixture authority signs the ordinary receiver-verified server transcript. */
    public readonly authority: SigningKey = SigningKey.generate();
    /** One exact receiver-clock sample bounds each fixture lease. */
    public readonly now: bigint = BigInt(Date.now());
    /** Controlled configuration contains no real enrollment or production credential. */
    public readonly identity: ConnectorClientIdentity = {
        configurationFile: '/fixture/device.json',
        settings: {
            authorityId: 'cloud',
            authorityPublicKeyFile: '/fixture/authority.json',
            environmentId: 'env-owned',
            enrollmentId: 'conn_' + 'a'.repeat(64),
            slot: 0,
            endpoints: ['wss://example.invalid/v1/connector/tunnel'],
            privateKeyFile: '/fixture/key.json',
            serverCaFile: null,
            files: null,
            execution: null,
        },
        authority: { authorityId: 'cloud', publicKey: this.authority.publicKey },
        key: this.device,
        publicKey: this.device.publicKey,
        ca: undefined,
    };
    /** A candidate challenge binds the fresh device nonce and one preselected lease. */
    public challenge(hello: ConnectorDeviceHello): ConnectorDeviceChallenge {
        return this.signChallenge({
            operationSchema: ConnectorOperationSchema.ExplicitAdmission,
            authorityId: hello.authorityId,
            environmentId: hello.environmentId,
            enrollmentId: hello.enrollmentId,
            slot: hello.slot,
            publicKey: hello.publicKey,
            clientNonce: hello.nonce,
            helloSha256: this.digest(ConnectorDeviceCodec.helloCommitment(hello)),
            challengeId: randomBytes(32).toString('base64url'),
            leaseId: randomBytes(32).toString('base64url'),
            edgeClientId: 'edge',
            edgeWorkloadThumbprint: randomBytes(32).toString('base64url'),
            issuedAtMs: this.now,
            expiresAtMs: this.now + 30000n,
        });
    }
    /** Correct authority signatures must not excuse a changed expected target. */
    public signChallenge(
        value: Omit<ConnectorDeviceChallenge, 'signature'>,
    ): ConnectorDeviceChallenge {
        return {
            ...value,
            signature: this.authority.sign(
                SignaturePurpose.ServerChallenge,
                Buffer.from(ConnectorDeviceCodec.challengePayload(value)),
            ),
        };
    }
    /** Both original proofs are committed separately before confirmation. */
    public confirmation(
        challenge: ConnectorDeviceChallenge,
        proof: ConnectorDeviceProof,
    ): ConnectorDeviceLease {
        return this.signLease({
            ...challenge,
            challengeSha256: this.digest(ConnectorDeviceCodec.challengeCommitment(challenge)),
            authenticationSha256: this.digest(ConnectorDeviceCodec.proofCommitment(proof)),
        });
    }
    /** Confirmation uses a separate receiver-selected purpose. */
    public signLease(value: Omit<ConnectorDeviceLease, 'signature'>): ConnectorDeviceLease {
        return {
            ...value,
            signature: this.authority.sign(
                SignaturePurpose.ServerConfirmation,
                Buffer.from(ConnectorDeviceCodec.leasePayload(value)),
            ),
        };
    }
    /** Commitments hash the finite exact canonical transcript. */
    public digest(value: string): string {
        return createHash('sha256').update(value).digest('hex');
    }
    /** Owned keys are erased after success or a failing negative assertion. */
    public [Symbol.dispose](): void {
        this.device[Symbol.dispose]();
        this.authority[Symbol.dispose]();
    }
}
