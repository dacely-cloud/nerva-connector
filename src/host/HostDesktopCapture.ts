// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

import { constants, type BigIntStats } from 'node:fs';
import { open, lstat, unlink, type FileHandle } from 'node:fs/promises';
import { HostWriteMode } from './HostWorkspaceTypes.js';
import { HostWorkspaceValidation } from './HostWorkspaceValidation.js';
import type { HostDesktopInfo, HostDesktopScreenshot } from './HostDesktopTypes.js';

/** An intentional screenshot artifact owns no intermediate files or repeated exports. */
export class HostDesktopCapture {
    /** Validate native PNG geometry before creating or replacing the explicit destination. */
    public static async save(
        path: string,
        mode: HostWriteMode,
        bytes: Buffer,
        desktop: HostDesktopInfo,
        maximumWidth: number,
        maximumHeight: number,
    ): Promise<HostDesktopScreenshot> {
        if (
            bytes.length < 24 ||
            !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ||
            bytes.toString('ascii', 12, 16) !== 'IHDR'
        ) {
            throw new Error('Desktop backend returned invalid PNG bytes');
        }
        const width: number = HostWorkspaceValidation.count(
            bytes.readUInt32BE(16),
            1,
            maximumWidth,
        );
        const height: number = HostWorkspaceValidation.count(
            bytes.readUInt32BE(20),
            1,
            maximumHeight,
        );
        const file: FileHandle = await open(
            path,
            constants.O_WRONLY |
                constants.O_CREAT |
                constants.O_NONBLOCK |
                (mode === HostWriteMode.Create ? constants.O_EXCL : 0),
            0o600,
        );
        let completed: boolean = false;
        try {
            if (!(await file.stat()).isFile()) {
                throw new Error('Desktop screenshot requires a regular destination file');
            }
            if (mode === HostWriteMode.Replace) {
                await file.truncate(0);
            }
            await file.writeFile(bytes);
            await file.sync();
            completed = true;
        } finally {
            try {
                if (!completed && mode === HostWriteMode.Create) {
                    const owned: BigIntStats = await file.stat({ bigint: true });
                    const current: BigIntStats = await lstat(path, { bigint: true });
                    if (
                        current.isFile() &&
                        current.dev === owned.dev &&
                        current.ino === owned.ino
                    ) {
                        await unlink(path);
                    }
                }
            } finally {
                await file.close();
            }
        }
        return { path, width, height, sizeBytes: BigInt(bytes.length), desktop };
    }
}
