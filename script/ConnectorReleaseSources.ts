// SPDX-FileCopyrightText: 2026 Dacely <business@dacely.com>
// SPDX-License-Identifier: LicenseRef-Proprietary

import { lstat } from 'node:fs/promises';
import type { BigIntStats } from 'node:fs';
import { join, resolve, relative, isAbsolute, sep } from 'node:path';
import { ProtectedFiles } from '../src/local/ProtectedFiles.ts';
import { ConnectorReleaseAssets } from '../src/install/ConnectorReleaseAssets.ts';
import { ConnectorReleaseArtifacts } from '../src/install/ConnectorReleaseArtifacts.ts';
import { ConnectorNativeExecutable } from '../src/runtime/ConnectorNativeExecutable.ts';
import {
    ConnectorReleasePlatform,
    ConnectorReleaseFile,
    type ConnectorReleaseArtifact,
} from '../src/install/ConnectorRelease.ts';
import { WindowsStateBuild } from '../src/windows/WindowsStateBuild.ts';
import { WindowsStateArtifactFile } from '../src/windows/WindowsStateArtifactFile.ts';
import { WindowsStateOwner } from '../src/windows/WindowsStateOwner.ts';
import { WindowsStateOperation } from '../src/windows/WindowsStateProtocol.ts';
import type { ConnectorPrivateDirectory } from '../src/runtime/ConnectorPrivateDirectory.ts';

/** Every signed manifest asset retains its exact validated source; filenames never select signing material. */
export interface ConnectorReleaseSource {
    readonly path: string;
    readonly artifact: ConnectorReleaseArtifact;
}

/** Fixed app/helper inputs may be separate from the final native-private publisher directory. */
export interface ConnectorReleaseSourceOptions {
    readonly platform: ConnectorReleasePlatform;
    readonly directory: string;
    readonly runtimeFile: string;
    readonly licenseFile: string;
    readonly privateKeyFile: string;
}

/** Complete source validation precedes any protected publisher mutation. */
export class ConnectorReleaseSources {
    readonly #sources: readonly ConnectorReleaseSource[];

    /** Only complete validated plans can promote; partial caller-supplied arrays are never an admission API. */
    private constructor(sources: readonly ConnectorReleaseSource[]) {
        this.#sources = sources;
    }

    /** Manifest metadata is detached from the retained promotion plan. */
    public get artifacts(): readonly ConnectorReleaseArtifact[] {
        return this.#sources.map((source: ConnectorReleaseSource): ConnectorReleaseArtifact => ({
            ...source.artifact,
        }));
    }

    /** Runtime probing uses the same reviewed source whose full hash is retained by this plan. */
    public source(name: ConnectorReleaseFile): string {
        const source: ConnectorReleaseSource | undefined = this.#sources.find(
            (entry: ConnectorReleaseSource): boolean => entry.artifact.name === name,
        );
        if (source === undefined) {
            throw new Error('Release source is missing');
        }
        return source.path;
    }

    /** Same-path inputs are reverified; copied assets use the existing descriptor-pinned installer. */
    public async promote(owner: ConnectorPrivateDirectory, signal: AbortSignal): Promise<void> {
        for (const source of this.#sources) {
            signal.throwIfAborted();
            if (relative(source.path, join(owner.directory, source.artifact.name)) === '') {
                await ConnectorReleaseArtifacts.verify(owner.directory, source.artifact, signal);
            } else {
                await ConnectorReleaseArtifacts.install(
                    source.path,
                    owner,
                    source.artifact,
                    signal,
                    true,
                );
            }
        }
    }

    /** Hashes the complete fixed source set and checks private-key aliases before returning any promotable plan. */
    public static async read(
        options: ConnectorReleaseSourceOptions,
        signal: AbortSignal,
    ): Promise<ConnectorReleaseSources> {
        const directory: string = this.#canonical(options.directory);
        const key: string = this.#canonical(options.privateKeyFile);
        const identity: BigIntStats = await lstat(key, { bigint: true });
        const sources: ConnectorReleaseSource[] = [];
        for (const name of ConnectorReleaseAssets.names(options.platform)) {
            signal.throwIfAborted();
            const path: string = this.#canonical(
                name === ConnectorReleaseAssets.runtime(options.platform)
                    ? options.runtimeFile
                    : name === ConnectorReleaseFile.License
                      ? options.licenseFile
                      : join(directory, name),
            );
            await this.#notKey(path, key, identity, false);
            const artifact: ConnectorReleaseArtifact = await ConnectorReleaseArtifacts.describe(
                path,
                name,
                signal,
            );
            if (name === ConnectorReleaseFile.Files || name === ConnectorReleaseFile.Execution) {
                await using verified: AsyncDisposableStack = new AsyncDisposableStack();
                verified.use(await ConnectorNativeExecutable.open(path, artifact.sha256));
            }
            sources.push({ path, artifact });
        }
        if (options.platform === ConnectorReleasePlatform.Windows) {
            for (const stem of ['nerva-connector-state', 'nerva-connector-host']) {
                const metadata: Awaited<ReturnType<typeof WindowsStateBuild.read>> =
                    await WindowsStateBuild.read(join(directory, stem + '.json'));
                if (metadata === null) {
                    throw new Error('Windows release requires pinned compiled helper metadata');
                }
                await WindowsStateArtifactFile.verify(join(directory, stem + '.exe'), metadata);
            }
        }
        return new ConnectorReleaseSources(sources);
    }

    /** Compiler/cache outputs remain outside managed private state and cannot overwrite the offline signing key. */
    public static async bootstrapDirectory(
        directory: string,
        privateKeyFile: string,
        publisher: string | null = null,
    ): Promise<string> {
        const cachedOnly: boolean = publisher !== null && relative(directory, publisher) === '';
        const canonical: string = cachedOnly
            ? this.#canonical(directory)
            : await this.externalBuildDirectory(directory);
        if (cachedOnly) {
            await ProtectedFiles.directory(canonical);
        }
        const key: string = this.#canonical(privateKeyFile);
        const identity: BigIntStats = await lstat(key, { bigint: true });
        for (const name of ['nerva-connector-bootstrap.exe', 'nerva-connector-bootstrap.json']) {
            await this.#notKey(join(canonical, name), key, identity, true);
            await this.#notKey(
                join(canonical, name + '.partial-' + process.pid.toString()),
                key,
                identity,
                true,
            );
        }
        return canonical;
    }

    /** Direct package preparation also keeps compiler writes outside managed private state. */
    public static async externalBuildDirectory(directory: string): Promise<string> {
        const canonical: string = this.#canonical(directory);
        if (process.platform === 'win32') {
            const root: string | null = (
                await WindowsStateOwner.request(WindowsStateOperation.Root)
            ).path;
            if (root === null || this.#inside(root, canonical)) {
                throw new Error(
                    'Bootstrap build outputs require an existing external reviewed build directory',
                );
            }
        }
        await ProtectedFiles.directory(canonical);
        return canonical;
    }

    static #canonical(path: string): string {
        const canonical: string = ProtectedFiles.path(path);
        if (resolve(canonical) !== canonical) {
            throw new Error('Canonical release source paths required');
        }
        return canonical;
    }

    static #inside(directory: string, path: string): boolean {
        const child: string = relative(directory, path);
        return (
            child === '' || (child !== '..' && !child.startsWith('..' + sep) && !isAbsolute(child))
        );
    }

    static async #notKey(
        path: string,
        key: string,
        identity: BigIntStats,
        optional: boolean,
    ): Promise<void> {
        if (path === key) {
            throw new Error('A private signing key is not a release asset or compiler output');
        }
        try {
            const source: BigIntStats = await lstat(path, { bigint: true });
            if (source.dev === identity.dev && source.ino === identity.ino) {
                throw new Error('A private signing key is not a release asset or compiler output');
            }
        } catch (caught: unknown) {
            if (
                !optional ||
                !(caught instanceof Error) ||
                !('code' in caught) ||
                caught.code !== 'ENOENT'
            ) {
                throw caught;
            }
        }
    }
}
