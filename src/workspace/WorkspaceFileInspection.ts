// SPDX-FileCopyrightText: 2026 Dacely <business@dacely.com>
// SPDX-License-Identifier: LicenseRef-Proprietary

import type { WorkspaceDirectoryInspection } from './WorkspaceDirectoryInspection.js';

/** The policy owner lends these fixed descriptors until its capture child has actually closed. */
export interface WorkspaceFileInspection extends WorkspaceDirectoryInspection {
    readonly stagingDescriptor: number | null;
}
