// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

import type { Duplex } from 'node:stream';
import { SigningKey } from '../../src/identity/SigningKey.js';
import { SignaturePurpose } from 'nerva-connector-protocol/identity/IdentityFormat.js';
import { ConnectorDeviceCodec } from 'nerva-connector-protocol/protocol/ConnectorDeviceCodec.js';
import type {
    ConnectorDeviceChallenge,
    ConnectorDeviceProof,
} from 'nerva-connector-protocol/protocol/ConnectorDevice.js';
import {
    ConnectorFrameKind,
    ConnectorTransportCodec,
    type ConnectorClientFrame,
    type ConnectorServerFrame,
} from '../../src/protocol/ConnectorTransport.js';
import type { ConnectorSessionFixture } from './ConnectorSessionFixture.js';

/** A bounded test-only WebSocket authority authenticates real wire frames with both signature components. */
export class ConnectorLifecyclePeer {
    #buffer: Buffer = Buffer.alloc(0);
    #challenge: ConnectorDeviceChallenge | null = null;
    #failure: Error | null = null;
    /** Only this fixture's real TLS socket is read; no customer, public cloud or controller credentials participate. */
    public constructor(
        public readonly socket: Duplex,
        public readonly session: ConnectorSessionFixture,
        public readonly receive: ((frame: ConnectorClientFrame) => void) | null = null,
    ) {
        socket.on('data', (chunk: Buffer): void => {
            try {
                this.#read(chunk);
            } catch (caught: unknown) {
                this.#failure =
                    caught instanceof Error ? caught : new Error('Lifecycle peer rejected frame');
                socket.destroy();
            }
        });
    }
    /** Any malformed frame must fail the test instead of becoming a silent connection retry. */
    public assertHealthy(): void {
        if (this.#failure !== null) {
            throw this.#failure;
        }
    }
    #read(chunk: Buffer): void {
        if (this.#buffer.byteLength + chunk.byteLength > 65536) {
            throw new Error('Lifecycle peer input budget exceeded');
        }
        this.#buffer = Buffer.concat([this.#buffer, chunk]);
        while (this.#buffer.length >= 6) {
            const opcode: number | undefined = this.#buffer[0];
            const mask: number | undefined = this.#buffer[1];
            if (
                opcode !== 0x81 ||
                mask === undefined ||
                (mask & 0x80) === 0 ||
                (mask & 0x7f) === 127
            ) {
                throw new Error('Lifecycle peer accepts bounded masked text only');
            }
            const extended: boolean = (mask & 0x7f) === 126;
            const length: number = extended ? this.#buffer.readUInt16BE(2) : mask & 0x7f;
            const header: number = extended ? 4 : 2;
            if (length > 32768) {
                throw new Error('Lifecycle frame exceeds its control budget');
            }
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
                    throw new Error('Lifecycle frame masking changed');
                }
                payload[index] = value ^ key;
            }
            this.#buffer = this.#buffer.subarray(header + 4 + length);
            this.#receive(
                ConnectorTransportCodec.client(
                    new TextDecoder('utf-8', { fatal: true }).decode(payload),
                ),
            );
        }
    }
    #receive(frame: ConnectorClientFrame): void {
        if (frame.kind === ConnectorFrameKind.Hello && this.#challenge === null) {
            if (
                !SigningKey.verify(
                    SignaturePurpose.DeviceHello,
                    this.session.device.publicKey,
                    Buffer.from(ConnectorDeviceCodec.helloPayload(frame.hello)),
                    frame.hello.signature,
                )
            ) {
                throw new Error('Lifecycle peer rejected device hello');
            }
            this.#challenge = this.session.challenge(frame.hello);
            this.#send({ kind: ConnectorFrameKind.Challenge, challenge: this.#challenge });
        } else if (
            frame.kind === ConnectorFrameKind.Proof &&
            this.#challenge !== null &&
            frame.challengeId === this.#challenge.challengeId
        ) {
            if (
                !SigningKey.verify(
                    SignaturePurpose.ClientAuthentication,
                    this.session.device.publicKey,
                    Buffer.from(ConnectorDeviceCodec.proofPayload(this.#challenge)),
                    frame.signature,
                )
            ) {
                throw new Error('Lifecycle peer rejected device proof');
            }
            const proof: ConnectorDeviceProof = {
                enrollmentId: this.#challenge.enrollmentId,
                slot: this.#challenge.slot,
                challengeId: frame.challengeId,
                signature: frame.signature,
            };
            this.#send({
                kind: ConnectorFrameKind.Authenticated,
                lease: this.session.confirmation(this.#challenge, proof),
            });
        } else if (this.receive !== null) {
            this.receive(frame);
        } else {
            throw new Error('Lifecycle peer received an unexpected frame');
        }
    }
    #send(frame: ConnectorServerFrame): void {
        const payload: Buffer = Buffer.from(ConnectorTransportCodec.encode(frame));
        if (payload.length > 32768) {
            throw new Error('Lifecycle response budget exceeded');
        }
        const header: Buffer = Buffer.alloc(4);
        header[0] = 0x81;
        header[1] = 126;
        header.writeUInt16BE(payload.length, 2);
        this.socket.write(Buffer.concat([header, payload]));
    }
}
