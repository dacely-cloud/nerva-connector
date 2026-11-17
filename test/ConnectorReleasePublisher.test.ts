// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

import {
    mkdtemp,
    writeFile,
    readFile,
    readdir,
    rm,
    symlink,
    unlink,
    lstat,
    chmod,
} from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
import { expect, it, vi, type MockInstance } from 'vitest';
import { ConnectorReleasePublisher } from '../script/ConnectorReleasePublisher.js';
import {
    ConnectorWindowsNativeBuild,
    type WindowsNativeBuildInput,
} from '../script/ConnectorWindowsNativeBuild.js';
import { ConnectorBootstrapWindowsBuild } from '../script/ConnectorBootstrapWindowsBuild.js';
import { ConnectorWindowsCompiler } from '../script/ConnectorWindowsCompiler.js';
import {
    ConnectorPrivateDirectory,
    ConnectorDirectoryPurpose,
} from '../src/runtime/ConnectorPrivateDirectory.js';
import { WindowsStateOwner } from '../src/windows/WindowsStateOwner.js';
import {
    WindowsStateOperation,
    WindowsStateFailure,
    WindowsStateError,
    type WindowsStateParameters,
    type WindowsStateResponse,
} from '../src/windows/WindowsStateProtocol.js';
import type { WindowsStateArtifact } from '../src/windows/WindowsStateArtifact.js';
import { ConnectorNpmPackage } from '../script/ConnectorNpmPackage.js';
import { ConnectorNpmPackageDirectory } from '../script/ConnectorNpmPackageDirectory.js';
import { ConnectorReleaseFixture } from './support/ConnectorReleaseFixture.js';
import { ConnectorReleasePlatform } from '../src/install/ConnectorRelease.js';

/** This non-runnable PE-shaped fixture binds current reviewed C# source without compiling a native executable. */
async function bootstrapCache(directory: string): Promise<WindowsStateArtifact> {
    const sources: readonly string[] = await Promise.all(
        [
            'StateOwner.cs',
            'GpuInventory.cs',
            'ArtifactOperations.cs',
            'BootstrapProcess.cs',
            'ReleaseBootstrap.cs',
        ].map((name: string): Promise<string> => readFile(resolve('native/windows', name), 'utf8')),
    );
    const bytes: Buffer = Buffer.alloc(512, 0x41);
    bytes[0] = 0x4d;
    bytes[1] = 0x5a;
    const artifact: WindowsStateArtifact = {
        bytes: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex'),
        sourceSha256: createHash('sha256')
            .update(
                ['NexaConnectorReleaseBootstrap', ...sources, '']
                    .map((part: string): string => part.replaceAll('\r\n', '\n'))
                    .join('\n'),
            )
            .digest('hex'),
    };
    await writeFile(join(directory, 'nerva-connector-bootstrap.exe'), bytes, { mode: 0o700 });
    await writeFile(join(directory, 'nerva-connector-bootstrap.json'), JSON.stringify(artifact), {
        mode: 0o600,
    });
    return artifact;
}

/** Only the fixed local protocol is modeled; this portable fixture does not qualify Windows ACL enforcement. */
function reply(values: Partial<WindowsStateResponse> = {}): WindowsStateResponse {
    return {
        id: '1',
        ok: true,
        path: null,
        lease: null,
        exists: null,
        names: null,
        dataBase64: null,
        error: null,
        sizeBytes: null,
        sha256: null,
        ...values,
    };
}

it.skipIf(process.platform !== 'linux')(
    'publisher repeats preserve executable modes and refuse invalid current leaves or unsafe partials without repair',
    async (): Promise<void> => {
        const directory: string = await mkdtemp(join(homedir(), 'nerva-publisher-write-'));
        try {
            await using owner: ConnectorPrivateDirectory = await ConnectorPrivateDirectory.open(
                directory,
                ConnectorDirectoryPurpose.Installation,
            );
            await ConnectorReleasePublisher.write(owner, 'launcher.sh', Buffer.from('first'));
            await writeFile(join(directory, 'launcher.sh.partial'), 'interrupted', { mode: 0o600 });
            await ConnectorReleasePublisher.write(owner, 'launcher.sh', Buffer.from('second'));
            expect(await readFile(join(directory, 'launcher.sh'), 'utf8')).toBe('second');
            expect((await lstat(join(directory, 'launcher.sh'))).mode & 0o777).toBe(0o700);
            expect(await readdir(directory)).toEqual(['launcher.sh']);
            await writeFile(join(directory, 'launcher.sh.partial'), 'unsafe', { mode: 0o600 });
            await chmod(join(directory, 'launcher.sh.partial'), 0o666);
            await expect(
                ConnectorReleasePublisher.write(
                    owner,
                    'launcher.sh',
                    Buffer.from('must not replace'),
                ),
            ).rejects.toThrow();
            expect(await readFile(join(directory, 'launcher.sh'), 'utf8')).toBe('second');
            expect(await readFile(join(directory, 'launcher.sh.partial'), 'utf8')).toBe('unsafe');
            await rm(join(directory, 'launcher.sh.partial'));
            await unlink(join(directory, 'launcher.sh'));
            await writeFile(join(directory, 'foreign'), 'preserved', { mode: 0o600 });
            await symlink(join(directory, 'foreign'), join(directory, 'launcher.sh'));
            await expect(
                ConnectorReleasePublisher.write(
                    owner,
                    'launcher.sh',
                    Buffer.from('must not adopt'),
                ),
            ).rejects.toThrow();
            expect((await lstat(join(directory, 'launcher.sh'))).isSymbolicLink()).toBe(true);
            expect(await readFile(join(directory, 'foreign'), 'utf8')).toBe('preserved');
            await expect(
                ConnectorReleasePublisher.write(owner, 'unknown.json', Buffer.from('x')),
            ).rejects.toThrow('Invalid bounded');
        } finally {
            await rm(directory, { recursive: true, force: true });
        }
    },
);

it('Windows publisher uses existing native write leases, rejects private validation failures and always closes its owned lease', async (): Promise<void> => {
    const descriptor: PropertyDescriptor | undefined = Object.getOwnPropertyDescriptor(
        process,
        'platform',
    );
    if (descriptor === undefined) {
        throw new Error('Platform descriptor unavailable');
    }
    const calls: WindowsStateOperation[] = [];
    let bytes: Buffer | null = null;
    let invalid: boolean = false;
    const request: MockInstance<typeof WindowsStateOwner.request> = vi.spyOn(
        WindowsStateOwner,
        'request',
    );
    request.mockImplementation(
        (
            operation: WindowsStateOperation,
            parameters: WindowsStateParameters = {},
        ): Promise<WindowsStateResponse> => {
            calls.push(operation);
            if (operation === WindowsStateOperation.Open) {
                return Promise.resolve(reply({ lease: 'test-private-lease' }));
            }
            if (
                operation === WindowsStateOperation.CleanPartial ||
                operation === WindowsStateOperation.Close
            ) {
                return Promise.resolve(reply());
            }
            if (operation === WindowsStateOperation.Exists) {
                if (invalid) {
                    return Promise.reject(new WindowsStateError(WindowsStateFailure.Untrusted));
                }
                return Promise.resolve(reply({ exists: bytes !== null }));
            }
            if (operation === WindowsStateOperation.Read && bytes !== null) {
                return Promise.resolve(reply({ dataBase64: bytes.toString('base64') }));
            }
            if (operation === WindowsStateOperation.Write && parameters.dataBase64 !== undefined) {
                expect(parameters.lease).toBe('test-private-lease');
                expect(parameters.initialize).toBe(bytes === null);
                bytes = Buffer.from(parameters.dataBase64, 'base64');
                return Promise.resolve(reply());
            }
            return Promise.reject(new Error('Unexpected native publication request'));
        },
    );
    try {
        Object.defineProperty(process, 'platform', { value: 'win32' });
        await using owner: ConnectorPrivateDirectory = await ConnectorPrivateDirectory.open(
            '/portable/private-publisher',
            ConnectorDirectoryPurpose.Installation,
        );
        await ConnectorReleasePublisher.write(owner, 'release.json', Buffer.from('first'));
        await ConnectorReleasePublisher.write(owner, 'release.json', Buffer.from('second'));
        invalid = true;
        await expect(
            ConnectorReleasePublisher.write(owner, 'release.json', Buffer.from('must not replace')),
        ).rejects.toMatchObject({ failure: WindowsStateFailure.Untrusted });
        expect(bytes).toEqual(Buffer.from('second'));
        expect(
            calls.filter(
                (operation: WindowsStateOperation): boolean =>
                    operation === WindowsStateOperation.Write,
            ),
        ).toHaveLength(2);
    } finally {
        Object.defineProperty(process, 'platform', descriptor);
        request.mockRestore();
    }
    expect(calls.at(-1)).toBe(WindowsStateOperation.Close);
});

it('cached-only native publisher verification detects missing, stale and changed bytes without compiler fallback or output repair', async (): Promise<void> => {
    const directory: string = await mkdtemp(join(homedir(), 'nerva-publisher-cache-'));
    const compile: MockInstance<typeof ConnectorWindowsCompiler.compile> = vi
        .spyOn(ConnectorWindowsCompiler, 'compile')
        .mockRejectedValue(new Error('Compilation is forbidden in this fixture'));
    try {
        const source: string = join(directory, 'fixture.cs');
        await writeFile(source, 'class Fixture {}\n', { mode: 0o600 });
        const input: WindowsNativeBuildInput = {
            directory,
            stem: 'fixture',
            entrypoint: 'Fixture',
            sources: [source],
        };
        expect(await ConnectorWindowsNativeBuild.cached(input)).toBeNull();
        const bytes: Buffer = Buffer.alloc(512, 0x41);
        bytes[0] = 0x4d;
        bytes[1] = 0x5a;
        const artifact: WindowsStateArtifact = {
            bytes: bytes.length,
            sha256: createHash('sha256').update(bytes).digest('hex'),
            sourceSha256: 'a3cbf2b5b72b6e1c20e32abc417f94121de8a93de585d47f710c6478245de7f7',
        };
        await writeFile(join(directory, 'fixture.exe'), bytes, { mode: 0o700 });
        const encoded: string = JSON.stringify(artifact);
        await writeFile(join(directory, 'fixture.json'), encoded, { mode: 0o600 });
        expect(await ConnectorWindowsNativeBuild.cached(input)).toEqual(artifact);
        await writeFile(source, 'class Fixture { public int Changed; }\n');
        expect(await ConnectorWindowsNativeBuild.cached(input)).toBeNull();
        await writeFile(source, 'class Fixture {}\n');
        bytes[511] = 0x42;
        await writeFile(join(directory, 'fixture.exe'), bytes);
        expect(await ConnectorWindowsNativeBuild.cached(input)).toBeNull();
        await expect(ConnectorBootstrapWindowsBuild.cached(directory)).rejects.toThrow(
            'missing, stale or invalid',
        );
        expect(compile).not.toHaveBeenCalled();
        expect(await readFile(join(directory, 'fixture.json'), 'utf8')).toBe(encoded);
        expect(await readFile(join(directory, 'fixture.exe'))).toEqual(bytes);
        expect((await readdir(directory)).toSorted()).toEqual([
            'fixture.cs',
            'fixture.exe',
            'fixture.json',
        ]);
    } finally {
        compile.mockRestore();
        await rm(directory, { recursive: true, force: true });
    }
});

it.skipIf(process.platform !== 'linux')(
    'provided npm bootstrap pins cannot bypass current-source cache validation before any package write or compiler fallback',
    async (): Promise<void> => {
        await using fixture: ConnectorReleaseFixture = await ConnectorReleaseFixture.create(
            false,
            undefined,
            ConnectorReleasePlatform.Windows,
        );
        const artifact: WindowsStateArtifact = await bootstrapCache(fixture.directory);
        const directory: string = join(fixture.directory, 'npm');
        const compile: MockInstance<typeof ConnectorWindowsCompiler.compile> = vi
            .spyOn(ConnectorWindowsCompiler, 'compile')
            .mockRejectedValue(new Error('Native compilation forbidden'));
        const build: MockInstance<typeof ConnectorBootstrapWindowsBuild.build> = vi.spyOn(
            ConnectorBootstrapWindowsBuild,
            'build',
        );
        const create: MockInstance<typeof ConnectorNpmPackageDirectory.create> = vi.spyOn(
            ConnectorNpmPackageDirectory,
            'create',
        );
        const write: MockInstance<typeof ConnectorReleasePublisher.write> = vi.spyOn(
            ConnectorReleasePublisher,
            'write',
        );
        try {
            for (const provided of [
                { ...artifact, sourceSha256: 'f'.repeat(64) },
                { ...artifact, sha256: 'f'.repeat(64) },
                { ...artifact, bytes: artifact.bytes + 1 },
            ]) {
                await expect(
                    ConnectorNpmPackage.prepare(
                        directory,
                        '0.1.0',
                        fixture.release,
                        fixture.key.publicKey,
                        'https://downloads.example.com/approved/',
                        fixture.directory,
                        provided,
                    ),
                ).rejects.toThrow();
            }
            const stale: WindowsStateArtifact = { ...artifact, sourceSha256: 'f'.repeat(64) };
            await writeFile(
                join(fixture.directory, 'nerva-connector-bootstrap.json'),
                JSON.stringify(stale),
            );
            await expect(
                ConnectorNpmPackage.prepare(
                    directory,
                    '0.1.0',
                    fixture.release,
                    fixture.key.publicKey,
                    'https://downloads.example.com/approved/',
                    fixture.directory,
                    stale,
                ),
            ).rejects.toThrow();
            expect(create).not.toHaveBeenCalled();
            expect(write).not.toHaveBeenCalled();
            expect(build).not.toHaveBeenCalled();
            expect(compile).not.toHaveBeenCalled();
            expect(await readdir(fixture.directory)).not.toContain('npm');
        } finally {
            write.mockRestore();
            create.mockRestore();
            build.mockRestore();
            compile.mockRestore();
        }
    },
);

it.skipIf(process.platform !== 'linux')(
    'valid same-publisher cached bootstrap handoff can prepare and repeat its npm child without compilation or cache replacement',
    async (): Promise<void> => {
        await using fixture: ConnectorReleaseFixture = await ConnectorReleaseFixture.create(
            false,
            undefined,
            ConnectorReleasePlatform.Windows,
        );
        const artifact: WindowsStateArtifact = await bootstrapCache(fixture.directory);
        const encoded: string = await readFile(
            join(fixture.directory, 'nerva-connector-bootstrap.json'),
            'utf8',
        );
        const directory: string = join(fixture.directory, 'npm');
        const compile: MockInstance<typeof ConnectorWindowsCompiler.compile> = vi
            .spyOn(ConnectorWindowsCompiler, 'compile')
            .mockRejectedValue(new Error('Native compilation forbidden'));
        const build: MockInstance<typeof ConnectorBootstrapWindowsBuild.build> = vi.spyOn(
            ConnectorBootstrapWindowsBuild,
            'build',
        );
        try {
            for (let attempt: number = 0; attempt < 2; attempt++) {
                expect(
                    await ConnectorNpmPackage.prepare(
                        directory,
                        '0.1.0',
                        fixture.release,
                        fixture.key.publicKey,
                        'https://downloads.example.com/approved/',
                        fixture.directory,
                        artifact,
                    ),
                ).toBe(directory);
            }
            expect((await readdir(directory)).toSorted()).toEqual([
                'README.md',
                'launcher.cjs',
                'nerva-connector-bootstrap.exe',
                'package.json',
            ]);
            expect(
                await readFile(join(fixture.directory, 'nerva-connector-bootstrap.json'), 'utf8'),
            ).toBe(encoded);
            expect(build).not.toHaveBeenCalled();
            expect(compile).not.toHaveBeenCalled();
        } finally {
            build.mockRestore();
            compile.mockRestore();
        }
    },
);
