// SPDX-FileCopyrightText: 2026 Dacely <business@dacely.com>
// SPDX-License-Identifier: LicenseRef-Proprietary

/** One fixed internal downloader accepts no headers, credentials, redirects or executable actions. */
export interface WindowsUpdateFetchRequest {
    readonly address: string;
    readonly destination: string;
    readonly maximumBytes: string;
    readonly timeoutMs: number;
}

/** The supervisor independently verifies the signed feed and installer after this transport receipt. */
export interface WindowsUpdateFetchReceipt {
    readonly bytes: string;
    readonly protocol: typeof WindowsUpdateFetchProtocol.tls;
}

/** Shared finite limits apply before any request or owned download file is created. */
export class WindowsUpdateFetchProtocol {
    /** Installed Windows updates require TLS 1.3 with normal server certificate and hostname checks. */
    public static readonly tls = 'TLSv1.3';
    /** One bounded local request carries only paths, a byte bound and a deadline. */
    public static readonly requestBytes: number = 16384;
    /** Matches the supervisor's existing maximum signed Windows setup size. */
    public static readonly maximumBytes: bigint = 268435456n;
    /** The supervisor retains its existing ten-minute installer deadline. */
    public static readonly maximumTimeoutMs: number = 600000;
}
