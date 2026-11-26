// SPDX-FileCopyrightText: 2026 Dacely <business@dacely.com>
// SPDX-License-Identifier: LicenseRef-Proprietary

import { randomBytes } from 'node:crypto';
import { ConnectorOperationSchema } from 'nerva-connector-protocol/protocol/ConnectorOperationSchema.js';
import { ConnectorDeviceCodec } from 'nerva-connector-protocol/protocol/ConnectorDeviceCodec.js';
import type {
    ConnectorDeviceChallenge,
    ConnectorDeviceLease,
    ConnectorDeviceProof,
} from 'nerva-connector-protocol/protocol/ConnectorDevice.js';
import { ConnectorClientSession } from '../../src/runtime/ConnectorClientSession.js';
import type { ConnectorClientIdentity } from '../../src/runtime/ConnectorClientConfiguration.js';
import type { SigningKey } from '../../src/identity/SigningKey.js';
import { SignaturePurpose } from 'nerva-connector-protocol/identity/IdentityFormat.js';
import { ExecutionProof } from 'nerva-connector-protocol/execution/ExecutionProof.js';

/** Both real signature components confirm an already-aged finite fixture lease; no real account service is simulated. */
export interface ExecutionDeadlineLease {
    readonly session: ConnectorClientSession;
    readonly lease: ConnectorDeviceLease;
}

/** The ordinary hello/challenge/device-proof/confirmation path authenticates the exact retained clock samples. */
export function deadlineLease(
    identity: ConnectorClientIdentity,
    authority: SigningKey,
): ExecutionDeadlineLease {
    const session: ConnectorClientSession = new ConnectorClientSession(identity);
    try {
        const now: bigint = BigInt(Date.now());
        const issuedAtMs: bigint = now - 25000n;
        const hello: ReturnType<ConnectorClientSession['begin']> = session.begin(issuedAtMs);
        const body: Omit<ConnectorDeviceChallenge, 'signature'> = {
            operationSchema: ConnectorOperationSchema.ExplicitAdmission,
            authorityId: identity.authority.authorityId,
            environmentId: identity.settings.environmentId,
            enrollmentId: identity.settings.enrollmentId,
            slot: 0,
            publicKey: identity.publicKey,
            clientNonce: hello.nonce,
            helloSha256: ExecutionProof.digest(ConnectorDeviceCodec.helloCommitment(hello)),
            challengeId: randomBytes(32).toString('base64url'),
            leaseId: randomBytes(32).toString('base64url'),
            edgeClientId: 'deadline-edge',
            edgeWorkloadThumbprint: randomBytes(32).toString('base64url'),
            issuedAtMs,
            expiresAtMs: now + 5000n,
        };
        const challenge: ConnectorDeviceChallenge = {
            ...body,
            signature: authority.sign(
                SignaturePurpose.ServerChallenge,
                Buffer.from(ConnectorDeviceCodec.challengePayload(body)),
            ),
        };
        const proof: ConnectorDeviceProof = session.prove(challenge, now);
        const unsigned: Omit<ConnectorDeviceLease, 'signature'> = {
            ...challenge,
            challengeSha256: ExecutionProof.digest(
                ConnectorDeviceCodec.challengeCommitment(challenge),
            ),
            authenticationSha256: ExecutionProof.digest(
                ConnectorDeviceCodec.proofCommitment(proof),
            ),
        };
        return {
            session,
            lease: session.confirm(
                {
                    ...unsigned,
                    signature: authority.sign(
                        SignaturePurpose.ServerConfirmation,
                        Buffer.from(ConnectorDeviceCodec.leasePayload(unsigned)),
                    ),
                },
                now,
            ),
        };
    } catch (error: unknown) {
        session[Symbol.dispose]();
        throw error;
    }
}
