// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

/** Transport-specific chunk bounds preserve the same file and process semantics across stdio and paired delivery. */
export interface HostMcpWorkspaceBounds {
    readonly maximumChunkBytes: number;
    readonly defaultChunkBytes: number;
    readonly maximumDirectoryEntries: number;
    /** Paired envelopes may use base64 for text whose JSON escaping is larger than the byte representation. */
    readonly compactEncodedBytes?: boolean;
}
