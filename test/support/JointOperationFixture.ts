// SPDX-FileCopyrightText: 2026 Dacely <business@dacely.com>
// SPDX-License-Identifier: LicenseRef-Proprietary

import type { CapturedEffectsFixture } from './CapturedEffectsFixture.js';
import type { ConnectorClientIdentity } from '../../src/runtime/ConnectorClientConfiguration.js';
import { ConnectorFileProof } from 'nerva-connector-protocol/protocol/ConnectorFileProof.js';
import type { ConnectorFilePermit } from 'nerva-connector-protocol/protocol/ConnectorFileJobs.js';
import type { ConnectorAuthorization } from 'nerva-connector-protocol/protocol/ConnectorAuthorization.js';
import { ConnectorAuthorizationProof } from 'nerva-connector-protocol/protocol/ConnectorAuthorizationProof.js';
import { SignaturePurpose } from 'nerva-connector-protocol/identity/IdentityFormat.js';
import { ConnectorFileMode } from 'nerva-connector-protocol/protocol/ConnectorFiles.js';
import type { JointWorkspaceBinding } from 'nerva-connector-protocol/workspace/JointWorkspaceBinding.js';

/** Synthetic joint metadata qualifies original proof/refusal/recovery boundaries, never current native compound authorization. */
export class JointOperationFixture {
    /** Real enrolled scope and selected journals are combined with explicitly synthetic physical metadata. */
    public static body(
        identity: ConnectorClientIdentity,
        filePolicySha256: string,
        fileJournalId: string,
        executionPolicySha256: string,
        firstJournalId: string,
    ): JointWorkspaceBinding {
        return {
            authorityId: identity.authority.authorityId,
            environmentId: identity.settings.environmentId,
            enrollmentId: identity.settings.enrollmentId,
            revision: 1n,
            filePolicySha256,
            executionPolicySha256,
            fileRootId: 'project',
            executionRootId: 'project',
            access: ConnectorFileMode.ReadWrite,
            physicalRootCommitment: 'b'.repeat(64),
            fileJournalId,
            executionJournals: { first: firstJournalId, second: 'd'.repeat(64) },
        };
    }

    /** A genuine fixture backend proof binds even deliberately invalid device descriptors for independent boundary checks. */
    public static filePermit(
        fixture: CapturedEffectsFixture,
        authorization: ConnectorAuthorization,
    ): ConnectorFilePermit {
        const original: ConnectorFilePermit = fixture.permit();
        const permit: ConnectorFilePermit = {
            ...original,
            authorization,
            admissionHash: ConnectorAuthorizationProof.file(original.requestHash, authorization),
        };
        return {
            ...permit,
            signature: ConnectorFileProof.sign(
                fixture.history.identity.key,
                SignaturePurpose.OperationFilePermit,
                ConnectorFileProof.permit(permit),
            ),
        };
    }
}
