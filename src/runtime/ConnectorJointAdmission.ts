// SPDX-FileCopyrightText: 2026 Dacely <business@dacely.com>
// SPDX-License-Identifier: LicenseRef-Proprietary

import type { ConnectorFilePermit } from 'nerva-connector-protocol/protocol/ConnectorFileJobs.js';
import type { ExecutionPermit } from 'nerva-connector-protocol/execution/ExecutionJobs.js';

/** One existing metadata owner checks current lease readiness and the same borrowed capabilities before a fresh joint effect. */
export interface ConnectorJointAdmission {
    /** Reads and mutations must name the exact currently active installed file binding. */
    file(permit: ConnectorFilePermit): Promise<void>;
    /** Only a new program start needs current activation; original cancellation and recovery cannot launch a program. */
    execution(permit: ExecutionPermit): Promise<void>;
}
