// SPDX-FileCopyrightText: 2026 Dacely <business@dacely.com>
// SPDX-License-Identifier: LicenseRef-Proprietary

import type { ExecutionLane } from 'nerva-connector-protocol/execution/ExecutionLane.js';

/** Trusted local installation chooses these private paths; a remote frame never supplies them. */
export interface ExecutionClientSettings {
    readonly lane: ExecutionLane;
    readonly policyFile: string;
    readonly stateDirectory: string;
}
