// SPDX-FileCopyrightText: 2026 Dacely <business@dacely.com>
// SPDX-License-Identifier: LicenseRef-Proprietary

/** Release authorization cannot be mistaken for device enrollment or an execution policy. */
export enum ConnectorReleaseProtocol {
    Current = 'nerva-connector-release',
}
/** Only qualified native Node runtime architectures can be selected by a signed release. */
export enum ConnectorReleaseArchitecture {
    X64 = 'x64',
    Arm64 = 'arm64',
}
/** The signed operating system selects one complete artifact set; it is never inferred from a downloaded runtime. */
export const ConnectorReleasePlatform = { Linux: 'linux', Windows: 'win32' } as const;
/** Runtime-accessible operating-system values are shared by signer, installer and package generator. */
export type ConnectorReleasePlatform =
    (typeof ConnectorReleasePlatform)[keyof typeof ConnectorReleasePlatform];
/** Fixed leaf names remove archive extraction and caller-controlled installation paths. */
export enum ConnectorReleaseFile {
    Application = 'nerva-connector.mjs',
    Runtime = 'node',
    WindowsRuntime = 'node.exe',
    License = 'NODE-LICENSE',
    Files = 'nerva-connector-files',
    Execution = 'nerva-connector-exec',
    Notices = 'THIRD-PARTY-NOTICES.txt',
    HostWorker = 'nerva-connector-host-worker.mjs',
    WindowsState = 'nerva-connector-state.exe',
    WindowsStateMetadata = 'nerva-connector-state.json',
    WindowsHost = 'nerva-connector-host.exe',
    WindowsHostMetadata = 'nerva-connector-host.json',
}
/** Exact file size and SHA-256 commit every installed byte. */
export interface ConnectorReleaseArtifact {
    readonly name: ConnectorReleaseFile;
    readonly sizeBytes: bigint;
    readonly sha256: string;
}
/** Installation supplies public trust automatically and grants no ambient file or program access. */
export interface ConnectorReleaseDeployment {
    readonly authorityId: string;
    readonly publicKey: string;
    readonly endpoints: readonly string[];
    readonly verificationUri: string;
    readonly serverCaPem: string | null;
}
/** One finite platform release includes its standalone runtime and license, never installed dependency trees. */
export interface ConnectorReleaseManifest {
    readonly protocol: ConnectorReleaseProtocol.Current;
    readonly releaseId: string;
    readonly revision: bigint;
    readonly issuedAtMs: bigint;
    readonly expiresAtMs: bigint;
    readonly platform: ConnectorReleasePlatform;
    readonly architecture: ConnectorReleaseArchitecture;
    readonly artifacts: readonly ConnectorReleaseArtifact[];
    readonly deployment: ConnectorReleaseDeployment;
}
/** Both signature components authorize the same canonical release and public deployment configuration. */
export interface ConnectorSignedRelease {
    readonly manifest: ConnectorReleaseManifest;
    readonly signature: string;
}
