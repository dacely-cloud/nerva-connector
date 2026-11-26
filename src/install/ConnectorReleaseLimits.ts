// SPDX-FileCopyrightText: 2026 Dacely <business@dacely.com>
// SPDX-License-Identifier: LicenseRef-Proprietary

/** One finite application bound is shared by the source builder and signed-release installer. */
export class ConnectorReleaseLimits {
    /** Finite 832 KiB budget includes first-run setup, host MCP and the connection log; native helpers and the process worker remain separate signed assets. */
    public static readonly applicationBytes: number = 851968;
}
