// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

import type { ExecutionBootstrapInput } from './ExecutionBootstrapInput.js';

/** Execution authority is distinct from a file-read grant; this controls persistent workspace mutation. */
export enum ExecutionWorkspaceAccess {
    ReadOnly = 'read-only',
    ReadWrite = 'read-write',
}

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

/** Aggregate controls apply outside the namespace to every descendant, including forked background processes. */
export interface ExecutionResourceLimits {
    readonly memoryBytes: bigint;
    readonly maximumTasks: number;
    readonly cpuQuotaMicros: number;
}

/** A closed connection or interrupted process is never treated as a successful completed command. */
export enum ExecutionTermination {
    Exited = 'exited',
    Indeterminate = 'indeterminate',
}

/** Causes describe local observation only; an indeterminate command may already have changed its granted workspace. */
export enum ExecutionFailure {
    Sandbox = 'sandbox',
    Cancelled = 'cancelled',
    Timeout = 'timeout',
    OutputLimit = 'output-limit',
    Signal = 'signal',
    AmbiguousExit = 'ambiguous-exit',
    Interrupted = 'interrupted',
    Expired = 'expired',
}

/** Bounded local results remain unsigned until the separately authorized durable remote operation owner admits them. */
export interface ExecutionResult {
    readonly setupFailure: ExecutionSetupFailure | null;
    readonly termination: ExecutionTermination;
    readonly failure: ExecutionFailure | null;
    readonly exitCode: number | null;
    readonly stdoutBase64: string;
    readonly stderrBase64: string;
}

/** Native pre-execution stages expose no OS message, host path or credential. */
export enum ExecutionSetupFailure {
    Bootstrap = 'bootstrap',
    Configuration = 'configuration',
    Namespaces = 'namespaces',
    Cgroup = 'cgroup',
    Mounts = 'mounts',
    AppArmor = 'apparmor',
    Confinement = 'confinement',
    Execute = 'execute',
}
