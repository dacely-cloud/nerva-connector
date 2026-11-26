// SPDX-FileCopyrightText: 2026 Dacely <business@dacely.com>
// SPDX-License-Identifier: LicenseRef-Proprietary

/** Signed product separation prevents another operating system's feed from authorizing code here. */
export const ConnectorUpdatePlatform = { Linux: 'linux', Mac: 'darwin' } as const;
/** Supported native updater operating systems. */
export type ConnectorUpdatePlatform =
    (typeof ConnectorUpdatePlatform)[keyof typeof ConnectorUpdatePlatform];
/** Processor names used by the signed download catalog. */
export const ConnectorUpdateArchitecture = { X64: 'x64', Arm64: 'arm64' } as const;
/** Supported native processor names. */
export type ConnectorUpdateArchitecture =
    (typeof ConnectorUpdateArchitecture)[keyof typeof ConnectorUpdateArchitecture];
/** One exact, bounded installer authorized by the release key. */
export interface ConnectorUpdateArtifact {
    readonly name: string;
    readonly size: bigint;
    readonly sha256: string;
}
/** A verified newer version and its installer for this machine. */
export interface ConnectorUpdateRelease {
    readonly version: string;
    readonly artifact: ConnectorUpdateArtifact;
}
/** Public authority and native swap helper commitments embedded in the standalone supervisor. */
export interface ConnectorUpdateSettings {
    readonly version: string;
    readonly platform: ConnectorUpdatePlatform;
    readonly architecture: ConnectorUpdateArchitecture;
    readonly feedUrl: string;
    readonly publicKey: string;
    readonly helperSha256: string;
    readonly files: readonly string[];
}
/** One architecture's finished installer supplied to the offline release signer. */
export interface ConnectorUpdateSetup {
    readonly architecture: ConnectorUpdateArchitecture;
    readonly path: string;
}
