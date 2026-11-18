// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

import { expect, it } from 'vitest';
import { AdmissionMigrationFixture } from './support/AdmissionMigrationFixture.js';
import { ConnectorAdmissionMigrationProof as Proof } from 'nerva-connector-protocol/protocol/ConnectorAdmissionMigrationProof.js';
import { SigningKey } from '../src/identity/SigningKey.js';
import { ConnectorMigrationPlanCodec } from 'nerva-connector-protocol/protocol/ConnectorMigrationPlanCodec.js';
import { ConnectorMigrationApprovalCodec } from 'nerva-connector-protocol/protocol/ConnectorMigrationApprovalCodec.js';
import {
    ConnectorMigrationLimits,
    type ConnectorMigrationPlanBody,
    type ConnectorMigrationSource,
    type ConnectorMigrationPlan,
    type ConnectorMigrationApproval,
} from 'nerva-connector-protocol/protocol/ConnectorAdmissionMigration.js';

it('all three largest original source headers fit their bounded plan without truncating identifiers or exact counters', (): void => {
    using fixture: AdmissionMigrationFixture = new AdmissionMigrationFixture();
    const body: ConnectorMigrationPlanBody = {
        ...fixture.planBody(),
        authorityId: 'a'.repeat(128),
        environmentId: 'e'.repeat(128),
        planId: 'p'.repeat(128),
        sources: fixture.plan.sources.map(
            (source: ConnectorMigrationSource): ConnectorMigrationSource => {
                if (source.receipt === null || source.pending === null) {
                    throw new Error('Both original correlations required');
                }
                return {
                    ...source,
                    acknowledgedSequence: 9223372036854775806n,
                    receipt: {
                        ...source.receipt,
                        jobId: 'r'.repeat(128),
                        sequence: 9223372036854775806n,
                    },
                    pending: {
                        ...source.pending,
                        jobId: 'p'.repeat(128),
                        sequence: 9223372036854775807n,
                    },
                };
            },
        ),
    };
    const measuredBytes: number = Buffer.byteLength(
        JSON.stringify(
            { ...body, signature: fixture.plan.signature },
            (_key: string, value: unknown): unknown =>
                typeof value === 'bigint' ? value.toString() : value,
        ),
    );
    expect(measuredBytes).toBe(8597);
    const plan: ConnectorMigrationPlan = Proof.signPlan(fixture.device, body);
    const json: string = ConnectorMigrationPlanCodec.encode(plan);
    expect(Buffer.byteLength(json)).toBeLessThanOrEqual(ConnectorMigrationLimits.planBytes);
    expect(ConnectorMigrationPlanCodec.decode(json)).toEqual(plan);
    expect(plan.sources[2]?.pending?.sequence).toBe(9223372036854775807n);
});

it('a complete three-source approval preserves six explicit full joint descriptors and both signature envelopes within its own budget', (): void => {
    using fixture: AdmissionMigrationFixture = new AdmissionMigrationFixture();
    const approval: ConnectorMigrationApproval = Proof.signApproval(
        SigningKey,
        fixture.authority,
        fixture.scope,
        fixture.approvalBody(fixture.plan, fixture.authorization),
    );
    const json: string = ConnectorMigrationApprovalCodec.encode(approval);
    expect(Buffer.byteLength(json)).toBeLessThanOrEqual(ConnectorMigrationLimits.approvalBytes);
    expect(ConnectorMigrationApprovalCodec.decode(json)).toEqual(approval);
    expect(approval.authorizations).toHaveLength(3);
    expect((): ConnectorMigrationApproval =>
        ConnectorMigrationApprovalCodec.decode(
            ' '.repeat(ConnectorMigrationLimits.approvalBytes + 1),
        ),
    ).toThrow();
});
