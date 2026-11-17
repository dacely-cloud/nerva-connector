// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

import { constants, type BigIntStats } from 'node:fs';
import { access, lstat, open, type FileHandle } from 'node:fs/promises';
import { createHash, type Hash } from 'node:crypto';
import { dirname } from 'node:path';
import { ProtectedFiles } from '../local/ProtectedFiles.js';
import { ConnectorNativeExecutionError } from './ConnectorNativeExecutionError.js';
import { ConnectorNativeFormat } from './ConnectorNativeFormat.js';

/** Verification pins one reviewed native ELF or Mach-O; mutable pathnames and shell-script fallback cannot choose execution. */
export class ConnectorNativeExecutable {
    /** The file state each returned descriptor had when its digest was verified. */
    static readonly #verified: WeakMap<FileHandle, BigIntStats> = new WeakMap();

    /** Check current execute permissions and mount flags on the same borrowed capability; ownership remains with its caller on success and failure. */
    public static async assertRunnable(file: FileHandle): Promise<void> {
        try {
            await access('/proc/self/fd/' + file.fd.toString(), constants.X_OK);
        } catch {
            throw new ConnectorNativeExecutionError();
        }
    }

    /**
     * The path to execute a verified helper on macOS, which cannot execute a file descriptor.
     *
     * @remarks
     * Linux runs the retained descriptor through `/proc/self/fd`. macOS has no such path, so the canonical
     * path is executed instead, immediately after confirming it is still executable and still names the
     * exact file, unchanged since its digest was verified. Its ancestry is owner-controlled, so only this
     * user or the administrator could replace it in between.
     */
    public static async verifiedPath(file: FileHandle, path: string): Promise<string> {
        const verified: BigIntStats | undefined = this.#verified.get(file);
        if (process.platform !== 'darwin' || verified === undefined) {
            throw new ConnectorNativeExecutionError();
        }
        try {
            await access(path, constants.X_OK);
        } catch {
            throw new ConnectorNativeExecutionError();
        }
        const [pinned, current]: readonly [BigIntStats, BigIntStats] = await Promise.all([
            file.stat({ bigint: true }),
            lstat(path, { bigint: true }),
        ]);
        if (
            !current.isFile() ||
            [pinned, current].some(
                (status: BigIntStats): boolean =>
                    status.dev !== verified.dev ||
                    status.ino !== verified.ino ||
                    status.size !== verified.size ||
                    status.mtimeNs !== verified.mtimeNs ||
                    status.ctimeNs !== verified.ctimeNs,
            )
        ) {
            throw new Error('Connector executable changed after verification');
        }
        return path;
    }

    /** Ownership of the verified read-only descriptor transfers to the caller; every failure closes it. */
    public static async open(
        path: string,
        digest: string,
        maximumBytes: number = 16777216,
    ): Promise<FileHandle> {
        if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 64 || maximumBytes > 268435456) {
            throw new Error('Invalid native executable size limit');
        }
        await ProtectedFiles.directory(dirname(path));
        const executable: FileHandle = await open(
            path,
            constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
        );
        try {
            const before: BigIntStats = await executable.stat({ bigint: true });
            if (
                !before.isFile() ||
                before.nlink < 1n ||
                before.size < 64n ||
                before.size > BigInt(maximumBytes) ||
                (before.mode & 0o6022n) !== 0n ||
                (before.mode & 0o111n) === 0n ||
                (before.uid !== 0n && before.uid !== BigInt(process.getuid?.() ?? -1))
            ) {
                throw new Error('Untrusted connector native executable');
            }
            const header: Buffer = Buffer.alloc(64);
            const loaded: Awaited<ReturnType<FileHandle['read']>> = await executable.read(
                header,
                0,
                header.byteLength,
                0,
            );
            if (loaded.bytesRead !== 64 || !ConnectorNativeFormat.matches(header)) {
                throw new Error('Connector requires a reviewed native executable');
            }
            const hash: Hash = createHash('sha256');
            const buffer: Buffer = Buffer.alloc(65536);
            let position: number = 0;
            while (position < Number(before.size)) {
                const read: Awaited<ReturnType<FileHandle['read']>> = await executable.read(
                    buffer,
                    0,
                    Math.min(buffer.byteLength, Number(before.size) - position),
                    position,
                );
                if (read.bytesRead === 0) {
                    throw new Error('Connector executable changed while loading');
                }
                hash.update(buffer.subarray(0, read.bytesRead));
                position += read.bytesRead;
            }
            const after: BigIntStats = await executable.stat({ bigint: true });
            if (
                hash.digest('hex') !== digest ||
                before.dev !== after.dev ||
                before.ino !== after.ino ||
                before.size !== after.size ||
                before.mtimeNs !== after.mtimeNs ||
                before.ctimeNs !== after.ctimeNs ||
                before.nlink !== after.nlink
            ) {
                throw new Error('Connector executable digest mismatch');
            }
            ConnectorNativeExecutable.#verified.set(executable, after);
            return executable;
        } catch (caught: unknown) {
            await executable.close();
            throw caught;
        }
    }
}
