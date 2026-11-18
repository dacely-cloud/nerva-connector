// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

import type { SigningKey } from '../identity/SigningKey.js';
import { Boundary } from 'nerva-connector-protocol/protocol/Boundary.js';
import { ConnectorFileJobsCodec } from 'nerva-connector-protocol/protocol/ConnectorFileJobsCodec.js';
import type {
    ConnectorFileMode,
    ConnectorFileProfile,
} from 'nerva-connector-protocol/protocol/ConnectorFiles.js';
import { ExecutionJobsCodec } from '../execution/ExecutionJobsCodec.js';
import type {
    ExecutionProfile,
    ExecutionRootGrant,
} from 'nerva-connector-protocol/execution/ExecutionJobs.js';
import type { WorkspaceIdentity } from './WorkspaceIdentity.js';
import { WorkspaceIdentityCodec } from './WorkspaceIdentityCodec.js';
import { JointWorkspaceCommitment } from './JointWorkspaceCommitment.js';
import { JointWorkspaceProof } from 'nerva-connector-protocol/workspace/JointWorkspaceProof.js';
import { JointWorkspaceCodec } from 'nerva-connector-protocol/workspace/JointWorkspaceCodec.js';
import type {
    JointWorkspaceDescriptor,
    JointWorkspaceBinding,
    JointWorkspacePhysicalScope,
    JointWorkspaceExecutionJournals,
} from 'nerva-connector-protocol/workspace/JointWorkspaceBinding.js';

/** The local capture owner must keep both borrowed roots alive throughout assembly; this interface grants no new access. */
export interface JointWorkspaceCapturedRoot {
    readonly rootId: string;
    readonly access: ConnectorFileMode;
    readonly identity: WorkspaceIdentity;
}

/** Profiles and permanent journals come from existing retained owners, never a cloud-selected host pathname. */
export interface JointWorkspaceSources {
    readonly fileProfile: ConnectorFileProfile;
    readonly executionProfile: ExecutionProfile;
    readonly file: JointWorkspaceCapturedRoot;
    readonly execution: JointWorkspaceCapturedRoot;
    readonly fileJournalId: string;
    readonly executionJournals: JointWorkspaceExecutionJournals;
}

/** Assembly establishes one immutable signed claim; it does not publish grants, activate a Machine or authorize an operation. */
export class JointWorkspaceAssembly {
    /** Requiring both source profiles, captures and exact modes prevents alias-only or implicit write/execute equivalence. */
    public static create(
        key: SigningKey,
        input: JointWorkspacePhysicalScope,
        revision: bigint,
        sources: JointWorkspaceSources,
    ): JointWorkspaceDescriptor {
        const scope: JointWorkspacePhysicalScope = JointWorkspaceCodec.physicalScope(input);
        const file: ConnectorFileProfile = ConnectorFileJobsCodec.profile({
            ...sources.fileProfile,
            revision: this.#decimal(sources.fileProfile.revision),
        });
        const executionWire: unknown = JSON.parse(
            ExecutionJobsCodec.encode(sources.executionProfile),
        );
        const execution: ExecutionProfile = ExecutionJobsCodec.profile(executionWire);
        const fileRootId: string = Boundary.id(sources.file.rootId);
        const executionRootId: string = Boundary.id(sources.execution.rootId);
        const grant: ExecutionRootGrant | undefined = execution.roots.find(
            (root: ExecutionRootGrant): boolean => root.id === executionRootId,
        );
        const access: ConnectorFileMode = JointWorkspaceCodec.access(sources.file.access);
        if (
            !file.roots.includes(fileRootId) ||
            grant === undefined ||
            access !== file.mode ||
            JointWorkspaceCodec.access(sources.execution.access) !== access ||
            JointWorkspaceCodec.access(grant.access) !== access
        ) {
            throw new Error('Joint workspace source roots or explicit access do not match');
        }
        const fileIdentity: WorkspaceIdentity = WorkspaceIdentityCodec.value(sources.file.identity);
        const executionIdentity: WorkspaceIdentity = WorkspaceIdentityCodec.value(
            sources.execution.identity,
        );
        if (!WorkspaceIdentityCodec.same(fileIdentity, executionIdentity)) {
            throw new Error('Joint workspace roots identify different physical directories');
        }
        using commitment: JointWorkspaceCommitment = new JointWorkspaceCommitment(key, scope);
        const binding: JointWorkspaceBinding = JointWorkspaceCodec.bindingValue({
            authorityId: scope.authorityId,
            environmentId: scope.environmentId,
            enrollmentId: scope.enrollmentId,
            revision,
            filePolicySha256: file.policySha256,
            executionPolicySha256: execution.policySha256,
            fileRootId,
            executionRootId,
            access,
            physicalRootCommitment: commitment.commitment(fileIdentity),
            fileJournalId: sources.fileJournalId,
            executionJournals: JointWorkspaceCodec.journals(sources.executionJournals),
        });
        return JointWorkspaceProof.sign(key, binding);
    }

    static #decimal(value: bigint): string {
        if (typeof value !== 'bigint' || value < 0n || value > 9223372036854775807n) {
            throw new Error('Invalid exact source profile quantity');
        }
        return value.toString();
    }
}
