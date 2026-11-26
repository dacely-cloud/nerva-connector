// SPDX-FileCopyrightText: 2026 Dacely <business@dacely.com>
// SPDX-License-Identifier: LicenseRef-Proprietary

/** A private boot-scoped kernfs handle identifies the opened cgroup, including its generation. */
export interface ExecutionCgroupIdentity {
    readonly bootId: string;
    readonly device: bigint;
    readonly filesystemId: string;
    readonly handleType: 254;
    readonly handle: string;
}
