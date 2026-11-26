// SPDX-FileCopyrightText: 2026 Dacely <business@dacely.com>
// SPDX-License-Identifier: LicenseRef-Proprietary

import { expect, it } from 'vitest';
import { readFile, writeFile, readdir, symlink, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { ConnectorReleaseFixture } from './support/ConnectorReleaseFixture.js';
import {
    ConnectorReleaseInstallation,
    type ConnectorReleaseInstallationResult,
} from '../src/install/ConnectorReleaseInstallation.js';
import { ConnectorReleaseCodec } from '../src/install/ConnectorReleaseCodec.js';
import { ConnectorReleaseLimits } from '../src/install/ConnectorReleaseLimits.js';
import { SignaturePurpose } from 'nerva-connector-protocol/identity/IdentityFormat.js';
import {
    ConnectorReleaseFile,
    type ConnectorReleaseArtifact,
    type ConnectorSignedRelease,
} from '../src/install/ConnectorRelease.js';
import { ConnectorDeviceKey } from '../src/runtime/ConnectorDeviceKey.js';

it('a dual-signed application remains bounded at the same maximum used by the source builder', async (): Promise<void> => {
    await using fixture: ConnectorReleaseFixture = await ConnectorReleaseFixture.create();
    for (const size of [
        ConnectorReleaseLimits.applicationBytes,
        ConnectorReleaseLimits.applicationBytes + 1,
    ]) {
        const manifest: ConnectorSignedRelease['manifest'] = {
            ...fixture.release.manifest,
            artifacts: fixture.release.manifest.artifacts.map(
                (artifact: ConnectorReleaseArtifact): ConnectorReleaseArtifact =>
                    artifact.name === ConnectorReleaseFile.Application
                        ? { ...artifact, sizeBytes: BigInt(size) }
                        : artifact,
            ),
        };
        const release: ConnectorSignedRelease = {
            manifest,
            signature: fixture.key.sign(
                SignaturePurpose.Release,
                ConnectorReleaseCodec.payload(manifest),
            ),
        };
        const raw: unknown = JSON.parse(ConnectorReleaseCodec.encode(release).toString('utf8'));
        const decode: () => ConnectorSignedRelease = (): ConnectorSignedRelease =>
            ConnectorReleaseCodec.read(raw, fixture.key.publicKey, manifest.issuedAtMs);
        if (size === ConnectorReleaseLimits.applicationBytes) {
            expect(decode().manifest.artifacts[0]?.sizeBytes).toBe(BigInt(size));
        } else {
            expect(decode).toThrow();
        }
    }
});

it('installation verifies all signed assets, creates protected public trust without local grants and preserves device identity on exact repeat', async (): Promise<void> => {
    await using fixture: ConnectorReleaseFixture = await ConnectorReleaseFixture.create();
    const config: string = join(fixture.directory, 'installation.json');
    const result: ConnectorReleaseInstallationResult = await ConnectorReleaseInstallation.install(
        config,
        new AbortController().signal,
    );
    expect(result.revision).toBe('9007199254740993');
    const raw: unknown = JSON.parse(await readFile(result.pairingFile, 'utf8'));
    expect(raw).toMatchObject({ files: null, execution: null, authorityId: 'cloud' });
    const keyPath: string = join(fixture.directory, 'installed', 'state', 'device-key.json');
    const identity: string = await ConnectorDeviceKey.initialize(keyPath);
    const before: Buffer = await readFile(keyPath);
    expect(
        await ConnectorReleaseInstallation.install(config, new AbortController().signal),
    ).toEqual(result);
    expect(await ConnectorDeviceKey.initialize(keyPath)).toBe(identity);
    expect(await readFile(keyPath)).toEqual(before);
    expect((await stat(join(fixture.directory, 'installed', 'state'))).mode & 0o077).toBe(0);
    expect(
        (await readdir(join(fixture.directory, 'installed'))).some((name: string): boolean =>
            name.includes('partial'),
        ),
    ).toBe(false);
});

it.each([ConnectorReleaseFile.Files, ConnectorReleaseFile.Execution])(
    'a substituted signed %s helper is refused before installation or grant creation',
    async (name: ConnectorReleaseFile): Promise<void> => {
        await using fixture: ConnectorReleaseFixture = await ConnectorReleaseFixture.create();
        const path: string = join(fixture.directory, 'assets', name);
        const bytes: Buffer = await readFile(path);
        await writeFile(path, Buffer.alloc(bytes.byteLength));
        await expect(
            ConnectorReleaseInstallation.install(
                join(fixture.directory, 'installation.json'),
                new AbortController().signal,
            ),
        ).rejects.toThrow();
        expect(await readdir(fixture.directory)).not.toContain('installed');
    },
);

it('a release without both signed native helpers is an incomplete contract even with a valid release signature', async (): Promise<void> => {
    await using fixture: ConnectorReleaseFixture = await ConnectorReleaseFixture.create();
    const manifest: ConnectorSignedRelease['manifest'] = {
        ...fixture.release.manifest,
        artifacts: fixture.release.manifest.artifacts.slice(0, 3),
    };
    const release: ConnectorSignedRelease = {
        manifest,
        signature: fixture.key.sign(
            SignaturePurpose.Release,
            ConnectorReleaseCodec.payload(manifest),
        ),
    };
    const raw: unknown = JSON.parse(ConnectorReleaseCodec.encode(release).toString('utf8'));
    expect(() =>
        ConnectorReleaseCodec.read(raw, fixture.key.publicKey, manifest.issuedAtMs),
    ).toThrow();
});

it.each([0, 2420])(
    'changing signature component at byte %i rejects the release before creating an installation',
    async (offset: number): Promise<void> => {
        await using fixture: ConnectorReleaseFixture = await ConnectorReleaseFixture.create();
        const proof: Buffer = Buffer.from(fixture.release.signature, 'base64url');
        proof[offset] ^= 1;
        await writeFile(
            join(fixture.directory, 'assets', 'release.json'),
            ConnectorReleaseCodec.encode({
                ...fixture.release,
                signature: proof.toString('base64url'),
            }),
        );
        await expect(
            ConnectorReleaseInstallation.install(
                join(fixture.directory, 'installation.json'),
                new AbortController().signal,
            ),
        ).rejects.toThrow('dual-signature');
        expect(await readdir(fixture.directory)).not.toContain('installed');
    },
);

it('asset tampering and symlink sources fail before mutation; a different signed revision cannot replace installed authority or history', async (): Promise<void> => {
    await using fixture: ConnectorReleaseFixture = await ConnectorReleaseFixture.create();
    const path: string = join(fixture.directory, 'assets', 'node');
    const bytes: Buffer = await readFile(path);
    await writeFile(path, Buffer.alloc(bytes.byteLength));
    const install: () => Promise<ConnectorReleaseInstallationResult> =
        async (): Promise<ConnectorReleaseInstallationResult> =>
            await ConnectorReleaseInstallation.install(
                join(fixture.directory, 'installation.json'),
                new AbortController().signal,
            );
    await expect(install()).rejects.toThrow();
    expect(await readdir(fixture.directory)).not.toContain('installed');
    await rm(path);
    await symlink(join(fixture.directory, 'assets', 'nerva-connector.mjs'), path);
    await expect(install()).rejects.toThrow();
    expect(await readdir(fixture.directory)).not.toContain('installed');
    await rm(path);
    await writeFile(path, bytes, { mode: 0o700 });
    await install();
    const before: Buffer = await readFile(join(fixture.directory, 'installed', 'release.json'));
    const changed: ConnectorSignedRelease['manifest'] = {
        ...fixture.release.manifest,
        revision: fixture.release.manifest.revision + 1n,
    };
    await fixture.publish({
        manifest: changed,
        signature: fixture.key.sign(
            SignaturePurpose.Release,
            ConnectorReleaseCodec.payload(changed),
        ),
    });
    await expect(install()).rejects.toThrow('upgrade');
    expect(await readFile(join(fixture.directory, 'installed', 'release.json'))).toEqual(before);
});

it('missing ready publication resumes the same signed installation while corruption and expired or foreign release authority fail closed', async (): Promise<void> => {
    await using fixture: ConnectorReleaseFixture = await ConnectorReleaseFixture.create();
    const config: string = join(fixture.directory, 'installation.json');
    await ConnectorReleaseInstallation.install(config, new AbortController().signal);
    const root: string = join(fixture.directory, 'installed');
    await rm(join(root, 'ready.json'));
    await writeFile(join(root, 'ready.json.partial'), 'interrupted', { mode: 0o600 });
    await ConnectorReleaseInstallation.install(config, new AbortController().signal);
    expect(await readdir(root)).toContain('ready.json');
    expect(await readdir(root)).not.toContain('ready.json.partial');
    const raw: unknown = JSON.parse(ConnectorReleaseCodec.encode(fixture.release).toString('utf8'));
    expect(() =>
        ConnectorReleaseCodec.read(
            raw,
            fixture.key.publicKey,
            fixture.release.manifest.expiresAtMs,
        ),
    ).toThrow();
    expect(() =>
        ConnectorReleaseCodec.read(
            raw,
            fixture.release.manifest.deployment.publicKey,
            BigInt(Date.now()),
        ),
    ).toThrow();
    const node: string = join(root, 'node');
    await writeFile(node, 'corrupt');
    await expect(
        ConnectorReleaseInstallation.install(config, new AbortController().signal),
    ).rejects.toThrow();
    expect(
        createHash('sha256')
            .update(await readFile(node))
            .digest('hex'),
    ).not.toBe(fixture.release.manifest.artifacts[1]?.sha256);
});

it('a completed installation cannot regenerate its missing original device identity', async (): Promise<void> => {
    await using fixture: ConnectorReleaseFixture = await ConnectorReleaseFixture.create();
    const config: string = join(fixture.directory, 'installation.json');
    await ConnectorReleaseInstallation.install(config, new AbortController().signal);
    const key: string = join(fixture.directory, 'installed', 'state', 'device-key.json');
    await rm(key);
    await expect(
        ConnectorReleaseInstallation.install(config, new AbortController().signal),
    ).rejects.toThrow();
    await expect(stat(key)).rejects.toMatchObject({ code: 'ENOENT' });
});

it('release authorization rejects another signature purpose, unbounded assets and device grants hidden in deployment metadata', async (): Promise<void> => {
    await using fixture: ConnectorReleaseFixture = await ConnectorReleaseFixture.create();
    const now: bigint = BigInt(Date.now());
    const changed: readonly ConnectorSignedRelease['manifest'][] = [
        { ...fixture.release.manifest, artifacts: [] },
        {
            ...fixture.release.manifest,
            artifacts: fixture.release.manifest.artifacts.map((artifact): typeof artifact => ({
                ...artifact,
                sizeBytes: 268435457n,
            })),
        },
        { ...fixture.release.manifest, revision: 0n },
    ];
    for (const manifest of changed) {
        const value: ConnectorSignedRelease = {
            manifest,
            signature: fixture.key.sign(
                SignaturePurpose.Release,
                ConnectorReleaseCodec.payload(manifest),
            ),
        };
        const raw: unknown = JSON.parse(ConnectorReleaseCodec.encode(value).toString('utf8'));
        expect((): ConnectorSignedRelease =>
            ConnectorReleaseCodec.read(raw, fixture.key.publicKey, now),
        ).toThrow();
    }
    const purpose: ConnectorSignedRelease = {
        ...fixture.release,
        signature: fixture.key.sign(
            SignaturePurpose.DeviceEnrollment,
            ConnectorReleaseCodec.payload(fixture.release.manifest),
        ),
    };
    expect((): ConnectorSignedRelease =>
        ConnectorReleaseCodec.read(
            JSON.parse(ConnectorReleaseCodec.encode(purpose).toString('utf8')),
            fixture.key.publicKey,
            now,
        ),
    ).toThrow();
    const raw: unknown = JSON.parse(ConnectorReleaseCodec.encode(fixture.release).toString('utf8'));
    if (typeof raw !== 'object' || raw === null) {
        throw new Error('Fixture missing');
    }
    const manifest: unknown = Reflect.get(raw, 'manifest');
    if (typeof manifest !== 'object' || manifest === null) {
        throw new Error('Fixture missing');
    }
    const deployment: unknown = Reflect.get(manifest, 'deployment');
    if (typeof deployment !== 'object' || deployment === null) {
        throw new Error('Fixture missing');
    }
    Reflect.set(deployment, 'execution', { mode: 'unrestricted' });
    expect((): ConnectorSignedRelease =>
        ConnectorReleaseCodec.read(raw, fixture.key.publicKey, now),
    ).toThrow();
});
