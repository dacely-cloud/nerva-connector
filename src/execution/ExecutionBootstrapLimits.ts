// SPDX-FileCopyrightText: 2026 Dacely <business@dacely.com>
// SPDX-License-Identifier: LicenseRef-Proprietary

/** Private normalized bootstrap and physical envelope have independent finite parser budgets. */
export class ExecutionBootstrapLimits {
    /** Includes repeated pinned paths, escaped argv and complete resolved Machine/Pipe input. */
    public static readonly configurationBytes: number = 262144;

    /** The physical root/group wrapper adds at most 1024 bytes and never reaches the payload. */
    public static readonly launchBytes: number = 263168;

    /** Reject an oversized inner configuration before creating a native execution group. */
    public static configuration(serialized: string): void {
        if (Buffer.byteLength(serialized) > this.configurationBytes) {
            throw new Error('Execution bootstrap exceeds its limit');
        }
    }

    /** The outer parser has a separate finite budget, even when the inner configuration fits. */
    public static launch(serialized: string): void {
        if (Buffer.byteLength(serialized) > this.launchBytes) {
            throw new Error('Private execution bootstrap exceeds its bound');
        }
    }
}
