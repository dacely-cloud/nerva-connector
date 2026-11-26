// SPDX-FileCopyrightText: 2026 Dacely <business@dacely.com>
// SPDX-License-Identifier: LicenseRef-Proprietary

import { constants, type BigIntStats } from 'node:fs';
import { open, type FileHandle } from 'node:fs/promises';
import { dirname } from 'node:path';
import { createHash, type Hash } from 'node:crypto';
import { ProtectedFiles } from './ProtectedFiles.js';

/** Exact public artifact quantities and mode are approved before copying, never inferred from received content. */
export interface ProtectedArtifactExpectation {
    readonly sizeBytes: bigint;
    readonly maximumBytes: number;
    readonly executable: boolean;
}

/** Bounded descriptor reads protect both signed release assets and approved clean-runtime files. */
export class ProtectedArtifact {
    /** A verified source is a protected single-link regular file; writable aliases and privileged executable modes are rejected. */
    public static trusted(status: BigIntStats, executable: boolean): void {
        if (
            !status.isFile() ||
            status.nlink !== 1n ||
            (status.uid !== 0n && status.uid !== BigInt(process.getuid?.() ?? -1)) ||
            (status.mode & 0o6022n) !== 0n ||
            (executable && (status.mode & 0o100n) === 0n)
        ) {
            throw new Error('Public artifact needs protected single-link bytes');
        }
    }
    /** No source is executed or buffered whole; inode/time/size changes invalidate the stream before publication. */
    public static async transfer(
        path: string,
        output: FileHandle | null,
        expected: ProtectedArtifactExpectation,
        signal: AbortSignal,
    ): Promise<string> {
        if (
            !Number.isSafeInteger(expected.maximumBytes) ||
            expected.maximumBytes < 1 ||
            expected.maximumBytes > 268435456 ||
            expected.sizeBytes < 1n ||
            expected.sizeBytes > BigInt(expected.maximumBytes)
        ) {
            throw new Error('Invalid public artifact transfer bounds');
        }
        await ProtectedFiles.directory(dirname(ProtectedFiles.path(path)));
        const input: FileHandle = await open(
            path,
            constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
        );
        try {
            const before: BigIntStats = await input.stat({ bigint: true });
            this.trusted(before, expected.executable);
            if (before.size !== expected.sizeBytes) {
                throw new Error('Public artifact size changed');
            }
            const hash: Hash = createHash('sha256');
            const buffer: Buffer = Buffer.alloc(65536);
            let total: bigint = 0n;
            while (true) {
                signal.throwIfAborted();
                const loaded: Awaited<ReturnType<FileHandle['read']>> = await input.read(
                    buffer,
                    0,
                    buffer.length,
                    null,
                );
                if (loaded.bytesRead === 0) {
                    break;
                }
                total += BigInt(loaded.bytesRead);
                if (total > expected.sizeBytes) {
                    throw new Error('Public artifact exceeded its approved size');
                }
                const chunk: Buffer = buffer.subarray(0, loaded.bytesRead);
                hash.update(chunk);
                if (output !== null) {
                    await output.writeFile(chunk);
                }
            }
            const after: BigIntStats = await input.stat({ bigint: true });
            if (
                total !== expected.sizeBytes ||
                before.dev !== after.dev ||
                before.ino !== after.ino ||
                before.mtimeNs !== after.mtimeNs ||
                before.ctimeNs !== after.ctimeNs ||
                before.size !== after.size
            ) {
                throw new Error('Public artifact identity or bytes changed');
            }
            return hash.digest('hex');
        } finally {
            await input.close();
        }
    }
}
