// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

/** Loss of output durability stops native work and requires original-state recovery before further commands. */
export class ExecutionOutputRetentionError extends Error {
    /** No filesystem path, command output or storage diagnostic escapes the local durability boundary. */
    public constructor() {
        super('Execution output retention failed');
    }
}
