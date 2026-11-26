// SPDX-FileCopyrightText: 2026 Dacely <business@dacely.com>
// SPDX-License-Identifier: LicenseRef-Proprietary

/** Build-time compiler output is pinned by the standalone app; no program source arrives over stdin. */
export interface WindowsStateArtifact {
    readonly bytes: number;
    readonly sha256: string;
    readonly sourceSha256: string;
}
