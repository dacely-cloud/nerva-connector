// SPDX-FileCopyrightText: 2026 Dacely <business@dacely.com>
// SPDX-License-Identifier: LicenseRef-Proprietary

import { randomBytes } from 'node:crypto';
import { SigningKey } from '../../src/identity/SigningKey.js';
import { DeviceSession } from '../../src/remote/DeviceSession.js';
import { ExchangeCodec } from 'nerva-connector-protocol/remote/ExchangeCodec.js';
import { ExchangeProof } from 'nerva-connector-protocol/remote/ExchangeProof.js';
import {
    ExchangeKind,
    type ExchangeContext,
    type SignedExchange,
} from 'nerva-connector-protocol/remote/ExchangeFormat.js';

/** Test-only authority completes a real composite transcript without importing private controller source into the customer application. */
export class SessionFixture {
    /** Caller-owned independent keys and captured context drive every proof. */
    public static open(
        device: SigningKey,
        authority: SigningKey,
        context: ExchangeContext,
        nowMs: bigint,
    ): DeviceSession {
        const session: DeviceSession = new DeviceSession(device, authority.publicKey, context);
        try {
            const challenge: SignedExchange = ExchangeProof.sign(authority, {
                kind: ExchangeKind.Challenge,
                context,
                issuedAtMs: nowMs,
                expiresAtMs: nowMs + 30000n,
                payload: JSON.stringify({
                    clientNonce: session.clientNonce,
                    challengeNonce: randomBytes(32).toString('base64url'),
                }),
            });
            const proof: SignedExchange = session.prove(ExchangeCodec.encode(challenge), nowMs);
            ExchangeProof.verify(
                SigningKey,
                ExchangeCodec.encode(proof),
                ExchangeKind.Authentication,
                { ...context, recipientPublicKey: authority.publicKey },
                device.publicKey,
                nowMs,
            );
            const confirmation: SignedExchange = ExchangeProof.sign(authority, {
                kind: ExchangeKind.Confirmation,
                context,
                issuedAtMs: nowMs,
                expiresAtMs: challenge.expiresAtMs,
                payload: JSON.stringify({
                    challengeSha256: ExchangeCodec.digest(challenge),
                    authenticationSha256: ExchangeCodec.digest(proof),
                }),
            });
            session.confirm(ExchangeCodec.encode(confirmation), nowMs);
            return session;
        } catch (caught: unknown) {
            session[Symbol.dispose]();
            throw caught;
        }
    }
}
