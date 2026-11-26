// SPDX-FileCopyrightText: 2026 Dacely <business@dacely.com>
// SPDX-License-Identifier: LicenseRef-Proprietary

import type { ConnectorHostProfile } from 'nerva-connector-protocol/protocol/ConnectorHost.js';

/** A signed local grant binds one enrolled account device and its permanent host journal. */
export interface ConnectorHostLocalGrant {
    readonly authorityId: string;
    readonly environmentId: string;
    readonly enrollmentId: string;
    readonly journalId: string;
    readonly journalInitialized: boolean;
    readonly profile: ConnectorHostProfile;
    readonly signature: string;
}
