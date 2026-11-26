// SPDX-FileCopyrightText: 2026 Dacely <business@dacely.com>
// SPDX-License-Identifier: LicenseRef-Proprietary

import { randomBytes } from 'node:crypto';
import { SigningKey } from '../identity/SigningKey.js';
import { IdentityCodec } from 'nerva-connector-protocol/identity/IdentityCodec.js';
import { Boundary } from 'nerva-connector-protocol/protocol/Boundary.js';
import { ExchangeCodec } from 'nerva-connector-protocol/remote/ExchangeCodec.js';
import { ExchangeProof } from 'nerva-connector-protocol/remote/ExchangeProof.js';
import {
    ExchangeKind,
    ExchangeLimits,
    type ExchangeContext,
    type SignedExchange,
} from 'nerva-connector-protocol/remote/ExchangeFormat.js';

/** Only verified authority confirmation activates a session; rejected exchanges remain closed. */
export enum DeviceSessionState {
    AwaitingChallenge = 'awaiting-challenge',
    AwaitingConfirmation = 'awaiting-confirmation',
    Authenticated = 'authenticated',
    Executing = 'executing',
    Completed = 'completed',
    Closed = 'closed',
}

/** A device proves its identity only to its installed authority pin and captured authorized target. */
export class DeviceSession implements Disposable {
    readonly #key: SigningKey;
    readonly #authorityPublicKey: string;
    readonly #context: ExchangeContext;
    readonly #clientNonce: string = randomBytes(32).toString('base64url');
    #state: DeviceSessionState = DeviceSessionState.AwaitingChallenge;
    #challenge: SignedExchange | null = null;
    #authentication: SignedExchange | null = null;
    #request: SignedExchange | null = null;

    /** Trust comes from installation and transport authorization, never from a challenge's asserted signer. The caller retains ownership of its key. */
    public constructor(key: SigningKey, authorityPublicKey: string, context: ExchangeContext) {
        this.#key = key;
        this.#authorityPublicKey =
            IdentityCodec.publicKey(authorityPublicKey).toString('base64url');
        this.#context = ExchangeCodec.context({
            ...context,
            generation: context.generation.toString(),
        });
        if (
            this.#context.recipientPublicKey !== key.publicKey ||
            authorityPublicKey === key.publicKey
        ) {
            throw new Error(
                'Mutual authentication requires distinct authorized endpoint identities',
            );
        }
    }

    /** This fresh public nonce must be included in the authority's signed challenge. */
    public get clientNonce(): string {
        return this.#clientNonce;
    }

    /** An open transport or sent device proof alone cannot report successful mutual authentication. */
    public get state(): DeviceSessionState {
        return this.#state;
    }

    /** Both authority signatures and the complete target are checked before the device signs anything. */
    public prove(bytes: Uint8Array, nowMs: bigint): SignedExchange {
        try {
            if (this.#state !== DeviceSessionState.AwaitingChallenge) {
                throw new Error('Unexpected authority challenge');
            }
            const challenge: SignedExchange = ExchangeProof.verify(
                SigningKey,
                bytes,
                ExchangeKind.Challenge,
                this.#context,
                this.#authorityPublicKey,
                nowMs,
            );
            if (
                challenge.expiresAtMs - challenge.issuedAtMs >
                ExchangeLimits.authenticationLifetimeMs
            ) {
                throw new Error('Authority challenge exceeds its lifetime');
            }
            const payload: Readonly<Record<string, unknown>> = Boundary.record(
                JSON.parse(challenge.payload),
                ['clientNonce', 'challengeNonce'],
            );
            if (payload['clientNonce'] !== this.#clientNonce) {
                throw new Error('Authority challenge selected another client nonce');
            }
            IdentityCodec.binary(payload['challengeNonce'], 32);
            const authentication: SignedExchange = ExchangeProof.sign(this.#key, {
                kind: ExchangeKind.Authentication,
                context: { ...this.#context, recipientPublicKey: this.#authorityPublicKey },
                issuedAtMs: challenge.issuedAtMs,
                expiresAtMs: challenge.expiresAtMs,
                payload: JSON.stringify({
                    clientNonce: this.#clientNonce,
                    challengeSha256: ExchangeCodec.digest(challenge),
                }),
            });
            this.#challenge = challenge;
            this.#authentication = authentication;
            this.#state = DeviceSessionState.AwaitingConfirmation;
            return authentication;
        } catch (caught: unknown) {
            this[Symbol.dispose]();
            throw caught;
        }
    }

    /** The pinned authority must confirm the exact challenge and exact two-component device proof after consuming shared authorization. */
    public confirm(bytes: Uint8Array, nowMs: bigint): void {
        try {
            const challenge: SignedExchange | null = this.#challenge;
            const authentication: SignedExchange | null = this.#authentication;
            if (
                this.#state !== DeviceSessionState.AwaitingConfirmation ||
                challenge === null ||
                authentication === null
            ) {
                throw new Error('Unexpected authority confirmation');
            }
            const confirmation: SignedExchange = ExchangeProof.verify(
                SigningKey,
                bytes,
                ExchangeKind.Confirmation,
                this.#context,
                this.#authorityPublicKey,
                nowMs,
            );
            const payload: Readonly<Record<string, unknown>> = Boundary.record(
                JSON.parse(confirmation.payload),
                ['challengeSha256', 'authenticationSha256'],
            );
            if (
                confirmation.issuedAtMs < authentication.issuedAtMs ||
                confirmation.expiresAtMs !== challenge.expiresAtMs ||
                payload['challengeSha256'] !== ExchangeCodec.digest(challenge) ||
                payload['authenticationSha256'] !== ExchangeCodec.digest(authentication)
            ) {
                throw new Error('Authority confirmation changed its authenticated exchange');
            }
            this.#state = DeviceSessionState.Authenticated;
        } catch (caught: unknown) {
            this[Symbol.dispose]();
            throw caught;
        }
    }

    /** Operation owners must check current mutual authentication before effects; expiry is checked independently of transport timers. */
    public require(nowMs: bigint): ExchangeContext {
        if (
            this.#state !== DeviceSessionState.Authenticated ||
            this.#challenge === null ||
            nowMs + ExchangeLimits.clockLeadMs < this.#challenge.issuedAtMs ||
            nowMs >= this.#challenge.expiresAtMs
        ) {
            this[Symbol.dispose]();
            throw new Error('Mutually authenticated device session is unavailable');
        }
        return this.#context;
    }

    /** Exactly one original operation may enter this session after mutual confirmation, under the installed authority pin. */
    public request(bytes: Uint8Array, nowMs: bigint): SignedExchange {
        try {
            const context: ExchangeContext = this.require(nowMs);
            const request: SignedExchange = ExchangeProof.verify(
                SigningKey,
                bytes,
                ExchangeKind.Request,
                context,
                this.#authorityPublicKey,
                nowMs,
            );
            if (this.#challenge === null || request.expiresAtMs > this.#challenge.expiresAtMs) {
                throw new Error('Operation exceeds its authenticated session');
            }
            this.#request = request;
            this.#state = DeviceSessionState.Executing;
            return request;
        } catch (caught: unknown) {
            this[Symbol.dispose]();
            throw caught;
        }
    }

    /** Only the exact verified operation can produce one signed result; uncertain or expired work cannot silently restart. */
    public result(request: SignedExchange, payload: string, nowMs: bigint): SignedExchange {
        try {
            if (
                this.#state !== DeviceSessionState.Executing ||
                this.#request !== request ||
                nowMs + ExchangeLimits.clockLeadMs < request.issuedAtMs ||
                nowMs >= request.expiresAtMs
            ) {
                throw new Error('Original authenticated operation is unavailable');
            }
            const result: SignedExchange = ExchangeProof.sign(this.#key, {
                kind: ExchangeKind.Result,
                context: { ...this.#context, recipientPublicKey: this.#authorityPublicKey },
                issuedAtMs: nowMs < request.issuedAtMs ? request.issuedAtMs : nowMs,
                expiresAtMs: request.expiresAtMs,
                payload,
            });
            this.#request = null;
            this.#state = DeviceSessionState.Completed;
            return result;
        } catch (caught: unknown) {
            this[Symbol.dispose]();
            throw caught;
        }
    }

    /** Closing discards retained proofs and cannot dispose the caller-owned signing identity. */
    public [Symbol.dispose](): void {
        this.#state = DeviceSessionState.Closed;
        this.#challenge = null;
        this.#authentication = null;
        this.#request = null;
    }
}
