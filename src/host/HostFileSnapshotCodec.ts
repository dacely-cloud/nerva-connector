// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

import type { BigIntStats } from 'node:fs';
import { ConnectorHostErrorCode } from '../protocol/ConnectorHost.js';
import { HostOperationError } from './HostOperationError.js';
import { Boundary } from 'nerva-connector-protocol/protocol/Boundary.js';
import { HostFileIdentity } from './HostFileIdentity.js';
import type { HostFileSnapshot } from './HostWorkspaceTypes.js';

/** Snapshot preconditions remain exact across JSON transport and descriptor checks. */
export class HostFileSnapshotCodec {
    /** External snapshots use decimal strings, including signed historical timestamps. */
    public static decode(raw: unknown): HostFileSnapshot {
        const value: Readonly<Record<string, unknown>> = Boundary.record(raw, [
            'identity',
            'size',
            'modifiedAtNs',
        ]);
        if (typeof value['identity'] !== 'string') {
            throw new Error('Invalid host snapshot identity');
        }
        const snapshot: HostFileSnapshot = {
            identity: value['identity'],
            size: Boundary.integer(value['size']),
            modifiedAtNs: this.#timestamp(value['modifiedAtNs']),
        };
        this.validate(snapshot);
        return snapshot;
    }

    /** Typed callers cannot bypass actual runtime snapshot validation. */
    public static validate(snapshot: HostFileSnapshot): void {
        if (
            snapshot === null ||
            typeof snapshot !== 'object' ||
            typeof snapshot.identity !== 'string' ||
            snapshot.identity.length < 1 ||
            snapshot.identity.length > 256 ||
            snapshot.identity.includes('\0') ||
            typeof snapshot.size !== 'bigint' ||
            snapshot.size < 0n ||
            typeof snapshot.modifiedAtNs !== 'bigint'
        ) {
            throw new Error('Invalid host file snapshot');
        }
    }

    /** The same opened descriptor must still match the captured size, timestamp and actual identity. */
    public static assert(metadata: BigIntStats, snapshot: HostFileSnapshot): void {
        if (
            !metadata.isFile() ||
            HostFileIdentity.from(metadata) !== snapshot.identity ||
            metadata.size !== snapshot.size ||
            metadata.mtimeNs !== snapshot.modifiedAtNs
        ) {
            throw new HostOperationError(
                ConnectorHostErrorCode.SnapshotChanged,
                'Host file snapshot changed',
                true,
            );
        }
    }

    static #timestamp(raw: unknown): bigint {
        if (typeof raw !== 'string' || raw.length > 40 || !/^(0|-?[1-9][0-9]*)$/u.test(raw)) {
            throw new Error('Invalid exact host file timestamp');
        }
        return BigInt(raw);
    }
}
