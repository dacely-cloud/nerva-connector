// SPDX-FileCopyrightText: 2026 Dacely <business@dacely.com>
// SPDX-License-Identifier: LicenseRef-Proprietary

import { constants, type BigIntStats } from 'node:fs';
import { open, type FileHandle } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname } from 'node:path';
import { createServer, type Server, type Socket } from 'node:net';
import { ConnectorUpdateHelper } from './ConnectorUpdateHelper.js';
import { ConnectorUpdatePaths } from './ConnectorUpdatePaths.js';
import type { ConnectorUpdateSettings } from './ConnectorUpdateProtocol.js';

/** The supervisor itself owns a kernel lock, released on process death or exec without a stale PID file. */
export class ConnectorUpdateLock implements AsyncDisposable {
    readonly #server: Server | null;
    readonly #file: FileHandle | null;
    #closed: boolean = false;
    private constructor(server: Server | null, file: FileHandle | null) {
        this.#server = server;
        this.#file = file;
    }

    /** Only one installed supervisor per account owns downloads, recovery and process restarts. */
    public static async acquire(
        helper: string,
        file: string,
        settings: ConnectorUpdateSettings,
    ): Promise<ConnectorUpdateLock> {
        await ConnectorUpdateHelper.verify(helper, settings);
        await ConnectorUpdatePaths.directory(dirname(file), true);
        if (process.platform === 'darwin') {
            const handle: FileHandle = await open(
                file,
                constants.O_RDWR |
                    constants.O_CREAT |
                    constants.O_NOFOLLOW |
                    constants.O_NONBLOCK |
                    0x20,
                0o600,
            );
            try {
                const status: BigIntStats = await handle.stat({ bigint: true });
                if (
                    !status.isFile() ||
                    status.uid !== BigInt(process.getuid?.() ?? -1) ||
                    status.nlink !== 1n ||
                    (status.mode & 0o077n) !== 0n ||
                    status.size > 1024n
                ) {
                    throw new Error('Update lock file must remain owner-private');
                }
                return new ConnectorUpdateLock(null, handle);
            } catch (caught: unknown) {
                await handle.close();
                throw caught;
            }
        }
        if (process.platform !== 'linux') {
            throw new Error('Native automatic updates require Linux or macOS');
        }
        const server: Server = createServer((socket: Socket): void => {
            socket.destroy();
        });
        server.maxConnections = 1;
        const ready: PromiseWithResolvers<undefined> = Promise.withResolvers<undefined>();
        server.once('error', ready.reject);
        server.listen(
            '\0nerva-updater-' + createHash('sha256').update(file).digest('hex'),
            (): void => ready.resolve(undefined),
        );
        try {
            await ready.promise;
            server.removeListener('error', ready.reject);
            return new ConnectorUpdateLock(server, null);
        } catch (caught: unknown) {
            if (server.listening) {
                server.close();
            }
            throw caught;
        }
    }

    /** Closing this owner's descriptor or abstract socket releases exactly its kernel lock. */
    public async [Symbol.asyncDispose](): Promise<void> {
        if (!this.#closed) {
            this.#closed = true;
            if (this.#server !== null) {
                const ended: PromiseWithResolvers<undefined> = Promise.withResolvers<undefined>();
                this.#server.close((): void => ended.resolve(undefined));
                await ended.promise;
            }
            await this.#file?.close();
        }
    }
}
