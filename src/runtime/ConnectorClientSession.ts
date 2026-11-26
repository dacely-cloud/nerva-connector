// SPDX-FileCopyrightText: 2026 Dacely <business@dacely.com>
// SPDX-License-Identifier: LicenseRef-Proprietary

import { ConnectorClock } from '../protocol/ConnectorClock.js';
import { createHash, randomBytes } from 'node:crypto';
import { SignaturePurpose } from 'nerva-connector-protocol/identity/IdentityFormat.js';
import { SigningKey } from '../identity/SigningKey.js';
import { ConnectorInventoryCodec } from 'nerva-connector-protocol/protocol/ConnectorInventoryCodec.js';
import type { ConnectorInventoryPublication } from 'nerva-connector-protocol/protocol/ConnectorInventory.js';
import { SystemSpecificationCodec } from 'nerva-connector-protocol/system/SystemSpecificationCodec.js';
import type { SystemSpecification } from 'nerva-connector-protocol/system/SystemSpecification.js';
import { ConnectorDeviceCodec } from 'nerva-connector-protocol/protocol/ConnectorDeviceCodec.js';
import { ConnectorOperationSchema } from 'nerva-connector-protocol/protocol/ConnectorOperationSchema.js';
import type {
    ConnectorDeviceHello,
    ConnectorDeviceChallenge,
    ConnectorDeviceProof,
    ConnectorDeviceLease,
} from 'nerva-connector-protocol/protocol/ConnectorDevice.js';
import type { ConnectorClientIdentity } from './ConnectorClientConfiguration.js';

/** One handshake may await its challenge or exact consumed-proof confirmation; a confirmed older lease survives renewal until replaced. */
export enum ConnectorSessionPhase {
    Ready = 'ready',
    AwaitingChallenge = 'awaiting-challenge',
    AwaitingConfirmation = 'awaiting-confirmation',
    Authenticated = 'authenticated',
    Closed = 'closed',
}

/** The normal outbound connection proves identity only to its installed composite authority and reviewed environment. */
export class ConnectorClientSession implements Disposable {
    #phase: ConnectorSessionPhase = ConnectorSessionPhase.Ready;
    #hello: ConnectorDeviceHello | null = null;
    #challenge: ConnectorDeviceChallenge | null = null;
    #proof: ConnectorDeviceProof | null = null;
    #lease: ConnectorDeviceLease | null = null;
    #lastIssuedAtMs: bigint = -1n;

    /** Configuration, authority and identity are captured before the transport opens. The caller owns the key lifetime. */
    public constructor(public readonly identity: ConnectorClientIdentity) {}

    /** A fresh signed hello is necessary for initial connection and renewal; no untrusted server frame can choose its nonce. */
    public begin(nowMs: bigint): ConnectorDeviceHello {
        if (
            (this.#phase !== ConnectorSessionPhase.Ready &&
                this.#phase !== ConnectorSessionPhase.Authenticated) ||
            nowMs <= this.#lastIssuedAtMs
        ) {
            throw new Error('Connector handshake is unavailable or its clock did not advance');
        }
        const unsigned: Omit<ConnectorDeviceHello, 'signature'> = {
            operationSchema: ConnectorOperationSchema.ExplicitAdmission,
            authorityId: this.identity.authority.authorityId,
            environmentId: this.identity.settings.environmentId,
            enrollmentId: this.identity.settings.enrollmentId,
            slot: this.identity.settings.slot,
            publicKey: this.identity.publicKey,
            nonce: randomBytes(32).toString('base64url'),
            issuedAtMs: nowMs,
        };
        const hello: ConnectorDeviceHello = {
            ...unsigned,
            signature: this.identity.key.sign(
                SignaturePurpose.DeviceHello,
                Buffer.from(ConnectorDeviceCodec.helloPayload(unsigned)),
            ),
        };
        this.#hello = hello;
        this.#challenge = null;
        this.#proof = null;
        this.#lastIssuedAtMs = nowMs;
        this.#phase = ConnectorSessionPhase.AwaitingChallenge;
        return hello;
    }

    /** Verify both authority signatures and the exact locally generated hello before returning a device authentication proof. */
    public prove(input: ConnectorDeviceChallenge, nowMs: bigint): ConnectorDeviceProof {
        try {
            const hello: ConnectorDeviceHello | null = this.#hello;
            const challenge: ConnectorDeviceChallenge = ConnectorDeviceCodec.challenge(
                JSON.parse(ConnectorDeviceCodec.encode(input)),
            );
            if (
                this.#phase !== ConnectorSessionPhase.AwaitingChallenge ||
                hello === null ||
                challenge.operationSchema !== hello.operationSchema ||
                challenge.authorityId !== hello.authorityId ||
                challenge.environmentId !== hello.environmentId ||
                challenge.enrollmentId !== hello.enrollmentId ||
                challenge.slot !== hello.slot ||
                challenge.publicKey !== hello.publicKey ||
                challenge.clientNonce !== hello.nonce ||
                challenge.helloSha256 !==
                    this.#digest(ConnectorDeviceCodec.helloCommitment(hello)) ||
                !this.#current(challenge, nowMs) ||
                !SigningKey.verify(
                    SignaturePurpose.ServerChallenge,
                    this.identity.authority.publicKey,
                    Buffer.from(ConnectorDeviceCodec.challengePayload(challenge)),
                    challenge.signature,
                )
            ) {
                throw new Error('Connector authority challenge rejected');
            }
            const proof: ConnectorDeviceProof = {
                enrollmentId: challenge.enrollmentId,
                slot: challenge.slot,
                challengeId: challenge.challengeId,
                signature: this.identity.key.sign(
                    SignaturePurpose.ClientAuthentication,
                    Buffer.from(ConnectorDeviceCodec.proofPayload(challenge)),
                ),
            };
            this.#challenge = challenge;
            this.#proof = proof;
            this.#phase = ConnectorSessionPhase.AwaitingConfirmation;
            return proof;
        } catch (caught: unknown) {
            this[Symbol.dispose]();
            throw caught;
        }
    }

    /** Authentication is observable only after both authority signatures confirm the exact admitted challenge and device proof. */
    public confirm(input: ConnectorDeviceLease, nowMs: bigint): ConnectorDeviceLease {
        try {
            const challenge: ConnectorDeviceChallenge | null = this.#challenge;
            const proof: ConnectorDeviceProof | null = this.#proof;
            const lease: ConnectorDeviceLease = ConnectorDeviceCodec.lease(
                JSON.parse(ConnectorDeviceCodec.encode(input)),
            );
            if (
                this.#phase !== ConnectorSessionPhase.AwaitingConfirmation ||
                challenge === null ||
                proof === null ||
                ConnectorDeviceCodec.challengePayload(lease) !==
                    ConnectorDeviceCodec.challengePayload(challenge) ||
                lease.challengeSha256 !==
                    this.#digest(ConnectorDeviceCodec.challengeCommitment(challenge)) ||
                lease.authenticationSha256 !==
                    this.#digest(ConnectorDeviceCodec.proofCommitment(proof)) ||
                !this.#current(lease, nowMs) ||
                !SigningKey.verify(
                    SignaturePurpose.ServerConfirmation,
                    this.identity.authority.publicKey,
                    Buffer.from(ConnectorDeviceCodec.leasePayload(lease)),
                    lease.signature,
                )
            ) {
                throw new Error('Connector authority confirmation rejected');
            }
            this.#lease = Object.freeze(lease);
            this.#phase = ConnectorSessionPhase.Authenticated;
            return lease;
        } catch (caught: unknown) {
            this[Symbol.dispose]();
            throw caught;
        }
    }

    /** An operation owner can borrow only this actually confirmed current lease, including an unexpired lease during renewal. */
    public static current(session: ConnectorClientSession, nowMs: bigint): ConnectorDeviceLease {
        const lease: ConnectorDeviceLease | null = session.#lease;
        if (
            session.#phase === ConnectorSessionPhase.Closed ||
            lease === null ||
            !session.#current(lease, nowMs)
        ) {
            throw new Error('Confirmed connector session is unavailable');
        }
        return lease;
    }

    /** Only the exact mutually confirmed current lease may publish a finite signed metadata snapshot. */
    public inventory(
        specification: SystemSpecification,
        leaseId: string,
        nowMs: bigint,
    ): ConnectorInventoryPublication {
        const lease: ConnectorDeviceLease | null = this.#lease;
        if (
            this.#phase !== ConnectorSessionPhase.Authenticated ||
            lease === null ||
            lease.leaseId !== leaseId ||
            !this.#current(lease, nowMs)
        ) {
            throw new Error('Confirmed connector metadata lane unavailable');
        }
        const unsigned: Omit<ConnectorInventoryPublication, 'signature'> = {
            authorityId: lease.authorityId,
            environmentId: lease.environmentId,
            enrollmentId: lease.enrollmentId,
            slot: lease.slot,
            leaseId,
            leaseSha256: this.#digest(ConnectorDeviceCodec.leaseCommitment(lease)),
            specification: SystemSpecificationCodec.read(specification),
        };
        return {
            ...unsigned,
            signature: this.identity.key.sign(
                SignaturePurpose.Inventory,
                Buffer.from(ConnectorInventoryCodec.payload(unsigned)),
            ),
        };
    }

    /** Closing retires this handshake without disposing the identity or resetting retained file state. */
    public [Symbol.dispose](): void {
        this.#phase = ConnectorSessionPhase.Closed;
        this.#lease = null;
        this.#hello = null;
        this.#challenge = null;
        this.#proof = null;
    }
    #current(value: ConnectorDeviceChallenge, nowMs: bigint): boolean {
        return ConnectorClock.issued(value.issuedAtMs, nowMs) && value.expiresAtMs > nowMs;
    }
    #digest(value: string): string {
        return createHash('sha256').update(value).digest('hex');
    }
}
