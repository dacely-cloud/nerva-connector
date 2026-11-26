// SPDX-FileCopyrightText: 2026 Dacely <business@dacely.com>
// SPDX-License-Identifier: LicenseRef-Proprietary

import { expect, it } from 'vitest';
import { createPublicKey, verify, type KeyObject } from 'node:crypto';
import { ml_dsa44 } from '@dacely/noble-post-quantum/ml-dsa.js';
import { SigningKey } from '../src/identity/SigningKey.js';
import { IdentityCodec } from 'nerva-connector-protocol/identity/IdentityCodec.js';
import {
    SignaturePurpose,
    SignatureSuite,
    IdentityLengths,
    KeyDerivationPurpose,
} from 'nerva-connector-protocol/identity/IdentityFormat.js';

it('both real signature algorithms verify the same framed identity, purpose and operation bytes', (): void => {
    using key: SigningKey = SigningKey.generate();
    const message: Buffer = Buffer.from('original bounded remote operation');
    const proof: string = key.sign(SignaturePurpose.RemoteRequest, message);
    expect(SigningKey.verify(SignaturePurpose.RemoteRequest, key.publicKey, message, proof)).toBe(
        true,
    );
    const publicBytes: Buffer = IdentityCodec.publicKey(key.publicKey);
    const signatures: Buffer = IdentityCodec.signature(proof);
    const framed: Buffer = IdentityCodec.transcript(
        SignaturePurpose.RemoteRequest,
        publicBytes,
        message,
    );
    const classical: KeyObject = createPublicKey({
        format: 'jwk',
        key: { kty: 'OKP', crv: 'Ed25519', x: publicBytes.subarray(1312).toString('base64url') },
    });
    expect(verify(null, framed, classical, signatures.subarray(2420))).toBe(true);
    expect(
        ml_dsa44.verify(signatures.subarray(0, 2420), framed, publicBytes.subarray(0, 1312), {
            context: Buffer.from('nerva-connector:dual-signature'),
        }),
    ).toBe(true);
});

it('neither a valid ML-DSA signature nor a valid Ed25519 signature can replace the two-component proof', (): void => {
    using key: SigningKey = SigningKey.generate();
    const message: Buffer = Buffer.from('same challenge');
    const proof: string = key.sign(SignaturePurpose.ClientAuthentication, message);
    const pqInvalid: Buffer = IdentityCodec.signature(proof);
    pqInvalid[0] ^= 1;
    expect(
        SigningKey.verify(
            SignaturePurpose.ClientAuthentication,
            key.publicKey,
            message,
            pqInvalid.toString('base64url'),
        ),
    ).toBe(false);
    const classicalInvalid: Buffer = IdentityCodec.signature(proof);
    classicalInvalid[IdentityLengths.mlDsaSignature] ^= 1;
    expect(
        SigningKey.verify(
            SignaturePurpose.ClientAuthentication,
            key.publicKey,
            message,
            classicalInvalid.toString('base64url'),
        ),
    ).toBe(false);
    for (const partial of [
        Buffer.from(proof, 'base64url').subarray(0, 2420),
        Buffer.from(proof, 'base64url').subarray(2420),
    ]) {
        expect(
            SigningKey.verify(
                SignaturePurpose.ClientAuthentication,
                key.publicKey,
                message,
                partial.toString('base64url'),
            ),
        ).toBe(false);
    }
});

it('wrong server pins, mixed identity components, changed payloads and reflected client/server proofs fail', (): void => {
    using server: SigningKey = SigningKey.generate();
    using other: SigningKey = SigningKey.generate();
    const message: Buffer = Buffer.from('fresh client nonce and server challenge');
    const proof: string = server.sign(SignaturePurpose.ServerChallenge, message);
    expect(
        SigningKey.verify(SignaturePurpose.ServerChallenge, other.publicKey, message, proof),
    ).toBe(false);
    const mixed: Buffer = Buffer.concat([
        IdentityCodec.publicKey(server.publicKey).subarray(0, 1312),
        IdentityCodec.publicKey(other.publicKey).subarray(1312),
    ]);
    expect(
        SigningKey.verify(
            SignaturePurpose.ServerChallenge,
            mixed.toString('base64url'),
            message,
            proof,
        ),
    ).toBe(false);
    expect(
        SigningKey.verify(SignaturePurpose.ClientAuthentication, server.publicKey, message, proof),
    ).toBe(false);
    expect(
        SigningKey.verify(
            SignaturePurpose.ServerChallenge,
            server.publicKey,
            Buffer.from('changed'),
            proof,
        ),
    ).toBe(false);
    expect(
        SigningKey.verify(SignaturePurpose.ServerChallenge, server.publicKey + '=', message, proof),
    ).toBe(false);
    expect(
        SigningKey.verify(SignaturePurpose.ServerChallenge, server.publicKey, message, proof + '='),
    ).toBe(false);
    expect(
        SigningKey.verify(
            SignaturePurpose.ServerChallenge,
            server.publicKey,
            Buffer.alloc(IdentityLengths.payload + 1),
            proof,
        ),
    ).toBe(false);
});

it('protected serialization restores the exact identity and retention key without regenerating a component', (): void => {
    using key: SigningKey = SigningKey.generate();
    const serialized: Buffer = key.encode();
    using restored: SigningKey = SigningKey.decode(serialized);
    expect(restored.publicKey).toBe(key.publicKey);
    expect(restored.encode()).toEqual(serialized);
    const salt: Buffer = Buffer.from('original-environment-and-directory');
    const retained: Buffer = key.deriveKey(KeyDerivationPurpose.RetainedFiles, salt);
    expect(restored.deriveKey(KeyDerivationPurpose.RetainedFiles, salt)).toEqual(retained);
    expect(
        restored.deriveKey(KeyDerivationPurpose.RetainedFiles, Buffer.from('different')),
    ).not.toEqual(retained);
    const proof: string = restored.sign(
        SignaturePurpose.PairingState,
        Buffer.from('retained state'),
    );
    expect(
        SigningKey.verify(
            SignaturePurpose.PairingState,
            key.publicKey,
            Buffer.from('retained state'),
            proof,
        ),
    ).toBe(true);
    serialized.fill(0);
    retained.fill(0);
});

it('incomplete and unsupported persisted identities fail instead of adopting a single-signature fallback', (): void => {
    expect(() =>
        SigningKey.decode(Buffer.from(JSON.stringify({ suite: SignatureSuite.MlDsa44Ed25519 }))),
    ).toThrow();
    using key: SigningKey = SigningKey.generate();
    const raw: unknown = JSON.parse(key.encode().toString());
    if (typeof raw !== 'object' || raw === null) {
        throw new Error('Fixture identity unavailable');
    }
    Reflect.set(raw, 'suite', 'ed25519');
    expect(() => SigningKey.decode(Buffer.from(JSON.stringify(raw)))).toThrow();
    expect(() => SigningKey.decode(Buffer.alloc(IdentityLengths.privateRecord + 1))).toThrow();
    key[Symbol.dispose]();
    expect(() => key.encode()).toThrow('closed');
    expect(() => key.sign(SignaturePurpose.RemoteRequest, Buffer.alloc(0))).toThrow('closed');
    expect(() => key.deriveKey(KeyDerivationPurpose.RetainedFiles, Buffer.from('salt'))).toThrow(
        'closed',
    );
});
