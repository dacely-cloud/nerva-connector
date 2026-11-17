// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

import { createHash, randomUUID } from 'node:crypto';
import { SigningKey } from '../../src/identity/SigningKey.js';
import { ExecutionLane } from 'nerva-connector-protocol/execution/ExecutionLane.js';
import {
    ConnectorMigrationLane,
    type ConnectorMigrationAdmission,
    type ConnectorMigrationApproval,
    type ConnectorMigrationAuthorization,
    type ConnectorMigrationExpected,
    type ConnectorMigrationOriginal,
    type ConnectorMigrationPlan,
    type ConnectorMigrationSource,
} from 'nerva-connector-protocol/protocol/ConnectorAdmissionMigration.js';
import { ConnectorAdmissionMigrationProof } from '../../src/protocol/ConnectorAdmissionMigrationProof.js';
import {
    ConnectorAuthorizationKind,
    type ConnectorAuthorization,
} from 'nerva-connector-protocol/protocol/ConnectorAuthorization.js';
import { ConnectorAuthorizationProof } from '../../src/protocol/ConnectorAuthorizationProof.js';
import type { ConnectorClientIdentity } from '../../src/runtime/ConnectorClientConfiguration.js';
import { ConnectorMigrationPreparation } from '../../src/runtime/ConnectorMigrationPreparation.js';

/** Test-only authority approval of real stopped histories; synthetic fences do not qualify backend fencing. */
export class RuntimeMigrationApprovalFixture {
    /** Prepare before fault injection; callers retain the exact approval across interrupted conversion retries. */
    public static async prepare(
        identity: ConnectorClientIdentity,
        authority: SigningKey = identity.key,
        signal: AbortSignal = new AbortController().signal,
    ): Promise<ConnectorMigrationApproval> {
        const plan: ConnectorMigrationPlan = await ConnectorMigrationPreparation.run(
            identity.configurationFile,
            signal,
        );
        return this.approve(identity, plan, authority);
    }

    /** Only a test-owned key matching the independently pinned authority can certify the prepared originals. */
    public static approve(
        identity: ConnectorClientIdentity,
        plan: ConnectorMigrationPlan,
        authority: SigningKey = identity.key,
    ): ConnectorMigrationApproval {
        if (authority.publicKey !== identity.authority.publicKey) {
            throw new Error('Migration fixture requires its test-owned authority key');
        }
        const expected: ConnectorMigrationExpected = {
            authorityId: identity.authority.authorityId,
            authorityPublicKey: identity.authority.publicKey,
            environmentId: identity.settings.environmentId,
            enrollmentId: identity.settings.enrollmentId,
            devicePublicKey: identity.publicKey,
        };
        return ConnectorAdmissionMigrationProof.signApproval(authority, expected, {
            plan,
            fenceId: 'test-only-fence-' + randomUUID(),
            authorizations: plan.sources.map(
                (source: ConnectorMigrationSource): ConnectorMigrationAuthorization => ({
                    lane: source.lane,
                    backendSourceSha256: createHash('sha256')
                        .update('TEST-ONLY: no backend fencing proof:')
                        .update(plan.planId)
                        .update(source.lane)
                        .update(source.sourceSha256)
                        .digest('hex'),
                    receipt: this.#admission(source.lane, source.receipt),
                    pending: this.#admission(source.lane, source.pending),
                }),
            ),
        });
    }

    static #admission(
        lane: ConnectorMigrationLane,
        original: ConnectorMigrationOriginal | null,
    ): ConnectorMigrationAdmission | null {
        if (original === null) {
            return null;
        }
        const authorization: ConnectorAuthorization = {
            kind: ConnectorAuthorizationKind.Independent,
        };
        return {
            authorization,
            admissionHash:
                lane === ConnectorMigrationLane.Files
                    ? ConnectorAuthorizationProof.file(original.requestHash, authorization)
                    : ConnectorAuthorizationProof.execution(
                          original.requestHash,
                          lane === ConnectorMigrationLane.ExecutionFirst
                              ? ExecutionLane.First
                              : ExecutionLane.Second,
                          authorization,
                      ),
        };
    }
}
