// SPDX-FileCopyrightText: 2026 Dacely <business@dacely.com>
// SPDX-License-Identifier: LicenseRef-Proprietary

import { open, link, rm, lstat, type FileHandle } from 'node:fs/promises';
import { join } from 'node:path';
import { constants, type BigIntStats } from 'node:fs';
import { ProtectedFiles } from '../local/ProtectedFiles.js';
import type { ConnectorServiceLayout } from './ConnectorServiceTypes.js';

/** Publication and removal operate only on a protected exact unit and never overwrite foreign bytes. */
export class ConnectorServiceFile {
    /** A missing leaf is distinct from corrupt or foreign content. */
    public static async exists(layout: ConnectorServiceLayout): Promise<boolean> {
        try {
            await lstat(layout.unitFile);
            return true;
        } catch (caught: unknown) {
            if (caught instanceof Error && 'code' in caught && caught.code === 'ENOENT') {
                return false;
            }
            throw caught;
        }
    }
    /** The owning registration must be checked by the caller before publishing or cleaning partials. */
    public static async publish(layout: ConnectorServiceLayout): Promise<void> {
        await ProtectedFiles.createDirectory(layout.unitDirectory);
        const partial: string = join(layout.unitDirectory, '.' + layout.unitName + '.partial');
        try {
            const status: BigIntStats = await lstat(partial, { bigint: true });
            if (
                !status.isFile() ||
                status.nlink !== 1n ||
                status.uid !== BigInt(process.getuid?.() ?? -1) ||
                (status.mode & 0o077n) !== 0n ||
                status.size > 16384n
            ) {
                throw new Error('Invalid service publication partial');
            }
            await rm(partial);
        } catch (caught: unknown) {
            if (!(caught instanceof Error) || !('code' in caught) || caught.code !== 'ENOENT') {
                throw caught;
            }
        }
        if (await this.exists(layout)) {
            await this.assertOwned(layout);
            return;
        }
        const file: FileHandle = await open(partial, 'wx', 0o600);
        try {
            await file.writeFile(layout.source);
            await file.sync();
            await file.close();
            await link(partial, layout.unitFile);
            await this.#sync(layout);
        } finally {
            await file.close();
            await rm(partial, { force: true });
        }
    }
    /** Symlinks, aliases, changed bytes and unsafe ownership never confer service authority. */
    public static async assertOwned(layout: ConnectorServiceLayout): Promise<void> {
        const bytes: Buffer = await ProtectedFiles.readPrivate(layout.unitFile, 16384);
        const state: BigIntStats = await lstat(layout.unitFile, { bigint: true });
        if (state.nlink !== 1n || !bytes.equals(Buffer.from(layout.source))) {
            throw new Error('Service unit is not the original owned unit');
        }
    }
    /** Disable/stop must precede this exact no-data deletion. */
    public static async remove(layout: ConnectorServiceLayout): Promise<void> {
        if (!(await this.exists(layout))) {
            return;
        }
        await this.assertOwned(layout);
        await rm(layout.unitFile);
        await this.#sync(layout);
    }
    static async #sync(layout: ConnectorServiceLayout): Promise<void> {
        const directory: FileHandle = await open(
            layout.unitDirectory,
            constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
        );
        try {
            await directory.sync();
        } finally {
            await directory.close();
        }
    }
}
