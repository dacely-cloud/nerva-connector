// SPDX-FileCopyrightText: 2026 Dacely <business@dacely.com>
// SPDX-License-Identifier: LicenseRef-Proprietary

import { constants, type BigIntStats } from 'node:fs';
import { lstat, open, type FileHandle } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { ProtectedFiles } from '../local/ProtectedFiles.js';

/** The lock is held by another live connector process; the CLI reports it as already running. */
export class ConnectorDarwinStateBusyError extends Error {
    /** Shares the errno name that connector failure reporting already maps to "already running". */
    public readonly code: string = 'EBUSY';

    /** The message names the condition without exposing the per-user lock path. */
    public constructor() {
        super('Connector state is already open in another connector process');
        this.name = 'ConnectorDarwinStateBusyError';
    }
}

/**
 * Exclusive per-purpose ownership of a connector state directory on macOS.
 *
 * @remarks
 * Linux names an abstract socket after the directory identity, which macOS does not have. Here the same
 * name selects a lock file in a dedicated owner-private directory, opened with `O_EXLOCK | O_NONBLOCK`:
 * the kernel takes the `flock` atomically with the open, refuses a second holder at once, and releases it
 * when the descriptor closes or the process dies, so a crash never leaves a stale owner. Lock files live
 * outside the state directories so their listings stay exactly the connector's own records.
 */
export class ConnectorDarwinStateLock {
    /** `O_EXLOCK` from macOS `<sys/fcntl.h>`; Node exposes no constant for it. */
    static readonly #exclusiveLock: number = 0x20;
    /** Lock names are fixed hexadecimal digests, never caller paths. */
    static readonly #name: RegExp = /^nerva-state-[a-f0-9]{64}$/u;

    /** The per-user directory that holds lock files, beside the default state location. */
    public static directory(): string {
        return join(homedir(), '.local/state/nerva-connector-locks');
    }

    /**
     * Take the exclusive lock for one state directory and purpose.
     *
     * @param name - `nerva-state-` followed by the SHA-256 of the purpose and directory identity
     * @returns The open lock file; closing it releases the lock
     * @throws {@link ConnectorDarwinStateBusyError} when another process holds the same lock
     */
    public static async acquire(name: string): Promise<FileHandle> {
        if (process.platform !== 'darwin' || !this.#name.test(name)) {
            throw new Error('Invalid macOS connector state lock');
        }
        const directory: string = this.directory();
        await ProtectedFiles.createDirectory(directory);
        const status: BigIntStats = await lstat(directory, { bigint: true });
        if (
            !status.isDirectory() ||
            status.uid !== BigInt(process.getuid?.() ?? -1) ||
            (status.mode & 0o077n) !== 0n
        ) {
            throw new Error('Connector lock directory must be owner-private');
        }
        try {
            return await open(
                join(directory, name + '.lock'),
                constants.O_RDWR |
                    constants.O_CREAT |
                    constants.O_NOFOLLOW |
                    constants.O_NONBLOCK |
                    this.#exclusiveLock,
                0o600,
            );
        } catch (caught: unknown) {
            if (
                caught instanceof Error &&
                'code' in caught &&
                (caught.code === 'EAGAIN' || caught.code === 'EWOULDBLOCK')
            ) {
                throw new ConnectorDarwinStateBusyError();
            }
            throw caught;
        }
    }
}
