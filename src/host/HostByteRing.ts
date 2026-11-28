// SPDX-FileCopyrightText: 2026 Dacely <business@dacely.com>
// SPDX-License-Identifier: LicenseRef-Proprietary

import { HostWorkspaceLimits, type HostProcessOutput } from './HostWorkspaceTypes.js';

/**
 * A byte ring preserves newest output and exact cumulative offsets without repeated concatenation.
 *
 * @remarks
 * Storage grows by doubling with the output actually received, up to the stream bound, so a
 * retained process that printed little holds little; only output at the bound starts to wrap.
 */
export class HostByteRing {
    /** The smallest allocation, so short outputs do not reallocate on every chunk. */
    static readonly #INITIAL_BYTES: number = 4096;

    #bytes: Buffer = Buffer.alloc(0);
    #end: bigint = 0n;
    #length: number = 0;
    #position: number = 0;

    /** Cumulative received bytes remain exact even after older bytes leave the ring. */
    public get endOffset(): bigint {
        return this.#end;
    }

    /** Stream chunks enlarge the allocation only up to the stream bound. */
    public append(bytes: Buffer): void {
        this.#end += BigInt(bytes.length);
        if (bytes.length === 0) {
            return;
        }
        const chunk: Buffer =
            bytes.length > HostWorkspaceLimits.streamBytes
                ? bytes.subarray(bytes.length - HostWorkspaceLimits.streamBytes)
                : bytes;
        this.#reserve(Math.min(HostWorkspaceLimits.streamBytes, this.#length + chunk.length));
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
        const bytes: Buffer = Buffer.alloc(length);
        if (length === 0) {
            return {
                offset: selected,
                nextOffset: selected,
                endOffset: this.#end,
                truncated: offset < begin,
                bytes,
            };
        }
        const position: number =
            (this.#position - Number(this.#end - selected) + this.#bytes.length) %
            this.#bytes.length;
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

    /** Grows to hold `needed` retained bytes, keeping them in order at the start of the new buffer. */
    #reserve(needed: number): void {
        const size: number = this.#bytes.length;
        if (needed <= size) {
            return;
        }
        const grown: Buffer = Buffer.alloc(
            Math.min(
                HostWorkspaceLimits.streamBytes,
                Math.max(needed, size * 2, HostByteRing.#INITIAL_BYTES),
            ),
        );
        if (this.#length > 0) {
            const start: number = (this.#position - this.#length + size) % size;
            const first: number = Math.min(this.#length, size - start);
            this.#bytes.copy(grown, 0, start, start + first);
            this.#bytes.copy(grown, first, 0, this.#length - first);
        }
        this.#bytes = grown;
        this.#position = this.#length;
    }
}
