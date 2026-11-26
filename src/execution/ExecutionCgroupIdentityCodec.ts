// SPDX-FileCopyrightText: 2026 Dacely <business@dacely.com>
// SPDX-License-Identifier: LicenseRef-Proprietary

import { Boundary } from 'nerva-connector-protocol/protocol/Boundary.js';
import type { ExecutionCgroupIdentity } from './ExecutionCgroupIdentity.js';

/** Exact kernel identities remain private; a pathname or inode alone never substitutes for a kernfs generation. */
export class ExecutionCgroupIdentityCodec {
    /** Native inspection and authenticated encrypted history cross the same strict local boundary. */
    public static read(raw: unknown): ExecutionCgroupIdentity {
        const value: Readonly<Record<string, unknown>> = Boundary.record(raw, [
            'bootId',
            'device',
            'filesystemId',
            'handleType',
            'handle',
        ]);
        const bootId: unknown = value['bootId'];
        const filesystemId: unknown = value['filesystemId'];
        const handle: unknown = value['handle'];
        if (
            typeof bootId !== 'string' ||
            !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u.test(bootId) ||
            bootId === '00000000-0000-0000-0000-000000000000' ||
            typeof filesystemId !== 'string' ||
            !/^[a-f0-9]{16}$/u.test(filesystemId) ||
            filesystemId === '0000000000000000' ||
            typeof handle !== 'string' ||
            !/^[a-f0-9]{16}$/u.test(handle) ||
            value['handleType'] !== 254
        ) {
            throw new Error('Invalid private cgroup identity');
        }
        const device: bigint = Boundary.integer(value['device']);
        if (device > 0xffffffffffffffffn) {
            throw new Error('Invalid private cgroup device');
        }
        return Object.freeze({ bootId, device, filesystemId, handleType: 254, handle });
    }

    /** All qualified generation, mount and boot material must agree before an existing group is touched. */
    public static same(first: ExecutionCgroupIdentity, second: ExecutionCgroupIdentity): boolean {
        return (
            first.bootId === second.bootId &&
            first.device === second.device &&
            first.filesystemId === second.filesystemId &&
            first.handleType === second.handleType &&
            first.handle === second.handle
        );
    }
}
