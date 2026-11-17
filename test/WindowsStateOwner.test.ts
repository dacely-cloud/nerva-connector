// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, writeFile, rm, link, symlink } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, win32 } from 'node:path';
import { expect, it } from 'vitest';
import { ProtectedFiles } from '../src/local/ProtectedFiles.js';
import { ProtectedFileLimits } from '../src/local/ProtectedFileLimits.js';
import {
    ConnectorDeviceKey,
    type ConnectorDeviceIdentity,
} from '../src/runtime/ConnectorDeviceKey.js';
import {
    ConnectorPrivateDirectory,
    ConnectorDirectoryPurpose,
} from '../src/runtime/ConnectorPrivateDirectory.js';
import {
    IdentityLengths,
    SignaturePurpose,
} from 'nerva-connector-protocol/identity/IdentityFormat.js';
import { SigningKey } from '../src/identity/SigningKey.js';
import { WindowsStateOwner } from '../src/windows/WindowsStateOwner.js';
import { ConnectorReleaseArtifacts } from '../src/install/ConnectorReleaseArtifacts.js';
import {
    ConnectorReleaseFile,
    type ConnectorReleaseArtifact,
} from '../src/install/ConnectorRelease.js';
import {
    WindowsStateOperation,
    WindowsStatePurpose,
    WindowsStateFailure,
    type WindowsStateResponse,
} from '../src/windows/WindowsStateProtocol.js';

/** Only the nonce-marked qualification child is removed after all native handles are closed. */
async function removeOwnedFixture(directory: string, nonce: string): Promise<void> {
    const marker: string = await readFile(join(directory, 'qualification-owner'), 'utf8');
    if (marker !== nonce) {
        throw new Error('Windows fixture ownership changed');
    }
    await rm(directory, { recursive: true, force: false });
}

it.skipIf(process.platform !== 'win32')(
    'the actual Windows state owner preserves a DPAPI identity, rejects competing owners, unsafe ACLs, hardlinks and junction traversal',
    async (): Promise<void> => {
        const root: WindowsStateResponse = await WindowsStateOwner.request(
            WindowsStateOperation.Root,
        );
        if (root.path === null) {
            throw new Error('Verified Windows Known Folder required');
        }
        const nonce: string = crypto.randomUUID();
        const directory: string = join(root.path, 'qualification-' + nonce);
        let created: boolean = false;
        try {
            await ProtectedFiles.createDirectory(directory);
            created = true;
            await using owner: ConnectorPrivateDirectory = await ConnectorPrivateDirectory.open(
                directory,
                ConnectorDirectoryPurpose.Installation,
            );
            await owner.write('qualification-owner', Buffer.from(nonce), 128, true);
            const large: Buffer = Buffer.alloc(ProtectedFileLimits.hostRecordBytes, 255);
            try {
                await owner.write('host-journal', large, ProtectedFileLimits.hostRecordBytes, true);
                const retained: Buffer = await owner.read(
                    'host-journal',
                    ProtectedFileLimits.hostRecordBytes,
                );
                try {
                    expect(retained.equals(large)).toBe(true);
                } finally {
                    retained.fill(0);
                }
                await expect(
                    owner.write('other-state', large, ProtectedFileLimits.hostRecordBytes, true),
                ).rejects.toThrow();
                await using identityOwner: ConnectorPrivateDirectory =
                    await ConnectorPrivateDirectory.open(
                        directory,
                        ConnectorDirectoryPurpose.Identity,
                    );
                await expect(
                    identityOwner.read('host-journal', ProtectedFileLimits.hostRecordBytes),
                ).rejects.toThrow();
                await owner.remove('host-journal', ProtectedFileLimits.hostRecordBytes);
            } finally {
                large.fill(0);
            }
            const keyFile: string = join(directory, 'device-key.json');
            const publicKey: string = await ConnectorDeviceKey.initialize(keyFile);
            const encrypted: Buffer = await readFile(keyFile);
            expect(encrypted.subarray(0, 13).toString()).toBe('NEXA-DPAPI-1\n');
            const identity: ConnectorDeviceIdentity = await ConnectorDeviceKey.load(keyFile);
            using key: SigningKey = identity.key;
            const message: Buffer = Buffer.from('windows-pairing-qualification');
            expect(
                SigningKey.verify(
                    SignaturePurpose.LinkStart,
                    publicKey,
                    message,
                    key.sign(SignaturePurpose.LinkStart, message),
                ),
            ).toBe(true);
            expect(await ConnectorDeviceKey.initialize(keyFile)).toBe(publicKey);
            expect(await readFile(keyFile)).toEqual(encrypted);
            const plaintext: Buffer = await owner.read(
                'device-key.json',
                IdentityLengths.privateRecord,
            );
            try {
                expect(plaintext.equals(encrypted)).toBe(false);
            } finally {
                plaintext.fill(0);
            }
            await expect(
                owner.write(
                    'device-key.json',
                    Buffer.from('replacement'),
                    IdentityLengths.privateRecord,
                    true,
                ),
            ).rejects.toThrow();
            expect(await readFile(keyFile)).toEqual(encrypted);
            await expect(
                ConnectorPrivateDirectory.open(directory, ConnectorDirectoryPurpose.Installation),
            ).rejects.toMatchObject({ failure: WindowsStateFailure.Busy });
            const value: Buffer = Buffer.from([0x00, 0xff, 0x41]);
            await owner.write('payload', value, 16, true);
            expect(await owner.read('payload', 16)).toEqual(value);
            await owner.write('payload', Buffer.from('replaced'), 16, false);
            expect((await owner.read('payload', 16)).toString()).toBe('replaced');
            expect(await owner.exists('missing')).toBe(false);
            expect(await owner.list()).toContain('device-key.json');
            await owner.remove('payload', 16);
            expect(await owner.exists('payload')).toBe(false);
            await owner.write('linked', value, 16, true);
            await link(join(directory, 'linked'), join(directory, 'linked-alias'));
            await expect(owner.read('linked', 16)).rejects.toMatchObject({
                failure: WindowsStateFailure.Untrusted,
            });
            await symlink(directory, join(directory, 'junction'), 'junction');
            await expect(
                ProtectedFiles.directory(join(directory, 'junction')),
            ).rejects.toMatchObject({ failure: WindowsStateFailure.Untrusted });
            await owner.write('unsafe-acl', value, 16, true);
            const systemRoot: string | undefined = process.env['SystemRoot'];
            if (systemRoot === undefined) {
                throw new Error('Windows SystemRoot required');
            }
            await promisify(execFile)(
                win32.join(systemRoot, 'System32/icacls.exe'),
                [join(directory, 'unsafe-acl'), '/grant', '*S-1-1-0:(R)'],
                { cwd: systemRoot, timeout: 30000, maxBuffer: 16384, windowsHide: true },
            );
            await expect(
                ProtectedFiles.readPrivate(join(directory, 'unsafe-acl'), 16),
            ).rejects.toMatchObject({ failure: WindowsStateFailure.Untrusted });
        } finally {
            await WindowsStateOwner.close();
            if (created) {
                await removeOwnedFixture(directory, nonce);
            }
        }
    },
    120000,
);

it.skipIf(process.platform !== 'win32')(
    'native Windows artifacts stream beyond the private-state byte limit and preserve existing files on failed publication',
    async (): Promise<void> => {
        const root: WindowsStateResponse = await WindowsStateOwner.request(
            WindowsStateOperation.Root,
        );
        if (root.path === null) {
            throw new Error('Verified Windows Known Folder required');
        }
        const nonce: string = crypto.randomUUID();
        const directory: string = join(root.path, 'qualification-artifacts-' + nonce);
        let created: boolean = false;
        try {
            await ProtectedFiles.createDirectory(directory);
            created = true;
            await using owner: ConnectorPrivateDirectory = await ConnectorPrivateDirectory.open(
                directory,
                ConnectorDirectoryPurpose.Installation,
            );
            await owner.write('qualification-owner', Buffer.from(nonce), 128, true);
            await owner.write('source.bin', Buffer.from('seed'), 16, true);
            const source: string = join(directory, 'source.bin');
            const payload: Buffer = Buffer.alloc(2 * 1024 * 1024 + 31, 0xa5);
            await writeFile(source, payload);
            const signal: AbortSignal = new AbortController().signal;
            const artifact: ConnectorReleaseArtifact = await ConnectorReleaseArtifacts.describe(
                source,
                ConnectorReleaseFile.WindowsRuntime,
                signal,
            );
            expect(artifact.sizeBytes).toBe(BigInt(payload.byteLength));
            expect(artifact.sha256).toBe(createHash('sha256').update(payload).digest('hex'));
            await ConnectorReleaseArtifacts.install(source, owner, artifact, signal);
            await ConnectorReleaseArtifacts.verify(directory, artifact, signal);
            expect(await readFile(owner.file(artifact.name))).toEqual(payload);
            await expect(owner.read(artifact.name, 1048576)).rejects.toThrow();
            await ConnectorReleaseArtifacts.install(source, owner, artifact, signal);
            await writeFile(owner.file(artifact.name), 'changed');
            await expect(
                ConnectorReleaseArtifacts.install(source, owner, artifact, signal),
            ).rejects.toThrow();
            expect((await readFile(owner.file(artifact.name))).toString()).toBe('changed');
            await ConnectorReleaseArtifacts.install(source, owner, artifact, signal, true);
            await expect(
                ConnectorReleaseArtifacts.install(
                    source,
                    owner,
                    { ...artifact, sha256: '0'.repeat(64) },
                    signal,
                    true,
                ),
            ).rejects.toThrow();
            expect(await readFile(owner.file(artifact.name))).toEqual(payload);
            expect(
                (await owner.list()).some((name: string): boolean => name.endsWith('.partial')),
            ).toBe(false);
            await using identity: ConnectorPrivateDirectory = await ConnectorPrivateDirectory.open(
                directory,
                ConnectorDirectoryPurpose.Identity,
            );
            await expect(
                identity.installArtifact(
                    source,
                    'wrong-purpose',
                    artifact.sizeBytes,
                    artifact.sha256,
                    268435456,
                    false,
                ),
            ).rejects.toMatchObject({ failure: WindowsStateFailure.Invalid });
            const runtime: WindowsStateResponse = await WindowsStateOwner.request(
                WindowsStateOperation.Open,
                { path: directory, purpose: WindowsStatePurpose.Runtime },
            );
            if (runtime.lease === null) {
                throw new Error('Native runtime lease required');
            }
            try {
                await expect(
                    WindowsStateOwner.request(WindowsStateOperation.ArtifactInstall, {
                        path: source,
                        lease: runtime.lease,
                        name: artifact.name,
                        maximumBytes: 268435456,
                        sizeBytes: artifact.sizeBytes,
                        sha256: artifact.sha256,
                        replace: false,
                    }),
                ).rejects.toMatchObject({ failure: WindowsStateFailure.Untrusted });
            } finally {
                await WindowsStateOwner.request(WindowsStateOperation.Close, {
                    lease: runtime.lease,
                });
            }
            await expect(
                WindowsStateOwner.request(WindowsStateOperation.ArtifactInstall, {
                    path: source,
                    lease: '0'.repeat(64),
                    name: 'forged-lease',
                    maximumBytes: 268435456,
                    sizeBytes: artifact.sizeBytes,
                    sha256: artifact.sha256,
                    replace: false,
                }),
            ).rejects.toThrow();
        } finally {
            await WindowsStateOwner.close();
            if (created) {
                await removeOwnedFixture(directory, nonce);
            }
        }
    },
    120000,
);
