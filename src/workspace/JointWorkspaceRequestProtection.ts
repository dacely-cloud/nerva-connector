// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

import { resolve } from 'node:path';
import { ProtectedFiles } from '../local/ProtectedFiles.js';
import {
    ConnectorFilePolicy,
    type ConnectorFilePolicyDefinition,
} from '../runtime/ConnectorFilePolicy.js';
import type { ExecutionPolicy } from '../execution/ExecutionPolicy.js';
import type { ExecutionRootPolicy } from '../execution/ExecutionPolicyTypes.js';
import type { ConnectorFileRootPolicy } from '../runtime/ConnectorFileRoots.js';

/** The local approval request must remain outside existing customer data/staging grants rather than being editable by their tools. */
export class JointWorkspaceRequestProtection {
    public static async assert(
        inputFile: string,
        filePolicyFile: string,
        filePolicySha256: string,
        execution: ExecutionPolicy,
    ): Promise<void> {
        const path: string = ProtectedFiles.path(inputFile);
        if (resolve(path) !== path) {
            throw new Error('Canonical workspace approval input required');
        }
        const policy: ConnectorFilePolicyDefinition =
            await ConnectorFilePolicy.load(filePolicyFile);
        if (ConnectorFilePolicy.commitment(policy) !== filePolicySha256) {
            throw new Error('Workspace approval file policy changed');
        }
        const excluded: readonly string[] = [
            ...policy.roots.flatMap((root: ConnectorFileRootPolicy): readonly string[] =>
                root.stagingPath === null ? [root.path] : [root.path, root.stagingPath],
            ),
            ...execution.definition.roots.map((root: ExecutionRootPolicy): string => root.path),
        ];
        if (
            excluded.some((root: string): boolean => path === root || path.startsWith(root + '/'))
        ) {
            throw new Error('Workspace approval input overlaps an existing customer capability');
        }
    }
}
