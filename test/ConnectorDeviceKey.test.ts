// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { generateKeyPairSync } from 'node:crypto';
import { SigningKey } from '../src/identity/SigningKey.js';
import {
    SignaturePurpose,
    IdentityLengths,
    SignatureSuite,
} from 'nerva-connector-protocol/identity/IdentityFormat.js';
import {
    mkdtemp,
    readFile,
    rm,
    writeFile,
    readdir,
    lstat,
    link,
    symlink,
    chmod,
    mkdir,
} from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { expect, it } from 'vitest';
import {
    ConnectorDeviceKey,
    type ConnectorDeviceIdentity,
} from '../src/runtime/ConnectorDeviceKey.js';
import { ConnectorEnrollmentCodec } from 'nerva-connector-protocol/protocol/ConnectorEnrollmentCodec.js';
import { Boundary } from 'nerva-connector-protocol/protocol/Boundary.js';

/** Identity tests own only a new private directory under the existing trusted test root. */
class IdentityFixture implements AsyncDisposable {
    public readonly keyFile: string;
    private constructor(public readonly directory: string) {
        this.keyFile = join(directory, 'device-key.json');
    }
    public static async create(): Promise<IdentityFixture> {
        return new IdentityFixture(await mkdtemp(join(homedir(), '.nerva-identity-test-')));
    }
    public async [Symbol.asyncDispose](): Promise<void> {
        await rm(this.directory, { recursive: true, force: true });
    }
}

it('initialization persists one owner-private signing key and retries preserve the original identity and bytes', async (): Promise<void> => {
    await using fixture: IdentityFixture = await IdentityFixture.create();
    const publicKey: string = await ConnectorDeviceKey.initialize(fixture.keyFile);
    const original: Buffer = await readFile(fixture.keyFile);
    const identity: ConnectorDeviceIdentity = await ConnectorDeviceKey.load(fixture.keyFile);
    expect(identity.publicKey).toBe(publicKey);
    const data: Buffer = Buffer.from('device-link-proof-' + crypto.randomUUID());
    expect(
        SigningKey.verify(
            SignaturePurpose.LinkStart,
            publicKey,
            data,
            identity.key.sign(SignaturePurpose.LinkStart, data),
        ),
    ).toBe(true);
    expect(await ConnectorDeviceKey.initialize(fixture.keyFile)).toBe(publicKey);
    expect(await readFile(fixture.keyFile)).toEqual(original);
    expect((await lstat(fixture.keyFile, { bigint: true })).mode & 0o777n).toBe(0o600n);
    expect(await readdir(fixture.directory)).toEqual(['device-key.json']);
});

it("concurrent initializers cannot publish different keys or delete one another's partial output", async (): Promise<void> => {
    await using fixture: IdentityFixture = await IdentityFixture.create();
    const results: readonly PromiseSettledResult<string>[] = await Promise.allSettled(
        Array.from({ length: 8 }, (): Promise<string> =>
            ConnectorDeviceKey.initialize(fixture.keyFile),
        ),
    );
    const identity: ConnectorDeviceIdentity = await ConnectorDeviceKey.load(fixture.keyFile);
    let successes: number = 0;
    for (const result of results) {
        if (result.status === 'fulfilled') {
            successes++;
            expect(result.value).toBe(identity.publicKey);
        }
    }
    expect(successes).toBeGreaterThan(0);
    expect(await ConnectorDeviceKey.initialize(fixture.keyFile)).toBe(identity.publicKey);
    expect(await readdir(fixture.directory)).toEqual(['device-key.json']);
});

it('an interrupted pre-publication write is removed, while an interrupted final link retains its original key', async (): Promise<void> => {
    await using fixture: IdentityFixture = await IdentityFixture.create();
    await writeFile(fixture.keyFile + '.partial', 'interrupted-private-write', { mode: 0o600 });
    const publicKey: string = await ConnectorDeviceKey.initialize(fixture.keyFile);
    const original: Buffer = await readFile(fixture.keyFile);
    await link(fixture.keyFile, fixture.keyFile + '.partial');
    expect(await ConnectorDeviceKey.initialize(fixture.keyFile)).toBe(publicKey);
    expect(await readFile(fixture.keyFile)).toEqual(original);
    expect((await lstat(fixture.keyFile, { bigint: true })).nlink).toBe(1n);
    expect(await readdir(fixture.directory)).toEqual(['device-key.json']);
});

it('corrupt, wrong-algorithm, linked and symlinked existing identities are rejected without replacement', async (): Promise<void> => {
    await using fixture: IdentityFixture = await IdentityFixture.create();
    const invalid: Buffer[] = [
        Buffer.from('corrupt identity'),
        Buffer.from(
            generateKeyPairSync('ed25519').privateKey.export({ format: 'pem', type: 'pkcs8' }),
        ),
        Buffer.from(
            generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey.export({
                format: 'pem',
                type: 'pkcs8',
            }),
        ),
    ];
    for (const original of invalid) {
        await writeFile(fixture.keyFile, original, { mode: 0o600 });
        await expect(ConnectorDeviceKey.initialize(fixture.keyFile)).rejects.toThrow();
        expect(await readFile(fixture.keyFile)).toEqual(original);
    }
    await rm(fixture.keyFile);
    await ConnectorDeviceKey.initialize(fixture.keyFile);
    const original: Buffer = await readFile(fixture.keyFile);
    const other: string = join(fixture.directory, 'other-key.json');
    await link(fixture.keyFile, other);
    await expect(ConnectorDeviceKey.initialize(fixture.keyFile)).rejects.toThrow();
    await rm(fixture.keyFile);
    await symlink(other, fixture.keyFile);
    await expect(ConnectorDeviceKey.initialize(fixture.keyFile)).rejects.toThrow();
    expect(await readFile(other)).toEqual(original);
});

it('unsafe ancestry and partial-file substitution fail before creating an identity', async (): Promise<void> => {
    await using fixture: IdentityFixture = await IdentityFixture.create();
    const unsafe: string = join(fixture.directory, 'unsafe');
    await mkdir(unsafe, { mode: 0o755 });
    await expect(ConnectorDeviceKey.initialize(join(unsafe, 'key'))).rejects.toThrow();
    await chmod(unsafe, 0o777);
    await expect(ConnectorDeviceKey.initialize(join(unsafe, 'key'))).rejects.toThrow();
    const target: string = join(fixture.directory, 'unrelated');
    await writeFile(target, 'preserve', { mode: 0o600 });
    await symlink(target, fixture.keyFile + '.partial');
    await expect(ConnectorDeviceKey.initialize(fixture.keyFile)).rejects.toThrow();
    expect(await readFile(target, 'utf8')).toBe('preserve');
    await expect(lstat(fixture.keyFile)).rejects.toThrow();
});

it('the audited standalone CLI generates its device key without exporting private bytes or creating dependency copies', async (): Promise<void> => {
    await using fixture: IdentityFixture = await IdentityFixture.create();
    const artifact: string = join(fixture.directory, 'connector.mjs');
    const execute: typeof execFile.__promisify__ = promisify(execFile);
    await execute(process.execPath, ['script/build-connector.ts', '--output', artifact], {
        cwd: new URL('../', import.meta.url),
        env: { ...process.env, NODE_OPTIONS: '' },
        timeout: 15000,
        maxBuffer: 16384,
    });
    const reply: Awaited<ReturnType<typeof execute>> = await execute(
        process.execPath,
        [artifact, 'initialize-identity', '--key-file', fixture.keyFile],
        { env: { ...process.env, NODE_OPTIONS: '' }, timeout: 5000, maxBuffer: 4096 },
    );
    const raw: unknown = JSON.parse(reply.stdout.toString());
    const result: Readonly<Record<string, unknown>> = Boundary.record(raw, ['suite', 'publicKey']);
    expect(result['suite']).toBe(SignatureSuite.MlDsa44Ed25519);
    const publicKey: string = ConnectorEnrollmentCodec.binary(
        result['publicKey'],
        IdentityLengths.publicKey,
    );
    expect((await ConnectorDeviceKey.load(fixture.keyFile)).publicKey).toBe(publicKey);
    expect(reply.stderr).toBe('');
    const original: Buffer = await readFile(fixture.keyFile);
    const retry: Awaited<ReturnType<typeof execute>> = await execute(
        process.execPath,
        [artifact, 'initialize-identity', '--key-file', fixture.keyFile],
        { env: { ...process.env, NODE_OPTIONS: '' }, timeout: 5000, maxBuffer: 4096 },
    );
    expect(retry.stdout).toBe(reply.stdout);
    expect(await readFile(fixture.keyFile)).toEqual(original);
    expect((await readdir(fixture.directory)).sort()).toEqual([
        'THIRD-PARTY-NOTICES.txt',
        'connector.mjs',
        'device-key.json',
        'nerva-connector-host-worker.mjs',
    ]);
});
