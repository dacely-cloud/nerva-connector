// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi, type MockInstance, type MockResult } from 'vitest';
import { SigningKey } from '../src/identity/SigningKey.js';
import { KeyDerivationPurpose } from 'nerva-connector-protocol/identity/IdentityFormat.js';
import { Boundary } from 'nerva-connector-protocol/protocol/Boundary.js';
import { ConnectorJournalCipher } from '../src/runtime/ConnectorJournalCipher.js';
import { ConnectorJournalLimits } from '../src/runtime/ConnectorJournalLimits.js';
import { ProtectedFileLimits } from '../src/local/ProtectedFileLimits.js';
import type { ConnectorJournalRecord } from '../src/runtime/ConnectorJournalRecord.js';
import { ConnectorJournalStore } from '../src/runtime/ConnectorJournalStore.js';
import { ConnectorPrivateDirectory } from '../src/runtime/ConnectorPrivateDirectory.js';
import {
    ConnectorOperationPurpose,
    type ConnectorStorageCodec,
} from '../src/runtime/ConnectorOperationCodec.js';

/** Exact counter and retained data represent a small concrete authenticated storage contract. */
interface FixtureState {
    readonly sequence: bigint;
    readonly value: string;
}

/** Runtime validation rejects malformed authenticated plaintext before returning application state. */
class FixtureCodec implements ConnectorStorageCodec<FixtureState> {
    public readonly hashes: string[] = [];
    public read(raw: unknown, sourceSha256: string): FixtureState {
        const value: Readonly<Record<string, unknown>> = Boundary.record(raw, [
            'sequence',
            'value',
        ]);
        if (typeof value['value'] !== 'string') {
            throw new Error('Invalid fixture retained state');
        }
        this.hashes.push(sourceSha256);
        return { sequence: Boundary.integer(value['sequence']), value: value['value'] };
    }
    public encode(state: FixtureState): string {
        return JSON.stringify({ sequence: state.sequence.toString(), value: state.value });
    }
}

/** Every actual store case owns its private directory and disposable fake signing identity. */
class CipherFixture implements AsyncDisposable {
    public readonly key: SigningKey = SigningKey.generate();
    public readonly enrollment: string = 'conn_' + 'a'.repeat(64);
    public readonly codec: FixtureCodec = new FixtureCodec();
    private constructor(public readonly directory: string) {}
    public static async create(): Promise<CipherFixture> {
        return new CipherFixture(await mkdtemp(join(homedir(), '.nerva-cipher-')));
    }
    public cipher(
        purpose: ConnectorOperationPurpose = ConnectorOperationPurpose.Files,
        directory: string = this.directory,
        enrollment: string = this.enrollment,
    ): ConnectorJournalCipher<FixtureState> {
        return ConnectorJournalCipher.create(directory, enrollment, this.key, purpose, this.codec);
    }
    public async [Symbol.asyncDispose](): Promise<void> {
        this.key[Symbol.dispose]();
        await rm(this.directory, { recursive: true, force: true });
    }
}

const snapshot: FixtureState = { sequence: 9007199254740993n, value: 'retained' };

it('only the separate retained-host purpose accepts the expanded encrypted receipt quota', async (): Promise<void> => {
    await using fixture: CipherFixture = await CipherFixture.create();
    for (const purpose of Object.values(KeyDerivationPurpose)) {
        if (purpose === KeyDerivationPurpose.RetainedHost) {
            using host: ConnectorJournalCipher<FixtureState> = ConnectorJournalCipher.scoped(
                fixture.key,
                {
                    purpose,
                    salt: Buffer.from('fixture-host'),
                    aad: Buffer.from('fixture-host-context'),
                    limits: {
                        plainBytes: ProtectedFileLimits.hostPlainBytes,
                        recordBytes: ProtectedFileLimits.hostRecordBytes,
                    },
                },
                fixture.codec,
            );
            expect(host.decode(host.encode(snapshot)).state).toEqual(snapshot);
        } else {
            expect((): ConnectorJournalCipher<FixtureState> =>
                ConnectorJournalCipher.scoped(
                    fixture.key,
                    {
                        purpose,
                        salt: Buffer.from('fixture-host'),
                        aad: Buffer.from('fixture-host-context'),
                        limits: {
                            plainBytes: ProtectedFileLimits.hostPlainBytes,
                            recordBytes: ProtectedFileLimits.hostRecordBytes,
                        },
                    },
                    fixture.codec,
                ),
            ).toThrow('context');
        }
    }
});
/** Fixed pre-extraction AES-256-GCM vectors use key bytes 0..31, nonce bytes 0..11 and the original AAD. */
const originalTags: Readonly<Record<ConnectorOperationPurpose, string>> = {
    [ConnectorOperationPurpose.Files]: 'lVKtPcfnacIsZeALq7FHpg',
    [ConnectorOperationPurpose.ExecutionFirst]: 'u_06xYa4NnsRQMb8dMXqlw',
    [ConnectorOperationPurpose.ExecutionSecond]: 'h72ibZaWw5KAGgC9j3PmMg',
};

it('opens fixed original ciphertext with unchanged purpose, derivation context and AAD', async (): Promise<void> => {
    await using fixture: CipherFixture = await CipherFixture.create();
    for (const purpose of Object.values(ConnectorOperationPurpose)) {
        const derived: Buffer = Buffer.alloc(32);
        for (let index: number = 0; index < derived.byteLength; index++) {
            derived[index] = index;
        }
        const derive: MockInstance<SigningKey['deriveKey']> = vi
            .spyOn(fixture.key, 'deriveKey')
            .mockReturnValue(derived);
        try {
            using cipher: ConnectorJournalCipher<FixtureState> = fixture.cipher(
                purpose,
                '/journal-fixture',
            );
            expect(derive).toHaveBeenCalledExactlyOnceWith(
                purpose === ConnectorOperationPurpose.Files
                    ? KeyDerivationPurpose.RetainedFiles
                    : KeyDerivationPurpose.RetainedExecution,
                Buffer.from(
                    purpose === ConnectorOperationPurpose.Files
                        ? fixture.enrollment
                        : JSON.stringify([fixture.enrollment, purpose]),
                ),
            );
            const bytes: Buffer = Buffer.from(
                JSON.stringify({
                    nonce: 'AAECAwQFBgcICQoL',
                    tag: originalTags[purpose],
                    data: 'PCClfrSQp3XuJLWxk9BIXbTnvg3CTmtLDFfcvC5LLJB3ccKJyuMougbBC4zh6U1czCQ',
                }),
            );
            const before: Buffer = Buffer.from(bytes);
            const record: ConnectorJournalRecord<FixtureState> = cipher.decode(bytes);
            expect(record.state).toEqual(snapshot);
            expect(record.sourceSha256).toBe(createHash('sha256').update(bytes).digest('hex'));
            expect(fixture.codec.hashes.at(-1)).toBe(record.sourceSha256);
            expect(bytes.equals(before)).toBe(true);
        } finally {
            expect(derived.every((byte: number): boolean => byte === 0)).toBe(true);
            derive.mockRestore();
        }
    }
});

it('scope changes never authenticate another directory, enrollment, lane or device', async (): Promise<void> => {
    await using fixture: CipherFixture = await CipherFixture.create();
    using cipher: ConnectorJournalCipher<FixtureState> = fixture.cipher();
    const bytes: Buffer = cipher.encode(snapshot);
    const before: Buffer = Buffer.from(bytes);
    try {
        for (const purpose of [
            ConnectorOperationPurpose.ExecutionFirst,
            ConnectorOperationPurpose.ExecutionSecond,
        ]) {
            using changed: ConnectorJournalCipher<FixtureState> = fixture.cipher(purpose);
            expect((): ConnectorJournalRecord<FixtureState> => changed.decode(bytes)).toThrow();
        }
        using directory: ConnectorJournalCipher<FixtureState> = fixture.cipher(
            ConnectorOperationPurpose.Files,
            join(fixture.directory, 'other'),
        );
        using enrollment: ConnectorJournalCipher<FixtureState> = fixture.cipher(
            ConnectorOperationPurpose.Files,
            fixture.directory,
            'conn_' + 'b'.repeat(64),
        );
        using otherKey: SigningKey = SigningKey.generate();
        using device: ConnectorJournalCipher<FixtureState> = ConnectorJournalCipher.create(
            fixture.directory,
            fixture.enrollment,
            otherKey,
            ConnectorOperationPurpose.Files,
            fixture.codec,
        );
        for (const changed of [directory, enrollment, device]) {
            expect((): ConnectorJournalRecord<FixtureState> => changed.decode(bytes)).toThrow();
        }
        expect(bytes.equals(before)).toBe(true);
        expect(cipher.decode(bytes).state).toEqual(snapshot);
    } finally {
        bytes.fill(0);
        before.fill(0);
    }
});

it('validates context without creating directories', async (): Promise<void> => {
    await using fixture: CipherFixture = await CipherFixture.create();
    const missing: string = join(fixture.directory, 'never-created');
    using standalone: ConnectorJournalCipher<FixtureState> = fixture.cipher(
        ConnectorOperationPurpose.Files,
        missing,
    );
    expect(standalone.decode(standalone.encode(snapshot)).state).toEqual(snapshot);
    await expect(stat(missing)).rejects.toMatchObject({ code: 'ENOENT' });
    expect((): ConnectorJournalCipher<FixtureState> =>
        fixture.cipher(ConnectorOperationPurpose.Files, missing + '/../other'),
    ).toThrow();
    expect((): ConnectorJournalCipher<FixtureState> =>
        fixture.cipher(ConnectorOperationPurpose.Files, fixture.directory, 'invalid'),
    ).toThrow();
    expect((): void => {
        Reflect.apply(ConnectorJournalCipher.create.bind(undefined), undefined, [
            fixture.directory,
            fixture.enrollment,
            fixture.key,
            'unknown-purpose',
            fixture.codec,
        ]);
    }).toThrow();
});

it.skipIf(process.platform !== 'linux')(
    'cipher inspection never takes the live Linux store lock',
    async (): Promise<void> => {
        await using fixture: CipherFixture = await CipherFixture.create();
        await using store: ConnectorJournalStore<FixtureState> = await ConnectorJournalStore.open(
            fixture.directory,
            fixture.enrollment,
            fixture.key,
            ConnectorOperationPurpose.Files,
            fixture.codec,
        );
        await store.write(snapshot, true);
        await expect(
            ConnectorJournalStore.open(
                fixture.directory,
                fixture.enrollment,
                fixture.key,
                ConnectorOperationPurpose.Files,
                fixture.codec,
            ),
        ).rejects.toThrow();
        const bytes: Buffer = await readFile(store.file);
        try {
            using inspector: ConnectorJournalCipher<FixtureState> = fixture.cipher();
            expect(inspector.decode(bytes).state).toEqual(snapshot);
            expect(await store.read()).toEqual(snapshot);
            expect((await readFile(store.file)).equals(bytes)).toBe(true);
        } finally {
            bytes.fill(0);
        }
    },
);

it('refuses malformed encodings, tampering and authenticated invalid state without changing input', async (): Promise<void> => {
    await using fixture: CipherFixture = await CipherFixture.create();
    using cipher: ConnectorJournalCipher<FixtureState> = fixture.cipher();
    const encoded: Buffer = cipher.encode(snapshot);
    try {
        const original: unknown = JSON.parse(encoded.toString('utf8'));
        const fields: Readonly<Record<string, unknown>> = Boundary.record(original, [
            'nonce',
            'tag',
            'data',
        ]);
        for (const changed of [
            { ...fields, nonce: 'AAECAwQFBgcICQoL=' },
            { ...fields, tag: 'A'.repeat(22) },
            { ...fields, data: String(fields['data']) + '=' },
            { ...fields, data: 'a'.repeat(ConnectorJournalLimits.encodedCharacters + 1) },
            { ...fields, extra: true },
            { nonce: fields['nonce'], data: fields['data'] },
        ]) {
            const bytes: Buffer = Buffer.from(JSON.stringify(changed));
            const before: Buffer = Buffer.from(bytes);
            expect((): ConnectorJournalRecord<FixtureState> => cipher.decode(bytes)).toThrow();
            expect(bytes.equals(before)).toBe(true);
        }
        expect((): ConnectorJournalRecord<FixtureState> =>
            cipher.decode(Buffer.alloc(ConnectorJournalLimits.recordBytes + 1)),
        ).toThrow();
        expect((): ConnectorJournalRecord<FixtureState> =>
            cipher.decode(Buffer.from([0xff])),
        ).toThrow();
        // Encryption alone cannot make an invalid application counter into validated state.
        const invalid: Buffer = cipher.encode({ sequence: -1n, value: 'retained' });
        try {
            expect((): ConnectorJournalRecord<FixtureState> => cipher.decode(invalid)).toThrow();
        } finally {
            invalid.fill(0);
        }
        const overhead: number = Buffer.byteLength(
            fixture.codec.encode({ sequence: 1n, value: '' }),
        );
        const maximum: FixtureState = {
            sequence: 1n,
            value: 'x'.repeat(ConnectorJournalLimits.plainBytes - overhead),
        };
        const bounded: Buffer = cipher.encode(maximum);
        try {
            expect(cipher.decode(bounded).state).toEqual(maximum);
        } finally {
            bounded.fill(0);
        }
        expect((): Buffer =>
            cipher.encode({ sequence: 1n, value: 'x'.repeat(ConnectorJournalLimits.plainBytes) }),
        ).toThrow();
    } finally {
        encoded.fill(0);
    }
});

it('disposal clears derived ownership and refuses further cipher use', async (): Promise<void> => {
    await using fixture: CipherFixture = await CipherFixture.create();
    const cipher: ConnectorJournalCipher<FixtureState> = fixture.cipher();
    const bytes: Buffer = cipher.encode(snapshot);
    cipher[Symbol.dispose]();
    cipher[Symbol.dispose]();
    expect((): Buffer => cipher.encode(snapshot)).toThrow();
    expect((): ConnectorJournalRecord<FixtureState> => cipher.decode(bytes)).toThrow();
    bytes.fill(0);
});

it.skipIf(process.platform !== 'linux')(
    'the Linux store zeroes only its owned IO buffers after completion',
    async (): Promise<void> => {
        await using fixture: CipherFixture = await CipherFixture.create();
        const write: MockInstance<ConnectorPrivateDirectory['write']> = vi.spyOn(
            ConnectorPrivateDirectory.prototype,
            'write',
        );
        const read: MockInstance<ConnectorPrivateDirectory['read']> = vi.spyOn(
            ConnectorPrivateDirectory.prototype,
            'read',
        );
        try {
            await using store: ConnectorJournalStore<FixtureState> =
                await ConnectorJournalStore.open(
                    fixture.directory,
                    fixture.enrollment,
                    fixture.key,
                    ConnectorOperationPurpose.Files,
                    fixture.codec,
                );
            await store.write(snapshot, true);
            const written: Buffer | undefined = write.mock.calls.at(-1)?.[1];
            expect(written?.every((byte: number): boolean => byte === 0)).toBe(true);
            expect(await store.read()).toEqual(snapshot);
            const result: MockResult<Promise<Buffer>> | undefined = read.mock.results.at(-1);
            if (result?.type !== 'return') {
                throw new Error('Actual store read was not observed');
            }
            expect((await result.value).every((byte: number): boolean => byte === 0)).toBe(true);
            await expect(store.write(snapshot, true)).rejects.toThrow();
            expect(write.mock.calls.at(-1)?.[1].every((byte: number): boolean => byte === 0)).toBe(
                true,
            );
            await writeFile(store.file, 'invalid encrypted JSON');
            await expect(store.read()).rejects.toThrow();
            const failedRead: MockResult<Promise<Buffer>> | undefined = read.mock.results.at(-1);
            if (failedRead?.type !== 'return') {
                throw new Error('Actual failed read was not observed');
            }
            expect((await failedRead.value).every((byte: number): boolean => byte === 0)).toBe(
                true,
            );
        } finally {
            write.mockRestore();
            read.mockRestore();
        }
    },
);
