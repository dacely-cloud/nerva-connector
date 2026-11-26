// SPDX-FileCopyrightText: 2026 Dacely <business@dacely.com>
// SPDX-License-Identifier: LicenseRef-Proprietary

import type { ConnectorClientIdentity } from './ConnectorClientConfiguration.js';
import {
    ConnectorAuthorizationKind,
    type ConnectorAuthorization,
    type ConnectorJointAuthorization,
} from 'nerva-connector-protocol/protocol/ConnectorAuthorization.js';
import type { ConnectorFilePermit } from 'nerva-connector-protocol/protocol/ConnectorFileJobs.js';
import {
    type ExecutionPermit,
    type ExecutionCancellation,
} from 'nerva-connector-protocol/execution/ExecutionJobs.js';
import { ExecutionLane } from 'nerva-connector-protocol/execution/ExecutionLane.js';
import { JointWorkspaceProof } from 'nerva-connector-protocol/workspace/JointWorkspaceProof.js';
import { SigningKey } from '../identity/SigningKey.js';

/** Immutable original proof verification never reads a current metadata head or substitutes newly captured physical authority. */
export class ConnectorOperationAuthorization {
    /** The original file root, policy and permanent file journal must match their signed enrolled-device descriptor. */
    public static file(
        identity: ConnectorClientIdentity,
        journalId: string,
        permit: ConnectorFilePermit,
    ): void {
        const joint: ConnectorJointAuthorization | null = this.#joint(
            identity,
            permit.authorization,
        );
        if (
            joint !== null &&
            (joint.binding.binding.fileJournalId !== journalId ||
                joint.binding.binding.fileRootId !== permit.request.rootId ||
                joint.binding.binding.filePolicySha256 !== permit.request.policySha256)
        ) {
            throw new Error('Original joint file authorization changed');
        }
    }

    /** Recovery and no-program cancellation remain bound to this actual lane journal without requiring a new current-ready grant. */
    public static execution(
        identity: ConnectorClientIdentity,
        journalId: string,
        permit: ExecutionPermit | ExecutionCancellation,
    ): void {
        const joint: ConnectorJointAuthorization | null = this.#joint(
            identity,
            permit.authorization,
        );
        if (joint !== null) {
            const originalId: string =
                permit.lane === ExecutionLane.First
                    ? joint.binding.binding.executionJournals.first
                    : joint.binding.binding.executionJournals.second;
            if (
                originalId !== journalId ||
                joint.binding.binding.executionRootId !== permit.request.rootId ||
                joint.binding.binding.executionPolicySha256 !== permit.request.policySha256
            ) {
                throw new Error('Original joint command authorization changed');
            }
        }
    }

    static #joint(
        identity: ConnectorClientIdentity,
        authorization: ConnectorAuthorization,
    ): ConnectorJointAuthorization | null {
        if (authorization.kind === ConnectorAuthorizationKind.Independent) {
            return null;
        }
        if (
            authorization.kind !== ConnectorAuthorizationKind.Joint ||
            !JointWorkspaceProof.verify(
                SigningKey,
                {
                    authorityId: identity.authority.authorityId,
                    environmentId: identity.settings.environmentId,
                    enrollmentId: identity.settings.enrollmentId,
                    devicePublicKey: identity.publicKey,
                },
                authorization.binding,
            )
        ) {
            throw new Error('Original joint descriptor proof denied');
        }
        return authorization;
    }
}
