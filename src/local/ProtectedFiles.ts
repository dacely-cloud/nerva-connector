// SPDX-FileCopyrightText: 2026 Dacely <business@dacely.com>
// SPDX-License-Identifier: LicenseRef-Proprietary

import { constants } from 'node:fs';
import { open, lstat, mkdir, readdir, type FileHandle } from 'node:fs/promises';
import { isAbsolute, dirname, resolve, basename } from 'node:path';
import { ProtectedFileLimits } from './ProtectedFileLimits.js';
import type { BigIntStats } from 'node:fs';
import { WindowsStateOwner } from '../windows/WindowsStateOwner.js';
import {
    WindowsStateOperation,
    WindowsStatePurpose,
    WindowsStateError,
    WindowsStateFailure,
    type WindowsStateResponse,
} from '../windows/WindowsStateProtocol.js';

/** Validates administrator-controlled local paths and bounds protected configuration and identity reads. */
export class ProtectedFiles {
    /** Explicit local installers create private canonical directories beneath trusted ancestry; existing permissions are never repaired. */
    public static async createDirectory(path: string): Promise<void> {
        if (process.platform === 'win32') {
            await WindowsStateOwner.request(WindowsStateOperation.Directory, {
                path: this.path(path),
                initialize: true,
            });
            return;
        }
        if (resolve(this.path(path)) !== path) {
            throw new Error('Canonical installation directory required');
        }
        try {
            await this.directory(path);
            return;
        } catch (caught: unknown) {
            if (!(caught instanceof Error) || !('code' in caught) || caught.code !== 'ENOENT') {
                throw caught;
            }
        }
        await this.createDirectory(dirname(path));
        try {
            await mkdir(path, { mode: 0o700 });
        } catch (caught: unknown) {
            if (!(caught instanceof Error) || !('code' in caught) || caught.code !== 'EEXIST') {
                throw caught;
            }
        }
        await this.directory(path);
    }
    /** Private connector registries and keyrings also require canonical, non-writable, non-symlink ancestry. */
    public static async readPrivate(path: string, maximumBytes: number): Promise<Buffer> {
        return await this.readTrusted(path, maximumBytes, true);
    }
    /** Non-secret build metadata still requires trusted ancestry and protected ownership before signing. */
    public static async readTrusted(
        path: string,
        maximumBytes: number,
        secret: boolean,
    ): Promise<Buffer> {
        const absolute: string = resolve(ProtectedFiles.path(path));
        if (absolute !== path) {
            throw new Error('Canonical connector file references are required');
        }
        await this.directory(dirname(absolute));
        return await ProtectedFiles.read(absolute, maximumBytes, secret);
    }
    /** Validates an existing canonical directory and all parents without creating or relaxing their permissions. */
    public static async directory(path: string): Promise<void> {
        if (process.platform === 'win32') {
            await WindowsStateOwner.request(WindowsStateOperation.Directory, {
                path: this.path(path),
                initialize: false,
            });
            return;
        }
        const absolute: string = resolve(ProtectedFiles.path(path));
        if (absolute !== path) {
            throw new Error('Canonical connector directory references are required');
        }
        let parent: string = absolute;
        while (true) {
            const status: BigIntStats = await lstat(parent, { bigint: true });
            if (
                !status.isDirectory() ||
                (status.mode & 0o022n) !== 0n ||
                (status.uid !== 0n && status.uid !== BigInt(process.getuid?.() ?? -1))
            ) {
                throw new Error('Private connector file ancestry is untrusted');
            }
            const next: string = dirname(parent);
            if (next === parent) {
                break;
            }
            parent = next;
        }
    }
    /** Reads one bounded UTF-8 credential value from a protected connector file. */
    public static async secret(path: string | null): Promise<string | null> {
        if (path === null) {
            return null;
        }
        const value: string = new TextDecoder('utf-8', { fatal: true })
            .decode(await ProtectedFiles.read(path, 8192, true))
            .replace(/\r?\n$/u, '');
        if (value.length === 0 || /[\r\n\0]/u.test(value)) {
            throw new Error('Invalid protected credential value');
        }
        return value;
    }
    public static path(value: unknown): string {
        if (
            typeof value !== 'string' ||
            !value.isWellFormed() ||
            value.length > 4096 ||
            !isAbsolute(value) ||
            value.split('').some((character: string): boolean => character.charCodeAt(0) < 32)
        ) {
            throw new Error('An absolute protected file reference is required');
        }
        return value;
    }

    /** Refuse symlink leaves, unsafe ownership/permissions and non-files; bound reads despite concurrent replacement. */
    public static async read(path: string, maximumBytes: number, secret: boolean): Promise<Buffer> {
        ProtectedFiles.path(path);
        const limit: number =
            process.platform === 'win32'
                ? ProtectedFileLimits.ordinaryBytes
                : ProtectedFileLimits.maximum(basename(path));
        if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1 || maximumBytes > limit) {
            throw new Error('Invalid protected file bound');
        }
        if (process.platform === 'win32') {
            return WindowsStateOwner.bytes(
                await WindowsStateOwner.request(WindowsStateOperation.ReadPath, {
                    path,
                    maximumBytes,
                    secret,
                }),
                maximumBytes,
            );
        }
        const handle: FileHandle = await open(
            path,
            constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
        );
        try {
            const status: BigIntStats = await handle.stat({ bigint: true });
            if (
                !status.isFile() ||
                status.size > BigInt(maximumBytes) ||
                (status.uid !== 0n && status.uid !== BigInt(process.getuid?.() ?? -1)) ||
                (status.mode & (secret ? 0o077n : 0o022n)) !== 0n
            ) {
                throw new Error('Protected file ownership, permissions or size are invalid');
            }
            const chunks: Buffer[] = [];
            let total: number = 0;
            while (total <= maximumBytes) {
                const chunk: Buffer = Buffer.alloc(Math.min(65536, maximumBytes + 1 - total));
                const result: Awaited<ReturnType<FileHandle['read']>> = await handle.read(
                    chunk,
                    0,
                    chunk.length,
                    null,
                );
                if (result.bytesRead === 0) {
                    break;
                }
                total += result.bytesRead;
                if (total > maximumBytes) {
                    throw new Error('Protected file exceeds its bound');
                }
                chunks.push(chunk.subarray(0, result.bytesRead));
            }
            return Buffer.concat(chunks, total);
        } finally {
            await handle.close();
        }
    }

    /** Read-only presence checks never follow a Windows reparse point or create missing ancestry. */
    public static async exists(path: string): Promise<boolean> {
        this.path(path);
        if (process.platform === 'win32') {
            try {
                const result: WindowsStateResponse = await WindowsStateOwner.request(
                    WindowsStateOperation.ExistsPath,
                    { path },
                );
                if (result.exists === null) {
                    throw new WindowsStateError(WindowsStateFailure.Invalid);
                }
                return result.exists;
            } catch (caught: unknown) {
                if (
                    caught instanceof WindowsStateError &&
                    caught.failure === WindowsStateFailure.Missing
                ) {
                    return false;
                }
                throw caught;
            }
        }
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

    /** Windows enumeration stays beneath the same verified native directory handle throughout the operation. */
    public static async listDirectory(path: string): Promise<readonly string[]> {
        this.path(path);
        if (process.platform !== 'win32') {
            return await readdir(path);
        }
        const opened: WindowsStateResponse = await WindowsStateOwner.request(
            WindowsStateOperation.Open,
            { path, purpose: WindowsStatePurpose.Installation },
        );
        if (opened.lease === null) {
            throw new WindowsStateError(WindowsStateFailure.Invalid);
        }
        const lease: string = opened.lease;
        try {
            const result: WindowsStateResponse = await WindowsStateOwner.request(
                WindowsStateOperation.List,
                { lease },
            );
            if (result.names === null) {
                throw new WindowsStateError(WindowsStateFailure.Invalid);
            }
            return result.names;
        } finally {
            await WindowsStateOwner.release(lease);
        }
    }
}
