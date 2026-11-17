// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

import { lstat, type FileHandle } from 'node:fs/promises';

/** A created name whose directory could not be opened remains a blocked allocation until absence is proven. */
export class ExecutionCgroupReservation implements AsyncDisposable {
    #closed: boolean = false;

    /** The newly allocated name and its still-held parent are private ownership data, not authority to adopt or kill another group. */
    public constructor(
        public readonly parent: FileHandle,
        public readonly name: string,
    ) {}

    /** Never kill or unlink an unconfirmed object; release the held parent only after the reserved name is absent. */
    public async [Symbol.asyncDispose](): Promise<void> {
        if (this.#closed) {
            return;
        }
        try {
            await lstat('/proc/self/fd/' + this.parent.fd.toString() + '/' + this.name);
        } catch (caught: unknown) {
            if (caught instanceof Error && 'code' in caught && caught.code === 'ENOENT') {
                await this.parent.close();
                this.#closed = true;
                return;
            }
            throw caught;
        }
        throw new Error('Unconfirmed execution allocation is still present');
    }
}
