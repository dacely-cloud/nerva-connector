// SPDX-FileCopyrightText: 2026 Dacely <business@dacely.com>
// SPDX-License-Identifier: LicenseRef-Proprietary

import { open, type FileHandle } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import type { WindowsStateArtifact } from './WindowsStateArtifact.js';

/** Source development uses build metadata; the bundled app replaces this reader with its compiled-in digest. */
export class WindowsStateBuild {
    /** One bounded metadata file is never interpreted as code or used to select an executable path. */
    public static async read(
        path: string | URL = new URL('../../build/nerva-connector-state.json', import.meta.url),
    ): Promise<WindowsStateArtifact | null> {
        let handle: FileHandle;
        try {
            handle = await open(path, 'r');
        } catch (caught: unknown) {
            if (caught instanceof Error && 'code' in caught && caught.code === 'ENOENT') {
                return null;
            }
            throw caught;
        }
        try {
            const bytes: Buffer = Buffer.alloc(2049);
            const read: Awaited<ReturnType<FileHandle['read']>> = await handle.read(
                bytes,
                0,
                bytes.byteLength,
                0,
            );
            if (read.bytesRead > 2048) {
                throw new Error('Invalid compiled Windows helper metadata');
            }
            const raw: unknown = JSON.parse(
                new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, read.bytesRead)),
            );
            if (
                raw === null ||
                typeof raw !== 'object' ||
                Array.isArray(raw) ||
                Object.keys(raw).length !== 3 ||
                !('bytes' in raw) ||
                typeof raw.bytes !== 'number' ||
                !Number.isSafeInteger(raw.bytes) ||
                raw.bytes < 512 ||
                raw.bytes > 262144 ||
                !('sha256' in raw) ||
                typeof raw.sha256 !== 'string' ||
                !/^[a-f0-9]{64}$/u.test(raw.sha256) ||
                !('sourceSha256' in raw) ||
                typeof raw.sourceSha256 !== 'string' ||
                !/^[a-f0-9]{64}$/u.test(raw.sourceSha256)
            ) {
                throw new Error('Invalid compiled Windows helper metadata');
            }
            return { bytes: raw.bytes, sha256: raw.sha256, sourceSha256: raw.sourceSha256 };
        } catch {
            throw new Error('Invalid compiled Windows helper metadata');
        } finally {
            await handle.close();
        }
    }

    /** Source development resolves the same fixed output that the build pins beside the bundled entry. */
    public static executable(): string {
        return fileURLToPath(new URL('../../build/nerva-connector-state.exe', import.meta.url));
    }
}
