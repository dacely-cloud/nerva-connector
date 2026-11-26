// SPDX-FileCopyrightText: 2026 Dacely <business@dacely.com>
// SPDX-License-Identifier: LicenseRef-Proprietary

import {
    ConnectorEffectKind,
    type ConnectorCapturedFileEffect,
    type ConnectorCapturedExecutionEffect,
} from '../../src/runtime/ConnectorEffectContext.js';
import type { ConnectorFileOperation } from 'nerva-connector-protocol/protocol/ConnectorFileJobs.js';
import type { ExecutionRequest } from 'nerva-connector-protocol/execution/ExecutionJobs.js';

/** Synthetic values test journal shape/correlation only; they do not qualify filesystem provenance or native execution. */
export class JournalEffectFixture {
    /** Synthetic identities test authenticated storage transitions only, without creating or invoking a native group. */
    public static execution(request: ExecutionRequest): ConnectorCapturedExecutionEffect {
        return {
            kind: ConnectorEffectKind.CapturedExecution,
            policySha256: request.policySha256,
            rootId: request.rootId,
            root: {
                filesystemUuid: 'a'.repeat(32),
                device: 1n,
                inode: 2n,
                handleType: 1,
                handle: '0100000000000000',
            },
            cgroupRoot: '/sys/fs/cgroup/unit-only',
            cgroupHelperFile: '/unit-only/helper',
            cgroupHelperSha256: 'b'.repeat(64),
            delegation: {
                bootId: '11111111-1111-1111-1111-111111111111',
                device: 9007199254740993n,
                filesystemId: '0100000000000000',
                handleType: 254,
                handle: '0100000001000000',
            },
            group: null,
        };
    }
    /** Physical integration fixtures must capture actual opened roots instead of calling this unit-only constructor. */
    public static file(request: ConnectorFileOperation): ConnectorCapturedFileEffect {
        return {
            kind: ConnectorEffectKind.CapturedFile,
            policySha256: request.policySha256,
            rootId: request.rootId,
            root: {
                filesystemUuid: 'a'.repeat(32),
                device: 1n,
                inode: 2n,
                handleType: 1,
                handle: '0100000000000000',
            },
            staging: null,
        };
    }
}
