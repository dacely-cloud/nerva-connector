// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

import type { ConnectorJointAdmission } from '../runtime/ConnectorJointAdmission.js';
import type { ConnectorClientIdentity } from '../runtime/ConnectorClientConfiguration.js';
import type { ConnectorFilePermit } from 'nerva-connector-protocol/protocol/ConnectorFileJobs.js';
import { ConnectorFilesCodec } from 'nerva-connector-protocol/protocol/ConnectorFilesCodec.js';
import { ConnectorFileMode } from 'nerva-connector-protocol/protocol/ConnectorFiles.js';
import {
    ConnectorAuthorizationKind,
    type ConnectorAuthorization,
} from 'nerva-connector-protocol/protocol/ConnectorAuthorization.js';
import type {
    ExecutionPermit,
    ExecutionRootGrant,
    ExecutionProgramGrant,
} from '../execution/ExecutionJobs.js';
import { ExecutionWorkspaceAccess } from '../execution/ExecutionTypes.js';
import type {
    ConnectorFileWorkspaceSource,
    ConnectorExecutionWorkspaceSource,
} from './ConnectorWorkspaceSource.js';
import type {
    JointWorkspaceDescriptor,
    JointWorkspaceBinding,
} from 'nerva-connector-protocol/workspace/JointWorkspaceBinding.js';
import { JointWorkspaceProof } from './JointWorkspaceProof.js';
import type { JointWorkspaceDelivery } from './JointWorkspaceDelivery.js';

/** Fresh effects use the same opened capabilities that produced the installed, currently accepted metadata. */
export class JointWorkspaceAdmission implements ConnectorJointAdmission {
    readonly #bindings: ReadonlyMap<string, JointWorkspaceDescriptor>;

    /** Borrowers must remain live; this guard owns neither their descriptors nor their disposal. */
    public constructor(
        public readonly identity: ConnectorClientIdentity,
        public readonly files: ConnectorFileWorkspaceSource,
        public readonly commands: ConnectorExecutionWorkspaceSource,
        public readonly delivery: JointWorkspaceDelivery,
        bindings: readonly JointWorkspaceDescriptor[],
    ) {
        if (bindings.length === 0 || bindings.length > 128) {
            throw new Error('Explicit bounded joint admission bindings required');
        }
        this.#bindings = new Map(
            bindings.map(
                (value: JointWorkspaceDescriptor): readonly [string, JointWorkspaceDescriptor] => [
                    JointWorkspaceProof.bindingSha256(value.binding),
                    value,
                ],
            ),
        );
    }

    /** A file request cannot use a command alias, another policy or a read-only joint binding for mutation. */
    public file(permit: ConnectorFilePermit): Promise<void> {
        return Promise.try((): void => {
            const binding: JointWorkspaceBinding = this.#binding(
                permit.authorization,
                permit.leaseId,
            );
            if (
                permit.request.rootId !== binding.fileRootId ||
                permit.request.policySha256 !== binding.filePolicySha256 ||
                (ConnectorFilesCodec.isMutation(permit.request.action) &&
                    binding.access !== ConnectorFileMode.ReadWrite)
            ) {
                throw new Error(
                    'Fresh joint file authority does not match its installed workspace',
                );
            }
        });
    }

    /** This authorizes only a fresh start under the fixed local program/root grants; signed cancellation is a separate original-only path. */
    public execution(permit: ExecutionPermit): Promise<void> {
        return Promise.try((): void => {
            const binding: JointWorkspaceBinding = this.#binding(
                permit.authorization,
                permit.leaseId,
            );
            const program: ExecutionProgramGrant | undefined = this.commands.profile.programs.find(
                (value: ExecutionProgramGrant): boolean => value.id === permit.request.programId,
            );
            if (
                permit.request.rootId !== binding.executionRootId ||
                permit.request.policySha256 !== binding.executionPolicySha256 ||
                program === undefined ||
                !program.rootIds.includes(binding.executionRootId)
            ) {
                throw new Error(
                    'Fresh joint command authority does not match its installed workspace',
                );
            }
        });
    }

    #binding(authorization: ConnectorAuthorization, leaseId: string): JointWorkspaceBinding {
        this.delivery.assertLease(leaseId);
        if (
            authorization.kind !== ConnectorAuthorizationKind.Joint ||
            !JointWorkspaceProof.verify(
                {
                    authorityId: this.identity.authority.authorityId,
                    environmentId: this.identity.settings.environmentId,
                    enrollmentId: this.identity.settings.enrollmentId,
                    devicePublicKey: this.identity.publicKey,
                },
                authorization.binding,
            )
        ) {
            throw new Error('Fresh joint descriptor proof denied');
        }
        const binding: JointWorkspaceBinding = authorization.binding.binding;
        const original: JointWorkspaceDescriptor | undefined = this.#bindings.get(
            JointWorkspaceProof.bindingSha256(binding),
        );
        const access: ExecutionWorkspaceAccess =
            binding.access === ConnectorFileMode.ReadOnly
                ? ExecutionWorkspaceAccess.ReadOnly
                : ExecutionWorkspaceAccess.ReadWrite;
        const root: ExecutionRootGrant | undefined = this.commands.profile.roots.find(
            (value: ExecutionRootGrant): boolean => value.id === binding.executionRootId,
        );
        if (
            original === undefined ||
            binding.fileJournalId !== this.files.journalId ||
            binding.executionJournals.first !== this.commands.journals.first ||
            binding.executionJournals.second !== this.commands.journals.second ||
            binding.filePolicySha256 !== this.files.profile.policySha256 ||
            binding.executionPolicySha256 !== this.commands.profile.policySha256 ||
            binding.executionPolicySha256 !== this.commands.policy.policySha256 ||
            binding.access !== this.files.profile.mode ||
            !this.files.profile.roots.includes(binding.fileRootId) ||
            root === undefined ||
            root.access !== access
        ) {
            throw new Error('Fresh joint capabilities changed after their physical capture');
        }
        return binding;
    }
}
