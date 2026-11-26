// SPDX-FileCopyrightText: 2026 Dacely <business@dacely.com>
// SPDX-License-Identifier: LicenseRef-Proprietary

import { open, type FileHandle } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import type { HostLinuxArtifact } from './HostLinuxArtifact.js';

/** Source builds use bounded metadata; the standalone bundle embeds the reviewed helper commitment. */
export class HostLinuxBuild {
    /** Only exact finite metadata is accepted; executable selection remains a fixed build path. */
    public static async read(): Promise<HostLinuxArtifact | null> {
        let handle: FileHandle;
        try {
            handle = await open(
                new URL('../../build/nerva-connector-exec.json', import.meta.url),
                'r',
            );
        } catch (error: unknown) {
            if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
                return null;
            }
            throw error;
        }
        try {
            const bytes: Buffer = Buffer.alloc(2049);
            const result: Awaited<ReturnType<FileHandle['read']>> = await handle.read(
                bytes,
                0,
                bytes.byteLength,
                0,
            );
            if (result.bytesRead > 2048) {
                throw new Error('Invalid Linux terminal build pin');
            }
            const raw: unknown = JSON.parse(
                new TextDecoder('utf-8', { fatal: true }).decode(
                    bytes.subarray(0, result.bytesRead),
                ),
            );
            if (
                raw === null ||
                typeof raw !== 'object' ||
                Array.isArray(raw) ||
                Object.keys(raw).length !== 2 ||
                !('bytes' in raw) ||
                typeof raw.bytes !== 'number' ||
                !Number.isSafeInteger(raw.bytes) ||
                raw.bytes < 64 ||
                raw.bytes > 16777216 ||
                !('sha256' in raw) ||
                typeof raw.sha256 !== 'string' ||
                !/^[a-f0-9]{64}$/u.test(raw.sha256)
            ) {
                throw new Error('Invalid Linux terminal build pin');
            }
            return { bytes: raw.bytes, sha256: raw.sha256 };
        } finally {
            await handle.close();
        }
    }

    /** The helper stays adjacent to source build products; bundles replace this with their adjacent asset. */
    public static executable(): string {
        return fileURLToPath(new URL('../../build/nerva-connector-exec', import.meta.url));
    }
}
