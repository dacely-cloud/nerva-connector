// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

import { ExchangeCodec } from 'nerva-connector-protocol/remote/ExchangeCodec.js';
import { ExchangeProof } from 'nerva-connector-protocol/remote/ExchangeProof.js';
import { SigningKey } from '../identity/SigningKey.js';
import {
    ExchangeKind,
    type ExchangeContext,
    type SignedExchange,
} from 'nerva-connector-protocol/remote/ExchangeFormat.js';
import { StreamCodec } from './StreamCodec.js';
import {
    StreamChannel,
    type StreamBudget,
    type StreamRecord,
    type VerifiedStreamRecord,
} from './StreamFormat.js';
import { IdentityCodec } from 'nerva-connector-protocol/identity/IdentityCodec.js';

/** Owns bounded stream state; no payload reaches its caller before both proofs, exact context and chain validation. */
export class StreamVerifier {
    readonly #context: ExchangeContext;
    readonly #budget: StreamBudget;
    #previous: string;
    #sequence: bigint = 0n;
    #bytes: bigint = 0n;
    #terminal: boolean = false;
    #failed: boolean = false;

    /** The authorized operation supplies its original signed request commitment and approved device identity. */
    public constructor(
        context: ExchangeContext,
        public readonly trustedPublicKey: string,
        requestSha256: string,
        budget: StreamBudget,
    ) {
        IdentityCodec.publicKey(trustedPublicKey);
        this.#context = ExchangeCodec.context({
            ...context,
            generation: context.generation.toString(),
        });
        this.#previous = StreamCodec.digest(requestSha256);
        this.#budget = StreamCodec.budget(budget);
    }

    /** Invalid input permanently fails this owner; it cannot skip a bad frame and silently resume consuming output. */
    public accept(bytes: Uint8Array, nowMs: bigint): VerifiedStreamRecord {
        try {
            if (this.#failed || this.#terminal || this.#sequence >= this.#budget.maximumFrames) {
                throw new Error('Authenticated stream is closed or exceeds its frame budget');
            }
            const frame: SignedExchange = ExchangeProof.verify(
                SigningKey,
                bytes,
                ExchangeKind.Chunk,
                this.#context,
                this.trustedPublicKey,
                nowMs,
            );
            const record: StreamRecord = StreamCodec.decode(frame.payload);
            if (record.sequence !== this.#sequence || record.previousSha256 !== this.#previous) {
                throw new Error('Authenticated stream sequence or commitment changed');
            }
            const data: Buffer = StreamCodec.bytes(record.dataBase64);
            const total: bigint = this.#bytes + BigInt(data.byteLength);
            if (total > this.#budget.maximumBytes) {
                throw new Error('Authenticated stream exceeds its output budget');
            }
            this.#previous = ExchangeCodec.digest(frame);
            this.#sequence++;
            this.#bytes = total;
            this.#terminal = record.channel === StreamChannel.Terminal;
            return Object.freeze({
                sequence: record.sequence,
                channel: record.channel,
                data,
                terminal: record.terminal,
                exitCode: record.exitCode,
                failure: record.failure,
            });
        } catch (caught: unknown) {
            this.#failed = true;
            throw caught;
        }
    }

    /** Transport EOF is incomplete until an authenticated final sequence and exit/error state were consumed. */
    public finish(): void {
        if (this.#failed || !this.#terminal) {
            this.#failed = true;
            throw new Error('Authenticated stream ended without a verified terminal record');
        }
    }
}
