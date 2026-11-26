// SPDX-FileCopyrightText: 2026 Dacely <business@dacely.com>
// SPDX-License-Identifier: LicenseRef-Proprietary

import { constants, type Dirent, type BigIntStats, type Dir } from 'node:fs';
import {
    lstat,
    mkdir,
    open,
    opendir,
    rm,
    rename,
    chmod,
    link,
    unlink,
    stat,
    type FileHandle,
} from 'node:fs/promises';
import { ConnectorHostErrorCode } from 'nerva-connector-protocol/protocol/ConnectorHost.js';
import { HostOperationError } from './HostOperationError.js';
import { HostFileIdentity } from './HostFileIdentity.js';
import { HostFileSnapshotCodec } from './HostFileSnapshotCodec.js';
import { HostWorkspaceValidation } from './HostWorkspaceValidation.js';
import {
    HostFileKind,
    HostWriteMode,
    HostWorkspaceLimits,
    type HostFileRead,
    type HostFileSnapshot,
    type HostFileMetadata,
    type HostDirectoryEntry,
    type HostDirectoryPage,
} from './HostWorkspaceTypes.js';

/** Bounded write metadata from the native file descriptor. */
interface HostWriteResult {
    readonly bytesWritten: number;
}

/** Portable host file operations use the user's existing OS permissions, without confined-root guarantees. */
export class HostFilesystem {
    /** Regular-file reads are bounded and preserve exact metadata; special files cannot block this operation. */
    public static async read(
        path: string,
        offset: bigint,
        maximum: number,
        snapshot?: HostFileSnapshot,
        signal?: AbortSignal,
    ): Promise<HostFileRead> {
        signal?.throwIfAborted();
        if (snapshot !== undefined) {
            HostFileSnapshotCodec.validate(snapshot);
        }
        const position: number = HostWorkspaceValidation.offset(offset);
        HostWorkspaceValidation.count(maximum, 1, HostWorkspaceLimits.chunkBytes);
        const handle: FileHandle = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
        try {
            const metadata: BigIntStats = await handle.stat({ bigint: true });
            if (!metadata.isFile()) {
                throw new Error('Host file reads require a regular file');
            }
            signal?.throwIfAborted();
            if (snapshot !== undefined) {
                HostFileSnapshotCodec.assert(metadata, snapshot);
            }
            const bytes: Buffer = Buffer.alloc(maximum);
            const result: Awaited<ReturnType<FileHandle['read']>> = await handle.read(
                bytes,
                0,
                maximum,
                position,
            );
            signal?.throwIfAborted();
            if (snapshot !== undefined) {
                HostFileSnapshotCodec.assert(await handle.stat({ bigint: true }), snapshot);
            }
            signal?.throwIfAborted();
            const nextOffset: bigint = offset + BigInt(result.bytesRead);
            return {
                offset,
                nextOffset,
                size: metadata.size,
                eof: nextOffset >= metadata.size,
                bytes: bytes.subarray(0, result.bytesRead),
            };
        } finally {
            await handle.close();
        }
    }

    /** Opens a new regular-file destination without overwriting a name reserved by another operation. */
    public static async openExclusive(path: string): Promise<FileHandle> {
        try {
            return await open(
                path,
                constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NONBLOCK,
                0o600,
            );
        } catch (cause: unknown) {
            if (this.#alreadyExists(cause)) {
                throw new HostOperationError(
                    ConnectorHostErrorCode.AlreadyExists,
                    'Host file already exists before exclusive creation',
                    true,
                    { cause },
                );
            }
            throw cause;
        }
    }

    /** Writes distinguish exclusive creation, truncation, in-place updates and atomic OS append positioning. */
    public static async write(
        path: string,
        bytes: Buffer,
        mode: HostWriteMode,
        offset: bigint,
    ): Promise<bigint> {
        const position: number = HostWorkspaceValidation.offset(offset);
        if (
            !Buffer.isBuffer(bytes) ||
            offset + BigInt(bytes.length) > BigInt(Number.MAX_SAFE_INTEGER) ||
            bytes.length > HostWorkspaceLimits.chunkBytes ||
            !Object.values(HostWriteMode).includes(mode) ||
            (mode !== HostWriteMode.Update && offset !== 0n)
        ) {
            throw new Error('Invalid host file write');
        }
        const flags: number =
            mode === HostWriteMode.Replace
                ? constants.O_WRONLY | constants.O_CREAT
                : mode === HostWriteMode.Append
                  ? constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND
                  : constants.O_WRONLY;
        const handle: FileHandle =
            mode === HostWriteMode.Create
                ? await this.openExclusive(path)
                : await open(path, flags | constants.O_NONBLOCK, 0o600);
        try {
            if (!(await handle.stat()).isFile()) {
                throw new Error('Host file writes require a regular file');
            }
            if (mode === HostWriteMode.Replace) {
                await handle.truncate(0);
            }
            let written: number = 0;
            while (written < bytes.length) {
                const result: HostWriteResult = await handle.write(
                    bytes,
                    written,
                    bytes.length - written,
                    mode === HostWriteMode.Append ? null : position + written,
                );
                if (result.bytesWritten === 0) {
                    throw new Error('Host file write made no progress');
                }
                written += result.bytesWritten;
            }
            await handle.sync();
            return BigInt(written);
        } finally {
            await handle.close();
        }
    }

    /** A hard link atomically publishes a regular file without overwriting an existing destination, then removes its original name. */
    public static async publish(source: string, destination: string): Promise<void> {
        let published: boolean = false;
        try {
            const named: BigIntStats = await lstat(source, { bigint: true });
            if (!named.isFile()) {
                throw new Error('Host publication requires a regular non-symlink source');
            }
            const file: FileHandle = await open(
                source,
                constants.O_RDONLY |
                    constants.O_NONBLOCK |
                    (process.platform === 'win32' ? 0 : constants.O_NOFOLLOW),
            );
            try {
                const opened: BigIntStats = await file.stat({ bigint: true });
                if (!opened.isFile() || named.dev !== opened.dev || named.ino !== opened.ino) {
                    throw new Error('Host publication source changed before admission');
                }
                try {
                    await link(source, destination);
                } catch (caught: unknown) {
                    if (this.#alreadyExists(caught)) {
                        throw new HostOperationError(
                            ConnectorHostErrorCode.AlreadyExists,
                            'Host publication destination already exists',
                            true,
                            { cause: caught },
                        );
                    }
                    throw caught;
                }
                published = true;
                const installed: BigIntStats = await lstat(destination, { bigint: true });
                const current: BigIntStats = await lstat(source, { bigint: true });
                if (
                    !installed.isFile() ||
                    !current.isFile() ||
                    installed.dev !== opened.dev ||
                    installed.ino !== opened.ino ||
                    current.dev !== opened.dev ||
                    current.ino !== opened.ino
                ) {
                    throw new Error('Host publication source identity changed');
                }
                await unlink(source);
            } finally {
                await file.close();
            }
        } catch (caught: unknown) {
            if (published) {
                throw new Error(
                    'Host destination publication may have completed; original source cleanup is unconfirmed. Inspect both paths before any retry.',
                    { cause: caught },
                );
            }
            throw caught;
        }
    }

    /** OS-native rename can atomically replace an existing destination on the same filesystem; no copy/delete fallback is attempted. */
    public static async rename(source: string, destination: string): Promise<void> {
        await rename(source, destination);
    }

    /** POSIX permission bits are exact; Windows DACLs require a distinct native access-control operation. */
    public static async chmod(path: string, mode: number): Promise<void> {
        HostWorkspaceValidation.count(mode, 0, 0o7777);
        if (process.platform === 'win32') {
            throw new Error(
                'POSIX chmod is unsupported on Windows; Windows permissions require explicit DACL operations',
            );
        }
        await chmod(path, mode);
    }

    /** Link metadata remains explicit; paths resolve according to ordinary host filesystem semantics. */
    public static async stat(path: string, follow: boolean = false): Promise<HostFileMetadata> {
        if (typeof follow !== 'boolean') {
            throw new Error('Host stat requires explicit boolean link-following intent');
        }
        const metadata: BigIntStats = follow
            ? await stat(path, { bigint: true })
            : await lstat(path, { bigint: true });
        return {
            identity: HostFileIdentity.from(metadata),
            kind: this.#kind(metadata),
            size: metadata.size,
            modifiedAtNs: metadata.mtimeNs,
            mode: Number(metadata.mode & 0o7777n),
        };
    }

    /** Streaming enumeration retains at most the requested page, including on very large directories. */
    public static async list(
        path: string,
        offset: number,
        maximum: number,
    ): Promise<HostDirectoryPage> {
        HostWorkspaceValidation.count(offset, 0, 1000000);
        HostWorkspaceValidation.count(maximum, 1, HostWorkspaceLimits.directoryEntries);
        const directory: Dir = await opendir(path);
        const entries: HostDirectoryEntry[] = [];
        try {
            let index: number = 0;
            while (true) {
                const entry: Dirent | null = await directory.read();
                if (entry === null) {
                    return { entries, nextOffset: null };
                }
                if (index >= offset) {
                    if (entries.length === maximum) {
                        return { entries, nextOffset: index };
                    }
                    entries.push({ name: entry.name, kind: this.#kind(entry) });
                }
                index += 1;
            }
        } finally {
            await directory.close();
        }
    }

    /** Recursive behavior is always explicit at the operation boundary. */
    public static async mkdir(path: string, recursive: boolean): Promise<void> {
        if (typeof recursive !== 'boolean') {
            throw new Error('Host directory creation requires an explicit recursive flag');
        }
        await mkdir(path, { recursive });
    }

    /** Normal host removal preserves OS errors and requires explicit recursive intent. */
    public static async remove(path: string, recursive: boolean): Promise<void> {
        if (typeof recursive !== 'boolean') {
            throw new Error('Host removal requires an explicit recursive flag');
        }
        await rm(path, { recursive, force: false, maxRetries: 0 });
    }

    static #alreadyExists(caught: unknown): boolean {
        return caught instanceof Error && 'code' in caught && caught.code === 'EEXIST';
    }

    static #kind(metadata: BigIntStats | Dirent): HostFileKind {
        return metadata.isSymbolicLink()
            ? HostFileKind.Symlink
            : metadata.isDirectory()
              ? HostFileKind.Directory
              : metadata.isFile()
                ? HostFileKind.File
                : HostFileKind.Other;
    }
}
