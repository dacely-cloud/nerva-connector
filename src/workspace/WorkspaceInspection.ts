// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

import type { ConnectorFileMode } from 'nerva-connector-protocol/protocol/ConnectorFiles.js';
import type { WorkspaceDirectoryInspection } from './WorkspaceDirectoryInspection.js';

/** Policy-owned descriptors are borrowed only until the awaited inspection callback finishes. */
export interface WorkspaceInspection extends WorkspaceDirectoryInspection {
    readonly access: ConnectorFileMode;
}
