// SPDX-FileCopyrightText: 2026 Dacely <business@dacely.com>
// SPDX-License-Identifier: LicenseRef-Proprietary

/** Transport state is distinct from an individual authorized file operation's outcome. */
export enum ConnectorClientState {
    Connecting = 'connecting',
    Authenticated = 'authenticated',
    Disconnected = 'disconnected',
    Revoked = 'revoked',
    Stopped = 'stopped',
}
