// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

/** Private state keeps its ordinary ceiling; only the reserved encrypted host receipt has a larger finite allocation. */
export class ProtectedFileLimits {
    /** Keys, configuration and other existing private records retain their one MiB ceiling. */
    public static readonly ordinaryBytes: number = 1048576;
    /** One complete request and a maximally escaped one MiB response fit the host journal without truncation. */
    public static readonly hostPlainBytes: number = 3145728;
    /** Base64url AES-GCM storage includes the three MiB plaintext ceiling and finite encryption metadata. */
    public static readonly hostRecordBytes: number = 4259840;
    /** Canonical base64 carries the encrypted record through the local native pipe with metadata headroom. */
    public static readonly nativeFrameBytes: number = 6291456;
    /** Only this named owned leaf and its interrupted atomic publication receive the larger record budget. */
    public static maximum(name: string): number {
        return name === 'host-journal' || name === 'host-journal.partial'
            ? this.hostRecordBytes
            : this.ordinaryBytes;
    }
}
