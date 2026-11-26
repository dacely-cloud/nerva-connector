// SPDX-FileCopyrightText: 2026 Dacely <business@dacely.com>
// SPDX-License-Identifier: LicenseRef-Proprietary

import { constants, type BigIntStats } from 'node:fs';
import { lstat, mkdir, open, readdir, type FileHandle } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';

/** Program publication permits macOS's root-owned administrator directories while keeping updater state owner-private. */
export class ConnectorUpdatePaths {
    /** No symlink, traversal, control character or untrusted writable ancestor can select an update destination. */
    public static async directory(path: string, privateOwner: boolean = false): Promise<void> {
        if (
            !isAbsolute(path) ||
            resolve(path) !== path ||
            path.length > 4096 ||
            !path.isWellFormed() ||
            path.includes('\\') ||
            path
                .split('')
                .some(
                    (character: string): boolean =>
                        character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
                )
        ) {
            throw new Error('Updates require a canonical program directory');
        }
        let ancestor: string = path;
        for (let depth: number = 0; depth < 64; depth++) {
            const status: BigIntStats = await lstat(ancestor, { bigint: true });
            const administrator: boolean =
                process.platform === 'darwin' &&
                status.uid === 0n &&
                status.gid === 80n &&
                (status.mode & 0o002n) === 0n;
            if (
                !status.isDirectory() ||
                (status.uid !== 0n && status.uid !== BigInt(process.getuid?.() ?? -1)) ||
                ((status.mode & 0o022n) !== 0n && !administrator)
            ) {
                throw new Error('Update directory ancestry is untrusted');
            }
            if (
                ancestor === path &&
                privateOwner &&
                (status.uid !== BigInt(process.getuid?.() ?? -1) || (status.mode & 0o077n) !== 0n)
            ) {
                throw new Error('Updater state must be owner-private');
            }
            const parent: string = dirname(ancestor);
            if (parent === ancestor) {
                return;
            }
            ancestor = parent;
        }
        throw new Error('Update directory ancestry is too deep');
    }

    /** Creates only missing private ancestors and never repairs an existing path's permissions. */
    public static async create(path: string, privateOwner: boolean = true): Promise<void> {
        try {
            await this.directory(path, privateOwner);
            return;
        } catch (caught: unknown) {
            if (!(caught instanceof Error) || !('code' in caught) || caught.code !== 'ENOENT') {
                throw caught;
            }
        }
        const parent: string = dirname(path);
        try {
            await this.directory(parent);
        } catch (caught: unknown) {
            if (!(caught instanceof Error) || !('code' in caught) || caught.code !== 'ENOENT') {
                throw caught;
            }
            await this.create(parent, false);
        }
        await mkdir(path, { mode: privateOwner ? 0o700 : 0o755 });
        await this.directory(path, privateOwner);
    }

    /** Bounded descriptor reads reject executable substitutions through symlink leaves or unsafe ownership. */
    public static async read(path: string, maximum: number): Promise<Buffer> {
        await this.directory(dirname(path));
        const file: FileHandle = await open(
            path,
            constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
        );
        try {
            const before: BigIntStats = await file.stat({ bigint: true });
            if (
                !before.isFile() ||
                before.size > BigInt(maximum) ||
                (before.mode & 0o022n) !== 0n ||
                (before.uid !== 0n && before.uid !== BigInt(process.getuid?.() ?? -1))
            ) {
                throw new Error('Update program file is untrusted or oversized');
            }
            const buffer: Buffer = Buffer.alloc(Number(before.size) + 1);
            let size: number = 0;
            while (size <= maximum) {
                const result: Awaited<ReturnType<FileHandle['read']>> = await file.read(
                    buffer,
                    size,
                    buffer.length - size,
                    null,
                );
                if (result.bytesRead === 0) {
                    break;
                }
                size += result.bytesRead;
            }
            const after: BigIntStats = await file.stat({ bigint: true });
            if (
                size > maximum ||
                BigInt(size) !== before.size ||
                before.size !== after.size ||
                before.mtimeNs !== after.mtimeNs ||
                before.ctimeNs !== after.ctimeNs
            ) {
                throw new Error('Update program file changed while reading');
            }
            return buffer.subarray(0, size);
        } finally {
            await file.close();
        }
    }

    /** A staged tree is finite, contains only regular files/directories, and is durable before an atomic exchange. */
    public static async tree(directory: string, synchronize: boolean = true): Promise<void> {
        const pending: string[] = [directory];
        let entries: number = 0;
        let bytes: bigint = 0n;
        while (pending.length !== 0) {
            const path: string | undefined = pending.pop();
            if (path === undefined) {
                throw new Error('Missing update tree entry');
            }
            const status: BigIntStats = await lstat(path, { bigint: true });
            if (
                ++entries > 256 ||
                (status.mode & 0o022n) !== 0n ||
                (synchronize &&
                    status.uid !== 0n &&
                    status.uid !== BigInt(process.getuid?.() ?? -1))
            ) {
                throw new Error(
                    'Update application tree exceeds its bound or has unsafe permissions',
                );
            }
            if (status.isDirectory()) {
                const names: readonly string[] = await readdir(path);
                if (names.length + entries + pending.length > 256) {
                    throw new Error('Update application has too many files');
                }
                pending.push(...names.map((name: string): string => join(path, name)));
            } else if (status.isFile()) {
                bytes += status.size;
                if (bytes > 402653184n) {
                    throw new Error('Expanded update application is too large');
                }
                if (!synchronize) {
                    continue;
                }
                const file: FileHandle = await open(
                    path,
                    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
                );
                try {
                    await file.sync();
                } finally {
                    await file.close();
                }
            } else {
                throw new Error('Update application contains a symlink or special file');
            }
        }
    }

    /** Presence checks distinguish a missing leaf from an unsafe or inaccessible object. */
    public static async exists(path: string): Promise<boolean> {
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
