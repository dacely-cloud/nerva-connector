// SPDX-FileCopyrightText: 2026 Dacely <business@dacely.com>
// SPDX-License-Identifier: LicenseRef-Proprietary

import type { ConnectorClientSession } from '../runtime/ConnectorClientSession.js';
import type { ConnectorClientFrame } from '../protocol/ConnectorTransport.js';

/** A current socket can deliver bytes only while its independently verified session remains attached. */
export interface ExecutionDeliveryLink {
    readonly session: ConnectorClientSession;
    readonly leaseId: string;
    readonly send: (frame: ConnectorClientFrame) => void;
    readonly close: () => void;
}
