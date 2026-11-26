// SPDX-FileCopyrightText: 2026 Dacely <business@dacely.com>
// SPDX-License-Identifier: LicenseRef-Proprietary

import { join } from 'node:path';
import { ProtectedFiles } from '../local/ProtectedFiles.js';
import type { ConnectorClientIdentity } from '../runtime/ConnectorClientConfiguration.js';
import { ExecutionPolicy } from './ExecutionPolicy.js';
import { ExecutionJobsCodec } from './ExecutionJobsCodec.js';
import type { ExecutionClientSettings } from './ExecutionClientSettings.js';
import type { ConnectorLocalCapabilitySettings } from '../runtime/ConnectorClientSettings.js';
import { ExecutionPolicyCodec } from './ExecutionPolicyCodec.js';
import type { ExecutionPolicyDefinition } from 'nerva-connector-protocol/execution/ExecutionPolicyTypes.js';
import { ConnectorFilePolicy } from '../runtime/ConnectorFilePolicy.js';
import { JointWorkspaceConfiguration } from '../workspace/JointWorkspaceConfiguration.js';
import { ConnectorHostGrant } from '../runtime/ConnectorHostGrant.js';

/** Local configuration resolves only operator-provisioned paths and excludes all capability journals from workspace access. */
export class ExecutionConfiguration {
    /** File grants must not expose command policy, state, runtime code, helpers or cgroup authority. */
    public static async protectedPaths(
        settings: ConnectorLocalCapabilitySettings,
    ): Promise<readonly string[]> {
        const bytes: Buffer = await ProtectedFiles.readPrivate(settings.policyFile, 65536);
        try {
            const raw: unknown = JSON.parse(
                new TextDecoder('utf-8', { fatal: true }).decode(bytes),
            );
            const policy: ExecutionPolicyDefinition = ExecutionPolicyCodec.policy(raw);
            return [
                settings.policyFile,
                settings.stateDirectory,
                policy.runtimeDirectory,
                policy.trampolineFile,
                policy.bubblewrapFile,
                policy.cgroupRoot,
            ];
        } finally {
            bytes.fill(0);
        }
    }
    /** Runtime and installer share exact private-path and capability validation. */
    public static async loadPolicy(
        identity: ConnectorClientIdentity,
        settings: ExecutionClientSettings,
    ): Promise<ExecutionPolicy> {
        if (identity.settings.slot !== 0) {
            throw new Error('Execution requires the dedicated command slot');
        }
        ProtectedFiles.path(settings.policyFile);
        ExecutionJobsCodec.lane(settings.lane);
        ProtectedFiles.path(settings.stateDirectory);
        const workspace: ReturnType<typeof JointWorkspaceConfiguration.paths> =
            JointWorkspaceConfiguration.paths(identity.settings.privateKeyFile);
        return await ExecutionPolicy.load(settings.policyFile, [
            ConnectorHostGrant.directory(identity),
            workspace.configurationFile,
            workspace.stateDirectory,
            workspace.setupFile,
            identity.configurationFile,
            identity.settings.privateKeyFile,
            identity.settings.authorityPublicKeyFile,
            settings.stateDirectory,
            ...(identity.settings.files === null
                ? []
                : await ConnectorFilePolicy.protectedPaths(identity.settings.files)),
            ...(identity.settings.serverCaFile === null ? [] : [identity.settings.serverCaFile]),
        ]);
    }
    /** Fixed lane names derive private leaf paths; remote frames never supply a storage pathname. */
    public static journalDirectory(settings: ExecutionClientSettings): string {
        return join(settings.stateDirectory, ExecutionJobsCodec.lane(settings.lane));
    }
}
