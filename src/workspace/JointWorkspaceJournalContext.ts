// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

import { createHash } from 'node:crypto';
import { SigningKey } from '../identity/SigningKey.js';
import { Boundary } from 'nerva-connector-protocol/protocol/Boundary.js';
import { ConnectorEnrollmentCodec } from 'nerva-connector-protocol/protocol/ConnectorEnrollmentCodec.js';
import type {
    JointWorkspaceDescriptor,
    JointWorkspaceScope,
} from 'nerva-connector-protocol/workspace/JointWorkspaceBinding.js';
import { JointWorkspaceCodec } from 'nerva-connector-protocol/workspace/JointWorkspaceCodec.js';
import { JointWorkspaceProof } from 'nerva-connector-protocol/workspace/JointWorkspaceProof.js';
import type { JointWorkspaceJournalIdentity } from './JointWorkspaceJournalTypes.js';
import type {
    JointWorkspacePublicationExpected,
    JointWorkspacePublication,
} from 'nerva-connector-protocol/workspace/JointWorkspacePublication.js';
import { JointWorkspacePublicationProof } from 'nerva-connector-protocol/workspace/JointWorkspacePublicationProof.js';

/** Validated public installation context is immutable and supplies all cryptographic expected identities. */
export class JointWorkspaceJournalContext {
    public readonly identity: JointWorkspaceJournalIdentity;
    public readonly digest: string;
    public readonly scope: JointWorkspaceScope;

    public constructor(value: JointWorkspaceJournalIdentity, key: SigningKey) {
        Boundary.record(value, ['scope', 'fileJournalId', 'executionJournals']);
        const fileJournalId: string = ConnectorEnrollmentCodec.digest(value.fileJournalId);
        this.identity = Object.freeze({
            scope: JointWorkspaceCodec.physicalScope(value.scope),
            fileJournalId,
            executionJournals: JointWorkspaceCodec.journals(value.executionJournals),
        });
        if (
            this.identity.scope.devicePublicKey !== key.publicKey ||
            fileJournalId === this.identity.executionJournals.first ||
            fileJournalId === this.identity.executionJournals.second
        ) {
            throw new Error(
                'Joint workspace installation identity or permanent journals do not match',
            );
        }
        this.scope = JointWorkspaceCodec.scope({
            authorityId: this.identity.scope.authorityId,
            environmentId: this.identity.scope.environmentId,
            enrollmentId: this.identity.scope.enrollmentId,
            devicePublicKey: this.identity.scope.devicePublicKey,
        });
        this.digest = createHash('sha256').update(JSON.stringify(this.identity)).digest('hex');
    }

    /** Immutable descriptors must authenticate under the installed device and all three permanent journal identities. */
    public descriptor(value: JointWorkspaceDescriptor): JointWorkspaceDescriptor {
        const descriptor: JointWorkspaceDescriptor = JointWorkspaceCodec.descriptorValue(value);
        if (
            !JointWorkspaceProof.verify(SigningKey, this.scope, descriptor) ||
            descriptor.binding.fileJournalId !== this.identity.fileJournalId ||
            descriptor.binding.executionJournals.first !== this.identity.executionJournals.first ||
            descriptor.binding.executionJournals.second !== this.identity.executionJournals.second
        ) {
            throw new Error('Joint workspace descriptor does not match this installation');
        }
        return descriptor;
    }

    /** Lease scope comes from the retained publication, while its expected authority and registered device remain installation-owned. */
    public publication(value: JointWorkspacePublication): JointWorkspacePublicationExpected {
        const expected: JointWorkspacePublicationExpected = {
            ...this.scope,
            slot: 0,
            leaseId: value.leaseId,
        };
        if (!JointWorkspacePublicationProof.verify(SigningKey, expected, value)) {
            throw new Error(
                'Joint workspace publication does not authenticate under this installation',
            );
        }
        this.descriptor(value.descriptor);
        return expected;
    }
}
