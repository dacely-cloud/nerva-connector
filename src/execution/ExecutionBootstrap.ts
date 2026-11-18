// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

import type { ExecutionBootstrapInput } from './ExecutionBootstrapInput.js';
import type { ExecutionWorkspaceAccess } from 'nerva-connector-protocol/execution/ExecutionTypes.js';

/** These native namespace identities are captured before launching an isolated process. */
export interface ExecutionNamespaces {
    readonly mnt: string;
    readonly user: string;
    readonly pid: string;
    readonly net: string;
    readonly ipc: string;
    readonly uts: string;
    readonly cgroup: string;
}

/** Local policy resolution supplies exact runtime executable paths and already validated signed application input. */
export interface ExecutionBootstrap {
    /** The final trusted native pre-exec check cannot extend this captured start window. */
    readonly admissionExpiresAtMs: bigint;
    readonly apparmorProfile: string;
    readonly program: string;
    readonly arguments: readonly string[];
    readonly input: ExecutionBootstrapInput;
    readonly allowedExecutables: readonly string[];
    readonly workspaceAccess: ExecutionWorkspaceAccess;
    readonly parentNamespaces: ExecutionNamespaces;
    readonly maximumCpuSeconds: number;
    readonly maximumAddressBytes: bigint;
    readonly maximumFileBytes: bigint;
}
