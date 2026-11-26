// SPDX-FileCopyrightText: 2026 Dacely <business@dacely.com>
// SPDX-License-Identifier: LicenseRef-Proprietary

import { HostWorkspaceLimits, type HostProcessOutput } from './HostWorkspaceTypes.js';

/** A fixed-size byte ring preserves newest output and exact cumulative offsets without repeated concatenation. */
export class HostByteRing {
    readonly #bytes: Buffer = Buffer.alloc(HostWorkspaceLimits.streamBytes);
    #end: bigint = 0n;
    #length: number = 0;
    #position: number = 0;

    /** Cumulative received bytes remain exact even after older bytes leave the ring. */
    public get endOffset(): bigint {
        return this.#end;
    }

    /** Stream chunks never enlarge the retained ring allocation. */
    public append(bytes: Buffer): void {
        this.#end += BigInt(bytes.length);
        const chunk: Buffer =
            bytes.length > this.#bytes.length
                ? bytes.subarray(bytes.length - this.#bytes.length)
                : bytes;
        const first: number = Math.min(chunk.length, this.#bytes.length - this.#position);
        chunk.copy(this.#bytes, this.#position, 0, first);
        chunk.copy(this.#bytes, 0, first);
        this.#position = (this.#position + chunk.length) % this.#bytes.length;
        this.#length = Math.min(this.#bytes.length, this.#length + chunk.length);
    }

    /** Replies signal overwritten data explicitly and allow exact continuation across binary chunks. */
    public read(offset: bigint, maximum: number): HostProcessOutput {
        if (typeof offset !== 'bigint' || offset < 0n || offset > this.#end) {
            throw new Error('Invalid host output offset');
        }
        const begin: bigint = this.#end - BigInt(this.#length);
        const selected: bigint = offset < begin ? begin : offset;
        const length: number = Number(
            this.#end - selected < BigInt(maximum) ? this.#end - selected : BigInt(maximum),
        );
        const position: number =
            (this.#position - Number(this.#end - selected) + this.#bytes.length) %
            this.#bytes.length;
        const bytes: Buffer = Buffer.alloc(length);
        const first: number = Math.min(length, this.#bytes.length - position);
        this.#bytes.copy(bytes, 0, position, position + first);
        this.#bytes.copy(bytes, first, 0, length - first);
        return {
            offset: selected,
            nextOffset: selected + BigInt(length),
            endOffset: this.#end,
            truncated: offset < begin,
            bytes,
        };
    }
}
