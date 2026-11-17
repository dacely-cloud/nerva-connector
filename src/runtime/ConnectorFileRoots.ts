// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

import { constants, type BigIntStats } from 'node:fs';
import { open, type FileHandle } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { Boundary } from 'nerva-connector-protocol/protocol/Boundary.js';
import { ConnectorFileMode } from 'nerva-connector-protocol/protocol/ConnectorFiles.js';
import { ProtectedFiles } from '../local/ProtectedFiles.js';

/** Paths stay local; only opaque root IDs and a full policy commitment are published. */
export interface ConnectorFileRootPolicy {
    readonly id: string;
    readonly path: string;
    readonly stagingPath: string | null;
}
/** Each retained capability separates customer data from private write staging. */
export interface ConnectorFileRootCapability {
    readonly directory: FileHandle;
    readonly staging: FileHandle | null;
}

/** Owns pinned directory capabilities before native children can observe any remote input. */
export class ConnectorFileRoots implements AsyncDisposable {
    readonly #handles: readonly FileHandle[];
    private constructor(
        public readonly policies: readonly ConnectorFileRootPolicy[],
        public readonly capabilities: ReadonlyMap<string, ConnectorFileRootCapability>,
        handles: readonly FileHandle[],
    ) {
        this.#handles = [...handles];
    }

    /** Parse one exact local root contract before resource acquisition or cross-policy protection. */
    public static parse(raw: unknown, mode: ConnectorFileMode): readonly ConnectorFileRootPolicy[] {
        const policies: readonly ConnectorFileRootPolicy[] = Boundary.array(raw, 16).map(
            (entry: unknown): ConnectorFileRootPolicy => {
                const value: Readonly<Record<string, unknown>> = Boundary.record(
                    entry,
                    mode === ConnectorFileMode.ReadWrite
                        ? ['id', 'path', 'stagingPath']
                        : ['id', 'path'],
                );
                const path: string = this.#path(value['path']);
                const stagingPath: string | null =
                    mode === ConnectorFileMode.ReadWrite ? this.#path(value['stagingPath']) : null;
                return { id: Boundary.id(value['id']), path, stagingPath };
            },
        );
        const stages: readonly string[] = policies.flatMap(
            (root: ConnectorFileRootPolicy): string[] =>
                root.stagingPath === null ? [] : [root.stagingPath],
        );
        if (
            policies.length === 0 ||
            new Set(policies.map((root: ConnectorFileRootPolicy): string => root.id)).size !==
                policies.length ||
            new Set(policies.map((root: ConnectorFileRootPolicy): string => root.path)).size !==
                policies.length ||
            new Set(stages).size !== stages.length ||
            stages.some((stage: string): boolean =>
                policies.some(
                    (root: ConnectorFileRootPolicy): boolean =>
                        stage === root.path ||
                        stage.startsWith(root.path + '/') ||
                        root.path.startsWith(stage + '/'),
                ),
            )
        ) {
            throw new Error('Explicit independent connector directory capabilities required');
        }
        return policies;
    }

    /** Unknown caller data is parsed once and then opened under the current private-path exclusions. */
    public static async load(
        raw: unknown,
        mode: ConnectorFileMode,
        privatePaths: readonly string[],
    ): Promise<ConnectorFileRoots> {
        return await this.open(this.parse(raw, mode), privatePaths);
    }

    /** Staging must be private, independent of every parsed root and secret, and on that root's filesystem. */
    public static async open(
        policies: readonly ConnectorFileRootPolicy[],
        privatePaths: readonly string[],
    ): Promise<ConnectorFileRoots> {
        const protectedPaths: readonly string[] = privatePaths.map((value: string): string => {
            const path: string = ProtectedFiles.path(value);
            if (resolve(path) !== path || path === '/') {
                throw new Error('Canonical specific protected connector references required');
            }
            return path;
        });
        for (const root of policies) {
            const stagingPath: string | null = root.stagingPath;
            if (
                protectedPaths.some(
                    (secret: string): boolean =>
                        secret === root.path ||
                        secret.startsWith(root.path + '/') ||
                        root.path.startsWith(secret + '/'),
                )
            ) {
                throw new Error('Connector file root overlaps protected configuration or identity');
            }
            if (
                stagingPath !== null &&
                protectedPaths.some(
                    (secret: string): boolean =>
                        secret === stagingPath ||
                        secret.startsWith(stagingPath + '/') ||
                        stagingPath.startsWith(secret + '/'),
                )
            ) {
                throw new Error('Connector write staging overlaps protected authority');
            }
        }
        const handles: FileHandle[] = [];
        try {
            const capabilities: Map<string, ConnectorFileRootCapability> = new Map();
            for (const root of policies) {
                const directory: FileHandle = await this.#open(root.path);
                handles.push(directory);
                let staging: FileHandle | null = null;
                if (root.stagingPath !== null) {
                    staging = await this.#open(root.stagingPath);
                    handles.push(staging);
                    const staged: BigIntStats = await staging.stat({ bigint: true });
                    const selected: BigIntStats = await directory.stat({ bigint: true });
                    if (
                        (staged.mode & 0o077n) !== 0n ||
                        staged.uid !== BigInt(process.getuid?.() ?? -1) ||
                        staged.dev !== selected.dev ||
                        staged.ino === selected.ino
                    ) {
                        throw new Error('Private same-filesystem write staging is unavailable');
                    }
                }
                capabilities.set(root.id, { directory, staging });
            }
            return new ConnectorFileRoots(policies, capabilities, handles);
        } catch (caught: unknown) {
            await Promise.allSettled(
                handles.map((handle: FileHandle): Promise<void> => handle.close()),
            );
            throw caught;
        }
    }

    /** Children must be joined by the surrounding filesystem owner before capabilities are released. */
    public async [Symbol.asyncDispose](): Promise<void> {
        await Promise.allSettled(
            this.#handles.map((handle: FileHandle): Promise<void> => handle.close()),
        );
    }
    static #path(raw: unknown): string {
        const path: string = ProtectedFiles.path(raw);
        if (resolve(path) !== path || path.endsWith('/')) {
            throw new Error('Canonical connector directory references required');
        }
        return path;
    }
    static async #open(path: string): Promise<FileHandle> {
        await ProtectedFiles.directory(dirname(path));
        const handle: FileHandle = await open(
            path,
            constants.O_RDONLY |
                constants.O_DIRECTORY |
                constants.O_NOFOLLOW |
                constants.O_NONBLOCK,
        );
        try {
            if (!(await handle.stat()).isDirectory()) {
                throw new Error('Connector capability is not a directory');
            }
            return handle;
        } catch (caught: unknown) {
            await handle.close();
            throw caught;
        }
    }
}
