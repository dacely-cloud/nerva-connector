// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

/** Native operating systems supported by the standalone desktop installers. */
export const ConnectorPosixPlatform = { Linux: 'linux', Mac: 'darwin' } as const;
/** Values accepted by the native installer builders. */
export type ConnectorPosixPlatform =
    (typeof ConnectorPosixPlatform)[keyof typeof ConnectorPosixPlatform];

/** Native processor architectures supported by the bundled Node runtime. */
export const ConnectorPosixArchitecture = { X64: 'x64', Arm64: 'arm64' } as const;
/** A package always targets its builder's native architecture. */
export type ConnectorPosixArchitecture =
    (typeof ConnectorPosixArchitecture)[keyof typeof ConnectorPosixArchitecture];
