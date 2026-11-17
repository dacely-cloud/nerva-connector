// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

import type { Duplex } from 'node:stream';
import { randomBytes } from 'node:crypto';
import { SigningKey } from '../../src/identity/SigningKey.js';
import { SignaturePurpose } from 'nerva-connector-protocol/identity/IdentityFormat.js';
import { ConnectorDeviceCodec } from 'nerva-connector-protocol/protocol/ConnectorDeviceCodec.js';
import { ConnectorOperationSchema } from 'nerva-connector-protocol/protocol/ConnectorOperationSchema.js';
import type {
    ConnectorDeviceChallenge,
    ConnectorDeviceLease,
} from 'nerva-connector-protocol/protocol/ConnectorDevice.js';
import {
    ConnectorFrameKind,
    ConnectorTransportCodec,
    type ConnectorClientFrame,
    type ConnectorServerFrame,
} from '../../src/protocol/ConnectorTransport.js';
import type { ConnectorSessionFixture } from './ConnectorSessionFixture.js';

/** Supplies the lane frames an authority had already sent on the replaced lease when the renewal hello reached it. */
export type ConnectorRenewalCrossing = (
    replaced: ConnectorDeviceLease,
) => readonly ConnectorServerFrame[];

/** A bounded test-only authority that renews leases on one real TLS socket and records every device frame. */
export class ConnectorRenewalPeer {
    readonly #frames: ConnectorClientFrame[] = [];
    readonly #closed: PromiseWithResolvers<undefined> = Promise.withResolvers<undefined>();
    #changed: PromiseWithResolvers<undefined> = Promise.withResolvers<undefined>();
    #buffer: Buffer = Buffer.alloc(0);
    #challenge: ConnectorDeviceChallenge | null = null;
    #lease: ConnectorDeviceLease | null = null;
    #leases: number = 0;
    #ended: boolean = false;
    #failure: Error | null = null;
    #closeCode: number | null = null;
    #closeReason: string | null = null;

    /**
     * Only this fixture's real TLS socket is read; no customer, cloud or controller credential participates.
     *
     * @remarks
     * Socket errors are not failures here: a device that terminates its socket is observed through closure.
     *
     * @param lifetimesMs - Lease lifetime of each successive handshake; the last entry applies to later ones
     * @param crossing - Frames sent on the replaced lease after a renewal hello and before its challenge
     */
    public constructor(
        public readonly socket: Duplex,
        public readonly session: ConnectorSessionFixture,
        public readonly lifetimesMs: readonly bigint[],
        public readonly crossing: ConnectorRenewalCrossing,
    ) {
        socket.on('data', (chunk: Buffer): void => {
            try {
                this.#read(chunk);
            } catch (caught: unknown) {
                this.#failure =
                    caught instanceof Error ? caught : new Error('Renewal peer rejected frame');
                socket.destroy();
            }
        });
        socket.on('error', (): void => undefined);
        socket.once('close', (): void => {
            this.#ended = true;
            this.#closed.resolve(undefined);
            this.#changed.resolve(undefined);
        });
    }

    /** Resolves when the device or the fixture closes the socket. */
    public get closed(): Promise<undefined> {
        return this.#closed.promise;
    }

    /** True once the device or the fixture has closed the socket. */
    public get ended(): boolean {
        return this.#ended;
    }

    /** The close code the device sent in its close frame, or `null` when it sent none. */
    public get closeCode(): number | null {
        return this.#closeCode;
    }

    /** The close reason the device sent in its close frame, or `null` when it sent none. */
    public get closeReason(): string | null {
        return this.#closeReason;
    }

    /** Number of leases confirmed on this socket. */
    public get leases(): number {
        return this.#leases;
    }

    /** The most recently confirmed lease. */
    public get lease(): ConnectorDeviceLease {
        if (this.#lease === null) {
            throw new Error('No renewal peer lease is confirmed');
        }
        return this.#lease;
    }

    /** A finite copy of every device frame received so far. */
    public get frames(): readonly ConnectorClientFrame[] {
        return this.#frames.slice();
    }

    /** Any malformed or unexpected device frame must fail the test instead of becoming a silent retry. */
    public assertHealthy(): void {
        if (this.#failure !== null) {
            throw this.#failure;
        }
    }

    /** Waits for the first recorded device frame accepted by the guard, failing on closure or after a finite bound. */
    public async next<Frame extends ConnectorClientFrame>(
        guard: (frame: ConnectorClientFrame) => frame is Frame,
    ): Promise<Frame> {
        const deadline: number = performance.now() + 10000;
        for (;;) {
            this.assertHealthy();
            const found: Frame | undefined = this.#frames.find(guard);
            if (found !== undefined) {
                return found;
            }
            if (this.#ended) {
                throw new Error('Renewal peer socket closed before the expected frame');
            }
            const remaining: number = deadline - performance.now();
            if (remaining <= 0) {
                throw new Error('Renewal peer frame timed out');
            }
            let timer: NodeJS.Timeout | undefined;
            try {
                await Promise.race([
                    this.#changed.promise,
                    new Promise<undefined>((resolve: (value: undefined) => void): void => {
                        timer = setTimeout((): void => resolve(undefined), remaining);
                    }),
                ]);
            } finally {
                clearTimeout(timer);
            }
        }
    }

    /** Sends one bounded unmasked server text frame. */
    public send(frame: ConnectorServerFrame): void {
        const payload: Buffer = Buffer.from(ConnectorTransportCodec.encode(frame));
        if (payload.length > 65535) {
            throw new Error('Renewal peer response budget exceeded');
        }
        const header: Buffer = Buffer.alloc(4);
        header[0] = 0x81;
        header[1] = 126;
        header.writeUInt16BE(payload.length, 2);
        this.socket.write(Buffer.concat([header, payload]));
    }

    #read(chunk: Buffer): void {
        if (this.#buffer.byteLength + chunk.byteLength > 262144) {
            throw new Error('Renewal peer input budget exceeded');
        }
        this.#buffer = Buffer.concat([this.#buffer, chunk]);
        while (this.#buffer.length >= 6) {
            const opcode: number | undefined = this.#buffer[0];
            const mask: number | undefined = this.#buffer[1];
            if (
                (opcode !== 0x81 && opcode !== 0x88) ||
                mask === undefined ||
                (mask & 0x80) === 0 ||
                (mask & 0x7f) === 127
            ) {
                throw new Error('Renewal peer accepts bounded masked text and close frames only');
            }
            const extended: boolean = (mask & 0x7f) === 126;
            const length: number = extended ? this.#buffer.readUInt16BE(2) : mask & 0x7f;
            const header: number = extended ? 4 : 2;
            if (this.#buffer.length < header + 4 + length) {
                return;
            }
            const payload: Buffer = Buffer.from(
                this.#buffer.subarray(header + 4, header + 4 + length),
            );
            for (let index: number = 0; index < payload.length; index++) {
                const value: number | undefined = payload[index];
                const key: number | undefined = this.#buffer[header + (index % 4)];
                if (value === undefined || key === undefined) {
                    throw new Error('Renewal peer frame masking changed');
                }
                payload[index] = value ^ key;
            }
            this.#buffer = this.#buffer.subarray(header + 4 + length);
            if (opcode === 0x88) {
                this.#closeCode = payload.length >= 2 ? payload.readUInt16BE(0) : null;
                this.#closeReason = new TextDecoder('utf-8', { fatal: true }).decode(
                    payload.subarray(2),
                );
                this.socket.end();
                return;
            }
            this.#receive(
                ConnectorTransportCodec.client(
                    new TextDecoder('utf-8', { fatal: true }).decode(payload),
                ),
            );
        }
    }

    #receive(frame: ConnectorClientFrame): void {
        this.#frames.push(frame);
        const changed: PromiseWithResolvers<undefined> = this.#changed;
        this.#changed = Promise.withResolvers<undefined>();
        changed.resolve(undefined);
        if (frame.kind === ConnectorFrameKind.Hello) {
            if (
                this.#challenge !== null ||
                !SigningKey.verify(
                    SignaturePurpose.DeviceHello,
                    this.session.device.publicKey,
                    Buffer.from(ConnectorDeviceCodec.helloPayload(frame.hello)),
                    frame.hello.signature,
                )
            ) {
                throw new Error('Renewal peer rejected device hello');
            }
            const now: bigint = BigInt(Date.now());
            const lifetime: bigint | undefined =
                this.lifetimesMs[Math.min(this.#leases, this.lifetimesMs.length - 1)];
            if (lifetime === undefined) {
                throw new Error('Renewal peer lease lifetime required');
            }
            this.#challenge = this.session.signChallenge({
                operationSchema: ConnectorOperationSchema.ExplicitAdmission,
                authorityId: frame.hello.authorityId,
                environmentId: frame.hello.environmentId,
                enrollmentId: frame.hello.enrollmentId,
                slot: frame.hello.slot,
                publicKey: frame.hello.publicKey,
                clientNonce: frame.hello.nonce,
                helloSha256: this.session.digest(ConnectorDeviceCodec.helloCommitment(frame.hello)),
                challengeId: randomBytes(32).toString('base64url'),
                leaseId: randomBytes(32).toString('base64url'),
                edgeClientId: 'edge',
                edgeWorkloadThumbprint: randomBytes(32).toString('base64url'),
                issuedAtMs: now,
                expiresAtMs: now + lifetime,
            });
            if (this.#lease !== null) {
                for (const crossing of this.crossing(this.#lease)) {
                    this.send(crossing);
                }
            }
            this.send({ kind: ConnectorFrameKind.Challenge, challenge: this.#challenge });
        } else if (frame.kind === ConnectorFrameKind.Proof) {
            const challenge: ConnectorDeviceChallenge | null = this.#challenge;
            if (
                challenge === null ||
                frame.challengeId !== challenge.challengeId ||
                !SigningKey.verify(
                    SignaturePurpose.ClientAuthentication,
                    this.session.device.publicKey,
                    Buffer.from(ConnectorDeviceCodec.proofPayload(challenge)),
                    frame.signature,
                )
            ) {
                throw new Error('Renewal peer rejected device proof');
            }
            this.#challenge = null;
            this.#lease = this.session.confirmation(challenge, {
                enrollmentId: challenge.enrollmentId,
                slot: challenge.slot,
                challengeId: frame.challengeId,
                signature: frame.signature,
            });
            this.#leases++;
            this.send({ kind: ConnectorFrameKind.Authenticated, lease: this.#lease });
        }
    }
}
