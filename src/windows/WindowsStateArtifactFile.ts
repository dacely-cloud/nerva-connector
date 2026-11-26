// SPDX-FileCopyrightText: 2026 Dacely <business@dacely.com>
// SPDX-License-Identifier: LicenseRef-Proprietary

import { createHash } from 'node:crypto';
import { lstat, open, type FileHandle } from 'node:fs/promises';
import type { BigIntStats } from 'node:fs';
import type { WindowsStateArtifact } from './WindowsStateArtifact.js';

/** Shared build/runtime byte verification does not execute or compile the selected file. */
export class WindowsStateArtifactFile {
    /** File reads remain bounded even when a build output is concurrently replaced or enlarged. */
    public static async verify(path: string, artifact: WindowsStateArtifact): Promise<void> {
        await this.read(path, artifact);
    }

    /** Explicit artifact exports reuse the already verified bounded bytes rather than reopening an unpinned file. */
    public static async read(path: string, artifact: WindowsStateArtifact): Promise<Buffer> {
        if (
            !Number.isSafeInteger(artifact.bytes) ||
            artifact.bytes < 512 ||
            artifact.bytes > 262144 ||
            !/^[a-f0-9]{64}$/u.test(artifact.sha256)
        ) {
            throw new Error('Compiled Windows helper does not match the build');
        }
        let handle: FileHandle | null = null;
        try {
            const leaf: BigIntStats = await lstat(path, { bigint: true });
            if (!leaf.isFile() || leaf.isSymbolicLink() || leaf.size !== BigInt(artifact.bytes)) {
                throw new Error('Compiled Windows helper does not match the build');
            }
            handle = await open(path, 'r');
            const before: BigIntStats = await handle.stat({ bigint: true });
            if (
                !before.isFile() ||
                before.dev !== leaf.dev ||
                before.ino !== leaf.ino ||
                before.size !== leaf.size
            ) {
                throw new Error('Compiled Windows helper does not match the build');
            }
            const bytes: Buffer = Buffer.alloc(artifact.bytes + 1);
            let count: number = 0;
            while (count < bytes.byteLength) {
                const part: Awaited<ReturnType<FileHandle['read']>> = await handle.read(
                    bytes,
                    count,
                    bytes.byteLength - count,
                    count,
                );
                if (part.bytesRead === 0) {
                    break;
                }
                count += part.bytesRead;
            }
            const after: BigIntStats = await handle.stat({ bigint: true });
            if (
                count !== artifact.bytes ||
                after.size !== before.size ||
                after.mtimeNs !== before.mtimeNs ||
                bytes[0] !== 0x4d ||
                bytes[1] !== 0x5a ||
                createHash('sha256').update(bytes.subarray(0, count)).digest('hex') !==
                    artifact.sha256
            ) {
                throw new Error('Compiled Windows helper does not match the build');
            }
            return bytes.subarray(0, count);
        } finally {
            await handle?.close();
        }
    }
}
