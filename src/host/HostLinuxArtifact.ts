// SPDX-FileCopyrightText: 2026 Dacely <business@dacely.com>
// SPDX-License-Identifier: LicenseRef-Proprietary

/** A bounded build pin commits the exact Linux helper used for full-host terminal execution. */
export interface HostLinuxArtifact {
    readonly bytes: number;
    readonly sha256: string;
}
