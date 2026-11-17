// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

import {
    createPrivateKey,
    createPublicKey,
    generateKeyPairSync,
    randomBytes,
    sign,
    verify,
    hkdfSync,
    type KeyObject,
} from 'node:crypto';
import { ml_dsa44 } from '@dacely/noble-post-quantum/ml-dsa.js';
import {
    SignatureSuite,
    IdentityLengths,
    KeyDerivationPurpose,
    type SignaturePurpose,
    type PrivateIdentityRecord,
} from 'nerva-connector-protocol/identity/IdentityFormat.js';
import { IdentityCodec } from 'nerva-connector-protocol/identity/IdentityCodec.js';

/** Native JWK export is narrowed to the single raw Ed25519 public coordinate used by this suite. */
interface Ed25519PublicJwk {
    readonly x?: string;
}

/** Owns independent ML-DSA and native Ed25519 secrets; public identity and proof are always composite. */
export class SigningKey implements Disposable {
    static readonly #context: Buffer = Buffer.from('nerva-connector:dual-signature');
    readonly #seed: Buffer;
    readonly #mlDsaSecret: Uint8Array;
    readonly #publicBytes: Buffer;
    #ed25519: KeyObject | null;
    public readonly publicKey: string;

    private constructor(seed: Buffer, ed25519: KeyObject) {
        const pair: ReturnType<typeof ml_dsa44.keygen> = ml_dsa44.keygen(seed);
        this.#seed = seed;
        this.#mlDsaSecret = pair.secretKey;
        this.#ed25519 = ed25519;
        const jwk: Ed25519PublicJwk = createPublicKey(ed25519).export({ format: 'jwk' });
        this.#publicBytes = Buffer.concat([
            pair.publicKey,
            IdentityCodec.binary(jwk.x, IdentityLengths.ed25519PublicKey),
        ]);
        this.publicKey = this.#publicBytes.toString('base64url');
    }

    /** Separate cryptographic random generation prevents compromise of one private component from deriving the other. */
    public static generate(): SigningKey {
        const seed: Buffer = randomBytes(IdentityLengths.seed);
        try {
            return new SigningKey(seed, generateKeyPairSync('ed25519').privateKey);
        } catch (caught: unknown) {
            seed.fill(0);
            throw caught;
        }
    }

    /** A protected local loader must bound its file read first; this decoder rejects unsupported or partial identities. */
    public static decode(bytes: Uint8Array): SigningKey {
        if (!(bytes instanceof Uint8Array) || bytes.byteLength > IdentityLengths.privateRecord) {
            throw new Error('Invalid connector private identity record');
        }
        const raw: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
        if (
            typeof raw !== 'object' ||
            raw === null ||
            Array.isArray(raw) ||
            Object.getPrototypeOf(raw) !== Object.prototype ||
            Object.keys(raw).length !== 3 ||
            Object.keys(raw).some(
                (name: string): boolean =>
                    !['suite', 'mlDsaSeed', 'ed25519PrivateKey'].includes(name),
            ) ||
            Reflect.get(raw, 'suite') !== SignatureSuite.MlDsa44Ed25519
        ) {
            throw new Error('Unsupported or incomplete connector private identity');
        }
        const seed: Buffer = IdentityCodec.binary(
            Reflect.get(raw, 'mlDsaSeed'),
            IdentityLengths.seed,
        );
        let der: Buffer | null = null;
        try {
            der = IdentityCodec.binary(
                Reflect.get(raw, 'ed25519PrivateKey'),
                IdentityLengths.ed25519PrivateDer,
            );
            const key: KeyObject = createPrivateKey({ format: 'der', type: 'pkcs8', key: der });
            if (key.asymmetricKeyType !== 'ed25519' || key.type !== 'private') {
                throw new Error('Unsupported connector classical identity component');
            }
            const canonical: Buffer = key.export({ format: 'der', type: 'pkcs8' });
            try {
                if (!canonical.equals(der)) {
                    throw new Error('Noncanonical connector private identity component');
                }
            } finally {
                canonical.fill(0);
            }
            return new SigningKey(seed, key);
        } catch (caught: unknown) {
            seed.fill(0);
            throw caught;
        } finally {
            der?.fill(0);
        }
    }

    /** Only the local protected identity writer may persist this secret output. */
    public encode(): Buffer {
        const der: Buffer = this.#active().export({ format: 'der', type: 'pkcs8' });
        try {
            const record: PrivateIdentityRecord = {
                suite: SignatureSuite.MlDsa44Ed25519,
                mlDsaSeed: this.#seed.toString('base64url'),
                ed25519PrivateKey: der.toString('base64url'),
            };
            return Buffer.from(JSON.stringify(record));
        } finally {
            der.fill(0);
        }
    }

    /** Neither component can be omitted; the algorithm suite, identity and purpose are inside both proofs. */
    public sign(purpose: SignaturePurpose, payload: Uint8Array): string {
        const key: KeyObject = this.#active();
        const message: Buffer = IdentityCodec.transcript(purpose, this.#publicBytes, payload);
        const pq: Uint8Array = ml_dsa44.sign(message, this.#mlDsaSecret, {
            context: SigningKey.#context,
        });
        const classical: Buffer = sign(null, message, key);
        if (
            pq.byteLength !== IdentityLengths.mlDsaSignature ||
            classical.byteLength !== IdentityLengths.ed25519Signature
        ) {
            throw new Error('Unsupported connector signature component');
        }
        return Buffer.concat([pq, classical]).toString('base64url');
    }

    /** The receiver supplies its expected public identity and purpose; verification never adopts a key from the signature. */
    public static verify(
        purpose: SignaturePurpose,
        publicKey: string,
        payload: Uint8Array,
        signature: string,
    ): boolean {
        try {
            const identity: Buffer = IdentityCodec.publicKey(publicKey);
            const proof: Buffer = IdentityCodec.signature(signature);
            const message: Buffer = IdentityCodec.transcript(purpose, identity, payload);
            const classical: KeyObject = createPublicKey({
                format: 'jwk',
                key: {
                    kty: 'OKP',
                    crv: 'Ed25519',
                    x: identity.subarray(IdentityLengths.mlDsaPublicKey).toString('base64url'),
                },
            });
            return (
                ml_dsa44.verify(
                    proof.subarray(0, IdentityLengths.mlDsaSignature),
                    message,
                    identity.subarray(0, IdentityLengths.mlDsaPublicKey),
                    { context: SigningKey.#context },
                ) &&
                verify(null, message, classical, proof.subarray(IdentityLengths.mlDsaSignature))
            );
        } catch {
            return false;
        }
    }

    /** Retention encryption derives from both independent secrets under a distinct purpose and bounded public salt. */
    public deriveKey(purpose: KeyDerivationPurpose, salt: Uint8Array): Buffer {
        if (
            !Object.values(KeyDerivationPurpose).includes(purpose) ||
            !(salt instanceof Uint8Array) ||
            salt.byteLength < 1 ||
            salt.byteLength > 8192
        ) {
            throw new Error('Unsupported connector key derivation');
        }
        const der: Buffer = this.#active().export({ format: 'der', type: 'pkcs8' });
        const material: Buffer = Buffer.concat([this.#seed, der]);
        try {
            return Buffer.from(hkdfSync('sha256', material, salt, Buffer.from(purpose), 32));
        } finally {
            material.fill(0);
            der.fill(0);
        }
    }

    /** Best-effort buffer erasure cannot promise removal of native or immutable JavaScript copies. */
    public [Symbol.dispose](): void {
        this.#seed.fill(0);
        this.#mlDsaSecret.fill(0);
        this.#ed25519 = null;
    }

    #active(): KeyObject {
        if (this.#ed25519 === null) {
            throw new Error('Connector signing identity is closed');
        }
        return this.#ed25519;
    }
}
