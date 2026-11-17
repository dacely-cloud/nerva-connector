// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

import { mkdir, writeFile, readFile, readdir, rm, link } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { expect, it, vi, type MockInstance } from 'vitest';
import { ConnectorReleaseFixture } from './support/ConnectorReleaseFixture.js';
import {
    ConnectorReleaseSources,
    type ConnectorReleaseSourceOptions,
} from '../script/ConnectorReleaseSources.js';
import { ConnectorReleaseArtifacts } from '../src/install/ConnectorReleaseArtifacts.js';
import { ConnectorReleaseAssets } from '../src/install/ConnectorReleaseAssets.js';
import {
    ConnectorReleasePlatform,
    ConnectorReleaseFile,
    type ConnectorReleaseArtifact,
} from '../src/install/ConnectorRelease.js';
import {
    ConnectorPrivateDirectory,
    ConnectorDirectoryPurpose,
} from '../src/runtime/ConnectorPrivateDirectory.js';
import { WindowsStateOwner } from '../src/windows/WindowsStateOwner.js';
import {
    WindowsStateOperation,
    type WindowsStateParameters,
    type WindowsStateResponse,
} from '../src/windows/WindowsStateProtocol.js';

/** Portable pinning fixtures are deliberately not runnable Windows executables or DACL qualification. */
async function helperPins(directory: string): Promise<void> {
    for (const stem of ['nerva-connector-state', 'nerva-connector-host']) {
        const bytes: Buffer = Buffer.alloc(512, 0x41);
        bytes[0] = 0x4d;
        bytes[1] = 0x5a;
        await writeFile(join(directory, stem + '.exe'), bytes, { mode: 0o700 });
        await writeFile(
            join(directory, stem + '.json'),
            JSON.stringify({
                bytes: bytes.length,
                sha256: createHash('sha256').update(bytes).digest('hex'),
                sourceSha256: 'a'.repeat(64),
            }),
            { mode: 0o600 },
        );
    }
}

/** Only an ephemeral fixture identity is used to exercise private-key inode exclusions. */
async function signingFile(fixture: ConnectorReleaseFixture): Promise<string> {
    const path: string = join(fixture.directory, 'private-key.fixture');
    const bytes: Buffer = fixture.key.encode();
    try {
        await writeFile(path, bytes, { mode: 0o600 });
    } finally {
        bytes.fill(0);
    }
    return path;
}

/** Windows fixed-file layout is inspected through real bounded POSIX descriptor readers here, never executed. */
function options(fixture: ConnectorReleaseFixture, key: string): ConnectorReleaseSourceOptions {
    const directory: string = join(fixture.directory, 'assets');
    return {
        platform: ConnectorReleasePlatform.Windows,
        directory,
        runtimeFile: join(directory, 'node.exe'),
        licenseFile: join(directory, 'NODE-LICENSE'),
        privateKeyFile: key,
    };
}

it.skipIf(process.platform !== 'linux')(
    'complete source plans promote exact bytes, retain valid published assets on source mutation and never copy same-path inputs',
    async (): Promise<void> => {
        await using fixture: ConnectorReleaseFixture = await ConnectorReleaseFixture.create(
            false,
            undefined,
            ConnectorReleasePlatform.Windows,
        );
        await helperPins(join(fixture.directory, 'assets'));
        const key: string = await signingFile(fixture);
        const source: ConnectorReleaseSourceOptions = options(fixture, key);
        const directory: string = join(fixture.directory, 'publisher');
        await mkdir(directory, { mode: 0o700 });
        const plan: ConnectorReleaseSources = await ConnectorReleaseSources.read(
            source,
            new AbortController().signal,
        );
        expect(plan.artifacts.map((artifact): ConnectorReleaseFile => artifact.name)).toEqual(
            ConnectorReleaseAssets.names(ConnectorReleasePlatform.Windows),
        );
        await using owner: ConnectorPrivateDirectory = await ConnectorPrivateDirectory.open(
            directory,
            ConnectorDirectoryPurpose.Installation,
        );
        await plan.promote(owner, new AbortController().signal);
        const names: readonly string[] = (await readdir(directory)).toSorted();
        expect(names).toEqual(
            [...ConnectorReleaseAssets.names(ConnectorReleasePlatform.Windows)].toSorted(),
        );
        for (const artifact of plan.artifacts) {
            expect(await readFile(join(directory, artifact.name))).toEqual(
                await readFile(join(source.directory, artifact.name)),
            );
        }
        const same: ConnectorReleaseSources = await ConnectorReleaseSources.read(
            {
                ...source,
                directory,
                runtimeFile: join(directory, 'node.exe'),
                licenseFile: join(directory, 'NODE-LICENSE'),
            },
            new AbortController().signal,
        );
        const install: MockInstance<typeof ConnectorReleaseArtifacts.install> = vi.spyOn(
            ConnectorReleaseArtifacts,
            'install',
        );
        try {
            await same.promote(owner, new AbortController().signal);
            expect(install).not.toHaveBeenCalled();
            const original: Buffer = await readFile(join(directory, 'nerva-connector.mjs'));
            await writeFile(
                join(source.directory, 'nerva-connector.mjs'),
                Buffer.alloc(original.length, 0x42),
            );
            await expect(plan.promote(owner, new AbortController().signal)).rejects.toThrow(
                'digest changed',
            );
            expect(await readFile(join(directory, 'nerva-connector.mjs'))).toEqual(original);
            expect((await readdir(directory)).toSorted()).toEqual(names);
        } finally {
            install.mockRestore();
        }
    },
);

it.skipIf(process.platform !== 'linux')(
    'missing late assets, private-key path/inode aliases and mismatched helper pins never produce a promotion plan',
    async (): Promise<void> => {
        await using fixture: ConnectorReleaseFixture = await ConnectorReleaseFixture.create(
            false,
            undefined,
            ConnectorReleasePlatform.Windows,
        );
        const directory: string = join(fixture.directory, 'assets');
        await helperPins(directory);
        const key: string = await signingFile(fixture);
        const source: ConnectorReleaseSourceOptions = options(fixture, key);
        const install: MockInstance<typeof ConnectorReleaseArtifacts.install> = vi.spyOn(
            ConnectorReleaseArtifacts,
            'install',
        );
        try {
            await expect(
                ConnectorReleaseSources.read(
                    { ...source, runtimeFile: key },
                    new AbortController().signal,
                ),
            ).rejects.toThrow('private signing key');
            const license: string = join(directory, 'NODE-LICENSE');
            const original: Buffer = await readFile(license);
            await rm(license);
            await link(key, license);
            await expect(
                ConnectorReleaseSources.read(source, new AbortController().signal),
            ).rejects.toThrow('private signing key');
            await rm(license);
            await writeFile(license, original, { mode: 0o600 });
            const worker: string = join(directory, 'nerva-connector-host-worker.mjs');
            const bytes: Buffer = await readFile(worker);
            await rm(worker);
            await expect(
                ConnectorReleaseSources.read(source, new AbortController().signal),
            ).rejects.toThrow();
            await writeFile(worker, bytes, { mode: 0o700 });
            await writeFile(join(directory, 'nerva-connector-host.exe'), Buffer.alloc(512, 0x42));
            await expect(
                ConnectorReleaseSources.read(source, new AbortController().signal),
            ).rejects.toThrow('Compiled Windows helper');
            expect(install).not.toHaveBeenCalled();
            expect(await readdir(fixture.directory)).not.toContain('publisher');
        } finally {
            install.mockRestore();
        }
    },
);

it.skipIf(process.platform !== 'linux')(
    'validated promotion uses native bounded artifact requests rather than sending executable bodies through private-state writes',
    async (): Promise<void> => {
        await using fixture: ConnectorReleaseFixture = await ConnectorReleaseFixture.create(
            false,
            undefined,
            ConnectorReleasePlatform.Windows,
        );
        await helperPins(join(fixture.directory, 'assets'));
        const plan: ConnectorReleaseSources = await ConnectorReleaseSources.read(
            options(fixture, await signingFile(fixture)),
            new AbortController().signal,
        );
        const descriptor: PropertyDescriptor | undefined = Object.getOwnPropertyDescriptor(
            process,
            'platform',
        );
        if (descriptor === undefined) {
            throw new Error('Platform descriptor unavailable');
        }
        const operations: WindowsStateOperation[] = [];
        const response: WindowsStateResponse = {
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
        };
        const request: MockInstance<typeof WindowsStateOwner.request> = vi.spyOn(
            WindowsStateOwner,
            'request',
        );
        request.mockImplementation(
            (
                operation: WindowsStateOperation,
                parameters: WindowsStateParameters = {},
            ): Promise<WindowsStateResponse> => {
                operations.push(operation);
                if (operation === WindowsStateOperation.Open) {
                    return Promise.resolve({ ...response, lease: 'test-private-lease' });
                }
                if (operation === WindowsStateOperation.Close) {
                    return Promise.resolve(response);
                }
                if (operation === WindowsStateOperation.ArtifactInstall) {
                    const artifact: ConnectorReleaseArtifact | undefined = plan.artifacts.find(
                        (entry: ConnectorReleaseArtifact): boolean =>
                            entry.name === parameters.name,
                    );
                    if (artifact === undefined) {
                        return Promise.reject(new Error('Unexpected artifact'));
                    }
                    expect(parameters).toMatchObject({
                        path: plan.source(artifact.name),
                        lease: 'test-private-lease',
                        name: artifact.name,
                        sizeBytes: artifact.sizeBytes,
                        sha256: artifact.sha256,
                        replace: true,
                    });
                    expect(parameters.dataBase64).toBeUndefined();
                    return Promise.resolve({
                        ...response,
                        sizeBytes: artifact.sizeBytes,
                        sha256: artifact.sha256,
                    });
                }
                return Promise.reject(new Error('Unexpected native promotion operation'));
            },
        );
        try {
            Object.defineProperty(process, 'platform', { value: 'win32' });
            await using owner: ConnectorPrivateDirectory = await ConnectorPrivateDirectory.open(
                join(fixture.directory, 'publisher'),
                ConnectorDirectoryPurpose.Installation,
            );
            await plan.promote(owner, new AbortController().signal);
        } finally {
            Object.defineProperty(process, 'platform', descriptor);
            request.mockRestore();
        }
        expect(operations).toEqual([
            WindowsStateOperation.Open,
            ...Array.from<undefined, WindowsStateOperation>(
                { length: 9 },
                (_value: undefined): WindowsStateOperation => WindowsStateOperation.ArtifactInstall,
            ),
            WindowsStateOperation.Close,
        ]);
    },
);

it.skipIf(process.platform !== 'linux')(
    'bootstrap compiler output paths and inode aliases cannot replace an ephemeral signing key',
    async (): Promise<void> => {
        await using fixture: ConnectorReleaseFixture = await ConnectorReleaseFixture.create();
        const key: string = await signingFile(fixture);
        const directory: string = join(fixture.directory, 'build');
        await mkdir(directory, { mode: 0o700 });
        const original: Buffer = await readFile(key);
        await link(key, join(directory, 'nerva-connector-bootstrap.exe'));
        await expect(ConnectorReleaseSources.bootstrapDirectory(directory, key)).rejects.toThrow(
            'private signing key',
        );
        await expect(
            ConnectorReleaseSources.bootstrapDirectory(
                directory,
                join(directory, 'nerva-connector-bootstrap.exe'),
            ),
        ).rejects.toThrow('private signing key');
        expect(await readFile(key)).toEqual(original);
        expect(await readdir(directory)).toEqual(['nerva-connector-bootstrap.exe']);
    },
);
