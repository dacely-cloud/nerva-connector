// SPDX-FileCopyrightText: 2026 Dacely <business@dacely.com>
// SPDX-License-Identifier: LicenseRef-Proprietary

import {
    createHash,
    createCipheriv,
    createDecipheriv,
    randomBytes,
    type CipherGCM,
    type DecipherGCM,
} from 'node:crypto';
import { resolve } from 'node:path';
import type { SigningKey } from '../identity/SigningKey.js';
import { KeyDerivationPurpose } from 'nerva-connector-protocol/identity/IdentityFormat.js';
import { ProtectedFiles } from '../local/ProtectedFiles.js';
import { ProtectedFileLimits } from '../local/ProtectedFileLimits.js';
import { Boundary } from 'nerva-connector-protocol/protocol/Boundary.js';
import { ConnectorEnrollmentCodec } from 'nerva-connector-protocol/protocol/ConnectorEnrollmentCodec.js';
import { ConnectorJournalLimits } from './ConnectorJournalLimits.js';
import type { ConnectorJournalRecord } from './ConnectorJournalRecord.js';
import {
    ConnectorOperationPurpose,
    type ConnectorStorageCodec,
} from './ConnectorOperationCodec.js';

/** Independent encrypted owners select finite bounds without changing existing operation journal limits. */
export interface ConnectorJournalEncryptionLimits {
    readonly plainBytes: number;
    readonly recordBytes: number;
}

/** A distinct purpose and caller-owned public context bind a new encrypted state format without sharing operation AAD. */
export interface ConnectorJournalEncryptionContext {
    readonly purpose: KeyDerivationPurpose;
    readonly salt: Uint8Array;
    readonly aad: Uint8Array;
    readonly limits: ConnectorJournalEncryptionLimits;
}

/** Authenticated journal encoding owns only its derived key and bounded buffers, never a filesystem lock or mutation. */
export class ConnectorJournalCipher<TState> implements Disposable {
    #closed: boolean = false;
    readonly #key: Buffer;
    readonly #aad: Buffer;
    readonly #codec: ConnectorStorageCodec<TState>;
    readonly #limits: ConnectorJournalEncryptionLimits;
    private constructor(
        key: Buffer,
        aad: Buffer,
        codec: ConnectorStorageCodec<TState>,
        limits: ConnectorJournalEncryptionLimits,
    ) {
        this.#key = key;
        this.#aad = aad;
        this.#codec = codec;
        this.#limits = Object.freeze({ ...limits });
    }

    /** The unchanged purpose, enrollment and canonical directory bind the existing encryption context without filesystem IO. */
    public static create<TState>(
        directory: string,
        enrollmentId: string,
        key: SigningKey,
        purpose: ConnectorOperationPurpose,
        codec: ConnectorStorageCodec<TState>,
    ): ConnectorJournalCipher<TState> {
        if (resolve(ProtectedFiles.path(directory)) !== directory) {
            throw new Error('Unsupported connector journal identity or platform');
        }
        ConnectorEnrollmentCodec.id(enrollmentId);
        if (!Object.values(ConnectorOperationPurpose).includes(purpose)) {
            throw new Error('Invalid operation journal purpose');
        }
        const encryptionKey: Buffer = key.deriveKey(
            purpose === ConnectorOperationPurpose.Files
                ? KeyDerivationPurpose.RetainedFiles
                : KeyDerivationPurpose.RetainedExecution,
            Buffer.from(
                purpose === ConnectorOperationPurpose.Files
                    ? enrollmentId
                    : JSON.stringify([enrollmentId, purpose]),
            ),
        );
        try {
            const aad: Buffer = Buffer.from(
                JSON.stringify(['nerva-connector:retained-' + purpose, enrollmentId, directory]),
            );
            return new ConnectorJournalCipher(encryptionKey, aad, codec, ConnectorJournalLimits);
        } catch (caught: unknown) {
            encryptionKey.fill(0);
            throw caught;
        }
    }

    /** New independent owners supply explicit domain-separated context; operation callers keep their unchanged creation path. */
    public static scoped<TState>(
        key: SigningKey,
        context: ConnectorJournalEncryptionContext,
        codec: ConnectorStorageCodec<TState>,
    ): ConnectorJournalCipher<TState> {
        const limits: ConnectorJournalEncryptionLimits = context.limits;
        const host: boolean = context.purpose === KeyDerivationPurpose.RetainedHost;
        if (
            !Number.isSafeInteger(limits.plainBytes) ||
            limits.plainBytes < 1 ||
            limits.plainBytes > (host ? ProtectedFileLimits.hostPlainBytes : 786432) ||
            !Number.isSafeInteger(limits.recordBytes) ||
            limits.recordBytes < 1 ||
            limits.recordBytes > (host ? ProtectedFileLimits.hostRecordBytes : 1048576) ||
            Math.ceil((limits.plainBytes * 8) / 6) + 128 > limits.recordBytes ||
            !(context.aad instanceof Uint8Array) ||
            context.aad.byteLength < 1 ||
            context.aad.byteLength > 8192
        ) {
            throw new Error('Invalid independent connector journal context');
        }
        const encryptionKey: Buffer = key.deriveKey(context.purpose, context.salt);
        try {
            return new ConnectorJournalCipher(
                encryptionKey,
                Buffer.from(context.aad),
                codec,
                limits,
            );
        } catch (caught: unknown) {
            encryptionKey.fill(0);
            throw caught;
        }
    }

    /** Borrowed encrypted input remains unchanged; only authenticated, immediately validated state and its exact source digest escape. */
    public decode(bytes: Buffer): ConnectorJournalRecord<TState> {
        this.#active();
        if (bytes.byteLength > this.#limits.recordBytes) {
            throw new Error('Invalid encrypted connector journal');
        }
        const sourceSha256: string = createHash('sha256').update(bytes).digest('hex');
        const raw: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
        const value: Readonly<Record<string, unknown>> = Boundary.record(raw, [
            'nonce',
            'tag',
            'data',
        ]);
        const nonce: Buffer = this.#binary(value['nonce'], 12);
        const tag: Buffer = this.#binary(value['tag'], 16);
        if (
            typeof value['data'] !== 'string' ||
            value['data'].length > Math.ceil((this.#limits.plainBytes * 8) / 6)
        ) {
            throw new Error('Invalid encrypted connector journal');
        }
        const encrypted: Buffer = Buffer.from(value['data'], 'base64url');
        if (
            encrypted.toString('base64url') !== value['data'] ||
            encrypted.byteLength > this.#limits.plainBytes
        ) {
            throw new Error('Invalid encrypted connector journal payload');
        }
        const cipher: DecipherGCM = createDecipheriv('aes-256-gcm', this.#key, nonce);
        cipher.setAAD(this.#aad);
        cipher.setAuthTag(tag);
        let prefix: Buffer | null = null;
        let suffix: Buffer | null = null;
        let plain: Buffer | null = null;
        try {
            prefix = cipher.update(encrypted);
            suffix = cipher.final();
            plain = Buffer.concat([prefix, suffix]);
            const decoded: unknown = JSON.parse(
                new TextDecoder('utf-8', { fatal: true }).decode(plain),
            );
            return { state: this.#codec.read(decoded, sourceSha256), sourceSha256 };
        } finally {
            prefix?.fill(0);
            suffix?.fill(0);
            plain?.fill(0);
        }
    }

    /** Return one owned bounded encrypted record; callers must zero their returned buffer after IO completes. */
    public encode(snapshot: TState): Buffer {
        this.#active();
        const plain: Buffer = Buffer.from(this.#codec.encode(snapshot));
        try {
            if (plain.byteLength > this.#limits.plainBytes) {
                throw new Error('Connector retained result exceeds storage bound');
            }
            const nonce: Buffer = randomBytes(12);
            const cipher: CipherGCM = createCipheriv('aes-256-gcm', this.#key, nonce);
            cipher.setAAD(this.#aad);
            const data: Buffer = Buffer.concat([cipher.update(plain), cipher.final()]);
            const encoded: Buffer = Buffer.from(
                JSON.stringify({
                    nonce: nonce.toString('base64url'),
                    tag: cipher.getAuthTag().toString('base64url'),
                    data: data.toString('base64url'),
                }),
            );
            if (encoded.byteLength > this.#limits.recordBytes) {
                encoded.fill(0);
                throw new Error('Connector retained result exceeds storage bound');
            }
            return encoded;
        } finally {
            plain.fill(0);
        }
    }

    /** Disposal clears owned derived key material; it does not own or dispose the caller's signing identity. */
    public [Symbol.dispose](): void {
        if (this.#closed) {
            return;
        }
        this.#closed = true;
        this.#key.fill(0);
        this.#aad.fill(0);
    }

    #binary(raw: unknown, bytes: number): Buffer {
        if (typeof raw !== 'string' || raw.length !== Math.ceil((bytes * 8) / 6)) {
            throw new Error('Invalid encrypted journal field');
        }
        const decoded: Buffer = Buffer.from(raw, 'base64url');
        if (decoded.byteLength !== bytes || decoded.toString('base64url') !== raw) {
            throw new Error('Invalid encrypted journal encoding');
        }
        return decoded;
    }

    #active(): void {
        if (this.#closed) {
            throw new Error('Connector journal ownership is closed');
        }
    }
}
