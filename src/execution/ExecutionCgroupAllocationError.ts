// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

/** A failed allocation cannot discard its owned kernel handles or be treated as an ordinary completed sandbox attempt. */
export class ExecutionCgroupAllocationError extends Error {
    /** Only the exact retained owner may retry cleanup; this error grants no program execution or name-based process kill. */
    public constructor(public readonly owner: AsyncDisposable) {
        super('Execution allocation cleanup remains unproven');
        this.name = 'ExecutionCgroupAllocationError';
    }
}
