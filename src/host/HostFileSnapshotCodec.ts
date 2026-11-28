// SPDX-FileCopyrightText: 2026 Dacely <business@dacely.com>
// SPDX-License-Identifier: LicenseRef-Proprietary

import type { BigIntStats } from 'node:fs';
import { ConnectorHostErrorCode } from 'nerva-connector-protocol/protocol/ConnectorHost.js';
import { HostOperationError } from './HostOperationError.js';
import type { ConnectorHostArguments } from 'nerva-connector-protocol/protocol/ConnectorHostArguments.js';
import { HostFileIdentity } from './HostFileIdentity.js';
import type { HostFileSnapshot } from './HostWorkspaceTypes.js';

/** Snapshot preconditions remain exact across JSON transport and descriptor checks. */
export class HostFileSnapshotCodec {
    /** A snapshot from tool arguments that already satisfy their contract; quantities stay exact. */
    public static decode(snapshot: ConnectorHostArguments): HostFileSnapshot {
        const decoded: HostFileSnapshot = {
            identity: snapshot.text('identity'),
            size: snapshot.decimal('size'),
            modifiedAtNs: snapshot.decimal('modifiedAtNs'),
        };
        this.validate(decoded);
        return decoded;
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
            throw new HostOperationError(
                ConnectorHostErrorCode.InvalidRequest,
                'Host file snapshot identity must be 1 to 256 characters with a non-negative size',
                true,
            );
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
}
