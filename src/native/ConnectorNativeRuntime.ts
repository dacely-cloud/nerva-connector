// SPDX-FileCopyrightText: 2026 Dacely <business@dacely.com>
// SPDX-License-Identifier: LicenseRef-Proprietary

import { chmod, lstat, open, link, rm, opendir, type FileHandle } from 'node:fs/promises';
import { join, dirname, relative } from 'node:path';
import { constants, type Dir, type BigIntStats } from 'node:fs';
import { ProtectedArtifact } from '../local/ProtectedArtifact.js';
import { ProtectedFiles } from '../local/ProtectedFiles.js';
import {
    ConnectorRuntimeFileMode,
    type ConnectorNativeLayout,
    type ConnectorRuntimeFile,
} from './ConnectorNativeTypes.js';

/** Approved public tools are copied individually into one stable readonly tree; no host root, source checkout or cache is cloned. */
export class ConnectorNativeRuntime {
    /** Fresh setup and interrupted copies reuse one intent-owned tree without replacing different final bytes. */
    public static async prepare(
        layout: ConnectorNativeLayout,
        source: string,
        files: readonly ConnectorRuntimeFile[],
        signal: AbortSignal,
    ): Promise<void> {
        await ProtectedFiles.directory(source);
        const directories: ReadonlySet<string> = this.#directories(files);
        for (const path of directories) {
            await ProtectedFiles.createDirectory(join(layout.runtimeDirectory, path));
        }
        for (const file of files) {
            await this.#copy(
                join(source, '.' + file.path),
                join(layout.runtimeDirectory, '.' + file.path),
                file,
                signal,
            );
        }
        for (const name of ['nerva-exec', 'nerva-execution.json']) {
            const path: string = join(layout.runtimeDirectory, name);
            if (!(await this.#exists(path))) {
                const handle: FileHandle = await open(path, 'wx', 0o444);
                try {
                    await handle.sync();
                } finally {
                    await handle.close();
                }
            }
            await this.#placeholder(path);
        }
        await this.#tree(layout.runtimeDirectory, files, false);
        for (const path of [...directories].reverse()) {
            await chmod(join(layout.runtimeDirectory, path), 0o555);
        }
        const directory: FileHandle = await open(
            layout.runtimeDirectory,
            constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
        );
        try {
            await directory.sync();
        } finally {
            await directory.close();
        }
    }
    /** Service boot verifies retained readonly content without needing the original source bundle or recreating missing files. */
    public static async verify(
        layout: ConnectorNativeLayout,
        files: readonly ConnectorRuntimeFile[],
        signal: AbortSignal,
    ): Promise<void> {
        await this.#tree(layout.runtimeDirectory, files, true);
        for (const file of files) {
            await this.#verify(join(layout.runtimeDirectory, '.' + file.path), file, signal);
        }
        for (const name of ['nerva-exec', 'nerva-execution.json']) {
            await this.#placeholder(join(layout.runtimeDirectory, name));
        }
    }
    static async #copy(
        source: string,
        destination: string,
        file: ConnectorRuntimeFile,
        signal: AbortSignal,
    ): Promise<void> {
        const temporary: string = destination + '.partial';
        if (await this.#exists(temporary)) {
            const state: BigIntStats = await lstat(temporary, { bigint: true });
            if (
                !state.isFile() ||
                (state.nlink !== 1n && state.nlink !== 2n) ||
                state.uid !== BigInt(process.getuid?.() ?? -1) ||
                (state.mode & 0o6022n) !== 0n ||
                state.size > file.sizeBytes
            ) {
                throw new Error('Foreign native runtime partial');
            }
            if (state.nlink === 2n) {
                const final: BigIntStats = await lstat(destination, { bigint: true });
                if (final.dev !== state.dev || final.ino !== state.ino || final.nlink !== 2n) {
                    throw new Error('Native runtime partial has a foreign link');
                }
            }
            await rm(temporary);
        }
        if (await this.#exists(destination)) {
            await this.#verify(destination, file, signal);
            return;
        }
        const output: FileHandle = await open(temporary, 'wx', 0o600);
        try {
            if (
                (await ProtectedArtifact.transfer(
                    source,
                    output,
                    {
                        sizeBytes: file.sizeBytes,
                        maximumBytes: 268435456,
                        executable: file.mode === ConnectorRuntimeFileMode.Executable,
                    },
                    signal,
                )) !== file.sha256
            ) {
                throw new Error('Native runtime source digest changed');
            }
            await output.sync();
            await output.chmod(file.mode === ConnectorRuntimeFileMode.Executable ? 0o555 : 0o444);
            await output.close();
            signal.throwIfAborted();
            await link(temporary, destination);
        } finally {
            await output.close();
            await rm(temporary, { force: true });
        }
        const directory: FileHandle = await open(
            dirname(destination),
            constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
        );
        try {
            await directory.sync();
        } finally {
            await directory.close();
        }
    }
    static async #verify(
        path: string,
        file: ConnectorRuntimeFile,
        signal: AbortSignal,
    ): Promise<void> {
        const state: BigIntStats = await lstat(path, { bigint: true });
        if (
            (state.mode & 0o222n) !== 0n ||
            (await ProtectedArtifact.transfer(
                path,
                null,
                {
                    sizeBytes: file.sizeBytes,
                    maximumBytes: 268435456,
                    executable: file.mode === ConnectorRuntimeFileMode.Executable,
                },
                signal,
            )) !== file.sha256
        ) {
            throw new Error('Installed native runtime changed');
        }
    }
    static #directories(files: readonly ConnectorRuntimeFile[]): ReadonlySet<string> {
        const directories: Set<string> = new Set([
            '.',
            'workspace',
            'proc',
            'dev',
            'tmp',
            'nerva-limits',
        ]);
        for (const file of files) {
            let parent: string = dirname(file.path).slice(1);
            const lineage: string[] = [];
            while (parent !== '.' && parent !== '') {
                lineage.push(parent);
                parent = dirname(parent);
            }
            for (const entry of lineage.reverse()) {
                directories.add(entry);
            }
        }
        if (directories.size > 4096) {
            throw new Error('Native runtime directory set exceeds its bound');
        }
        return directories;
    }
    static async #tree(
        root: string,
        files: readonly ConnectorRuntimeFile[],
        readonly: boolean,
    ): Promise<void> {
        const directories: ReadonlySet<string> = this.#directories(files);
        const leaves: ReadonlySet<string> = new Set([
            ...files.map((file): string => file.path.slice(1)),
            'nerva-exec',
            'nerva-execution.json',
        ]);
        for (const path of directories) {
            await ProtectedFiles.directory(join(root, path));
        }
        const pending: string[] = [root];
        let count: number = 0;
        while (pending.length > 0) {
            const path: string | undefined = pending.pop();
            if (path === undefined) {
                throw new Error('Native runtime inventory changed');
            }
            await ProtectedFiles.directory(path);
            if (readonly && ((await lstat(path)).mode & 0o222) !== 0) {
                throw new Error('Writable native runtime directory');
            }
            const directory: Dir = await opendir(path, { bufferSize: 32 });
            for await (const entry of directory) {
                if (++count > 4096) {
                    throw new Error('Native runtime inventory exceeds its bound');
                }
                const child: string = join(path, entry.name);
                const name: string = relative(root, child);
                if (entry.isDirectory() && directories.has(name)) {
                    pending.push(child);
                } else if (!entry.isFile() || !leaves.has(name)) {
                    throw new Error('Unapproved native runtime content');
                }
            }
        }
    }
    static async #placeholder(path: string): Promise<void> {
        const state: BigIntStats = await lstat(path, { bigint: true });
        if (
            !state.isFile() ||
            state.nlink !== 1n ||
            state.size !== 0n ||
            state.uid !== BigInt(process.getuid?.() ?? -1) ||
            (state.mode & 0o222n) !== 0n
        ) {
            throw new Error('Native runtime mount target changed');
        }
    }
    static async #exists(path: string): Promise<boolean> {
        try {
            await lstat(path);
            return true;
        } catch (caught: unknown) {
            if (caught instanceof Error && 'code' in caught && caught.code === 'ENOENT') {
                return false;
            }
            throw caught;
        }
    }
}
