// SPDX-FileCopyrightText: 2026 Dacely <business@dacely.com>
// SPDX-License-Identifier: LicenseRef-Proprietary

/** A native streamed artifact result contains exact byte size and its complete SHA-256 commitment. */
export interface WindowsStateArtifactMetadata {
    readonly sizeBytes: bigint;
    readonly sha256: string;
}
