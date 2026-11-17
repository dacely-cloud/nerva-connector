// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

import { randomBytes } from 'node:crypto';
import { expect, it, vi, type MockInstance } from 'vitest';
import { SigningKey } from '../src/identity/SigningKey.js';
import {
    IdentityLengths,
    SignaturePurpose,
} from 'nerva-connector-protocol/identity/IdentityFormat.js';
import { ConnectorDeviceCodec } from 'nerva-connector-protocol/protocol/ConnectorDeviceCodec.js';
import type {
    ConnectorDeviceHello,
    ConnectorDeviceChallenge,
    ConnectorDeviceProof,
    ConnectorDeviceLease,
} from 'nerva-connector-protocol/protocol/ConnectorDevice.js';
import { ConnectorClientSession } from '../src/runtime/ConnectorClientSession.js';
import { ConnectorSessionFixture } from './support/ConnectorSessionFixture.js';

/** Each substitution targets a distinct required handshake commitment. */
enum SessionSubstitution {
    Nonce = 'nonce',
    Environment = 'environment',
    Hello = 'hello',
    Lease = 'lease',
    Challenge = 'challenge',
    Proof = 'proof',
    Deadline = 'deadline',
}

it('normal authentication requires both server proofs and a fresh hello on every renewal', (): void => {
    using fixture: ConnectorSessionFixture = new ConnectorSessionFixture();
    using session: ConnectorClientSession = new ConnectorClientSession(fixture.identity);
    expect((): void => {
        ConnectorClientSession.current(session, fixture.now);
    }).toThrow();
    const hello: ConnectorDeviceHello = session.begin(fixture.now);
    expect(
        SigningKey.verify(
            SignaturePurpose.DeviceHello,
            fixture.device.publicKey,
            Buffer.from(ConnectorDeviceCodec.helloPayload(hello)),
            hello.signature,
        ),
    ).toBe(true);
    const challenge: ConnectorDeviceChallenge = fixture.challenge(hello);
    const proof: ConnectorDeviceProof = session.prove(challenge, fixture.now);
    expect((): void => {
        ConnectorClientSession.current(session, fixture.now);
    }).toThrow();
    expect(
        SigningKey.verify(
            SignaturePurpose.ClientAuthentication,
            fixture.device.publicKey,
            Buffer.from(ConnectorDeviceCodec.proofPayload(challenge)),
            proof.signature,
        ),
    ).toBe(true);
    const lease: ConnectorDeviceLease = session.confirm(
        fixture.confirmation(challenge, proof),
        fixture.now,
    );
    expect(lease.leaseId).toBe(challenge.leaseId);
    expect(lease.expiresAtMs).toBe(challenge.expiresAtMs);
    expect(ConnectorClientSession.current(session, fixture.now)).toBe(lease);
    expect(session.begin(fixture.now + 15000n).nonce).not.toBe(hello.nonce);
    expect(ConnectorClientSession.current(session, fixture.now + 15000n)).toBe(lease);
    expect((): ConnectorDeviceLease => session.confirm(lease, fixture.now + 15000n)).toThrow();
    expect((): void => {
        ConnectorClientSession.current(session, fixture.now + 15000n);
    }).toThrow();
});

it.each([0, IdentityLengths.mlDsaSignature])(
    'a corrupt server challenge component at byte %s cannot induce a device proof',
    (offset: number): void => {
        using fixture: ConnectorSessionFixture = new ConnectorSessionFixture();
        using session: ConnectorClientSession = new ConnectorClientSession(fixture.identity);
        const challenge: ConnectorDeviceChallenge = fixture.challenge(session.begin(fixture.now));
        const signature: Buffer = Buffer.from(challenge.signature, 'base64url');
        signature[offset] = (signature[offset] ?? 0) ^ 1;
        const sign: MockInstance<SigningKey['sign']> = vi.spyOn(fixture.device, 'sign');
        try {
            expect((): ConnectorDeviceProof =>
                session.prove(
                    { ...challenge, signature: signature.toString('base64url') },
                    fixture.now,
                ),
            ).toThrow();
            expect(sign).not.toHaveBeenCalled();
        } finally {
            sign.mockRestore();
        }
        expect((): ConnectorDeviceProof => session.prove(challenge, fixture.now)).toThrow();
    },
);

it.each([SessionSubstitution.Nonce, SessionSubstitution.Environment, SessionSubstitution.Hello])(
    'a correctly signed challenge cannot substitute its %s binding',
    (binding: SessionSubstitution): void => {
        using fixture: ConnectorSessionFixture = new ConnectorSessionFixture();
        using session: ConnectorClientSession = new ConnectorClientSession(fixture.identity);
        const original: ConnectorDeviceChallenge = fixture.challenge(session.begin(fixture.now));
        const changed: ConnectorDeviceChallenge = fixture.signChallenge({
            ...original,
            clientNonce:
                binding === SessionSubstitution.Nonce
                    ? randomBytes(32).toString('base64url')
                    : original.clientNonce,
            environmentId:
                binding === SessionSubstitution.Environment
                    ? 'another-environment'
                    : original.environmentId,
            helloSha256:
                binding === SessionSubstitution.Hello ? 'b'.repeat(64) : original.helloSha256,
        });
        expect((): ConnectorDeviceProof => session.prove(changed, fixture.now)).toThrow();
    },
);

it.each([0, IdentityLengths.mlDsaSignature])(
    'a corrupt confirmation component at byte %s cannot activate a lease',
    (offset: number): void => {
        using fixture: ConnectorSessionFixture = new ConnectorSessionFixture();
        using session: ConnectorClientSession = new ConnectorClientSession(fixture.identity);
        const challenge: ConnectorDeviceChallenge = fixture.challenge(session.begin(fixture.now));
        const proof: ConnectorDeviceProof = session.prove(challenge, fixture.now);
        const original: ConnectorDeviceLease = fixture.confirmation(challenge, proof);
        const signature: Buffer = Buffer.from(original.signature, 'base64url');
        signature[offset] = (signature[offset] ?? 0) ^ 1;
        expect((): ConnectorDeviceLease =>
            session.confirm(
                { ...original, signature: signature.toString('base64url') },
                fixture.now,
            ),
        ).toThrow();
        expect((): ConnectorDeviceLease => session.confirm(original, fixture.now)).toThrow();
    },
);

it.each([
    SessionSubstitution.Lease,
    SessionSubstitution.Challenge,
    SessionSubstitution.Proof,
    SessionSubstitution.Deadline,
])(
    'a signed confirmation cannot change its original %s commitment',
    (binding: SessionSubstitution): void => {
        using fixture: ConnectorSessionFixture = new ConnectorSessionFixture();
        using session: ConnectorClientSession = new ConnectorClientSession(fixture.identity);
        const challenge: ConnectorDeviceChallenge = fixture.challenge(session.begin(fixture.now));
        const proof: ConnectorDeviceProof = session.prove(challenge, fixture.now);
        const original: ConnectorDeviceLease = fixture.confirmation(challenge, proof);
        const changed: ConnectorDeviceLease = fixture.signLease({
            ...original,
            leaseId:
                binding === SessionSubstitution.Lease
                    ? randomBytes(32).toString('base64url')
                    : original.leaseId,
            challengeSha256:
                binding === SessionSubstitution.Challenge
                    ? 'b'.repeat(64)
                    : original.challengeSha256,
            authenticationSha256:
                binding === SessionSubstitution.Proof
                    ? 'b'.repeat(64)
                    : original.authenticationSha256,
            issuedAtMs:
                binding === SessionSubstitution.Deadline
                    ? original.issuedAtMs + 1n
                    : original.issuedAtMs,
            expiresAtMs:
                binding === SessionSubstitution.Deadline
                    ? original.expiresAtMs + 1n
                    : original.expiresAtMs,
        });
        expect((): ConnectorDeviceLease => session.confirm(changed, fixture.now)).toThrow();
    },
);
