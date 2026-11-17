// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

/** Transport state is distinct from an individual authorized file operation's outcome. */
export enum ConnectorClientState {
    Connecting = 'connecting',
    Authenticated = 'authenticated',
    Disconnected = 'disconnected',
    Stopped = 'stopped',
}
