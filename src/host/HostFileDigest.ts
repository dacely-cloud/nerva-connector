// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

import { createHash, type Hash } from 'node:crypto';
import { constants, type BigIntStats } from 'node:fs';
import { open, type FileHandle } from 'node:fs/promises';
import { ConnectorHostErrorCode } from 'nerva-connector-protocol/protocol/ConnectorHost.js';
import { HostOperationError } from './HostOperationError.js';
import { HostFileSnapshotCodec } from './HostFileSnapshotCodec.js';
import {
    HostFileDigestAlgorithm,
    HostWorkspaceLimits,
    type HostFileSnapshot,
    type HostFileDigestResult,
} from './HostWorkspaceTypes.js';

/** One bounded streaming digest reads one opened file generation and joins its I/O on cancellation. */
export class HostFileDigest {
    /** Deadline exhaustion fails explicitly; it never returns the digest of a prefix as a complete-file hash. */
    public static async read(
        path: string,
        snapshot: HostFileSnapshot,
        signal?: AbortSignal,
    ): Promise<HostFileDigestResult> {
        HostFileSnapshotCodec.validate(snapshot);
        signal?.throwIfAborted();
        const stop: AbortController = new AbortController();
        const timer: NodeJS.Timeout = setTimeout(
            (): void => stop.abort(new Error('Host file digest deadline exceeded')),
            HostWorkspaceLimits.digestTimeoutMs,
        );
        timer.unref();
        const active: AbortSignal =
            signal === undefined ? stop.signal : AbortSignal.any([signal, stop.signal]);
        let file: FileHandle | null = null;
        try {
            file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
            active.throwIfAborted();
            HostFileSnapshotCodec.assert(await file.stat({ bigint: true }), snapshot);
            const hash: Hash = createHash('sha256');
            const bytes: Buffer = Buffer.alloc(HostWorkspaceLimits.digestChunkBytes);
            let read: bigint = 0n;
            while (read < snapshot.size) {
                active.throwIfAborted();
                const remaining: bigint = snapshot.size - read;
                const maximum: number =
                    remaining > BigInt(bytes.length) ? bytes.length : Number(remaining);
                const result: Awaited<ReturnType<FileHandle['read']>> = await file.read(
                    bytes,
                    0,
                    maximum,
                    null,
                );
                active.throwIfAborted();
                if (result.bytesRead === 0) {
                    throw new HostOperationError(
                        ConnectorHostErrorCode.SnapshotChanged,
                        'Host file snapshot changed before complete digest',
                        true,
                    );
                }
                hash.update(bytes.subarray(0, result.bytesRead));
                read += BigInt(result.bytesRead);
            }
            const after: BigIntStats = await file.stat({ bigint: true });
            active.throwIfAborted();
            HostFileSnapshotCodec.assert(after, snapshot);
            return {
                algorithm: HostFileDigestAlgorithm.Sha256,
                digest: hash.digest('hex'),
                size: read,
                identity: snapshot.identity,
                modifiedAtNs: snapshot.modifiedAtNs,
            };
        } finally {
            try {
                await file?.close();
            } finally {
                clearTimeout(timer);
            }
        }
    }
}
