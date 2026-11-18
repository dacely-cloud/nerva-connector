// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

import { expect, it } from 'vitest';
import { Boundary } from 'nerva-connector-protocol/protocol/Boundary.js';
import { AdmissionMigrationFixture } from './support/AdmissionMigrationFixture.js';
import { ConnectorAdmissionMigrationProof as Proof } from 'nerva-connector-protocol/protocol/ConnectorAdmissionMigrationProof.js';
import { ConnectorMigrationPlanCodec } from 'nerva-connector-protocol/protocol/ConnectorMigrationPlanCodec.js';
import { ConnectorMigrationApprovalCodec } from 'nerva-connector-protocol/protocol/ConnectorMigrationApprovalCodec.js';
import { ConnectorMigrationAppliedCodec } from 'nerva-connector-protocol/protocol/ConnectorMigrationAppliedCodec.js';
import {
    ConnectorMigrationLane,
    ConnectorMigrationLimits,
    type ConnectorMigrationPlan,
    type ConnectorMigrationApproval,
    type ConnectorMigrationApplied,
    type ConnectorMigrationAuthorization,
    type ConnectorMigrationSource,
    type ConnectorMigrationTarget,
} from 'nerva-connector-protocol/protocol/ConnectorAdmissionMigration.js';
import { SigningKey } from '../src/identity/SigningKey.js';
import {
    SignaturePurpose,
    IdentityLengths,
} from 'nerva-connector-protocol/identity/IdentityFormat.js';

it('all three exact original encrypted histories round trip through device plan, authority approval and device applied proofs', (): void => {
    using fixture: AdmissionMigrationFixture = new AdmissionMigrationFixture();
    const approval: ConnectorMigrationApproval = Proof.signApproval(
        SigningKey,
        fixture.authority,
        fixture.scope,
        fixture.approvalBody(),
    );
    const applied: ConnectorMigrationApplied = Proof.signApplied(
        SigningKey,
        fixture.device,
        fixture.scope,
        approval,
        fixture.appliedBody(approval),
    );
    expect(Proof.verifyPlan(SigningKey, fixture.scope, fixture.plan)).toBe(true);
    expect(Proof.verifyApproval(SigningKey, fixture.scope, fixture.plan, approval)).toBe(true);
    expect(Proof.verifyApplied(SigningKey, fixture.scope, approval, applied)).toBe(true);
    expect(
        ConnectorMigrationPlanCodec.decode(ConnectorMigrationPlanCodec.encode(fixture.plan)),
    ).toEqual(fixture.plan);
    expect(
        ConnectorMigrationApprovalCodec.decode(ConnectorMigrationApprovalCodec.encode(approval)),
    ).toEqual(approval);
    expect(
        ConnectorMigrationAppliedCodec.decode(ConnectorMigrationAppliedCodec.encode(applied)),
    ).toEqual(applied);
    expect(approval.plan.sources[0]?.acknowledgedSequence).toBe(9007199254740993n);
    expect(Object.isFrozen(approval.plan.sources)).toBe(true);
    expect(Object.isFrozen(approval.authorizations[0]?.pending?.authorization)).toBe(true);
    expect(Object.isFrozen(applied.targets)).toBe(true);
    expect(ConnectorMigrationApprovalCodec.encode(approval)).not.toContain('arguments');
    expect(ConnectorMigrationApprovalCodec.encode(approval)).not.toContain('dataBase64');
});

it('paired-only proofs retain exact device, authority and approval binding without manufacturing journal targets', (): void => {
    using fixture: AdmissionMigrationFixture = new AdmissionMigrationFixture();
    const plan: ConnectorMigrationPlan = Proof.signPlan(fixture.device, {
        ...fixture.planBody(),
        sources: [],
    });
    const approval: ConnectorMigrationApproval = Proof.signApproval(
        SigningKey,
        fixture.authority,
        fixture.scope,
        fixture.approvalBody(plan),
    );
    const applied: ConnectorMigrationApplied = Proof.signApplied(
        SigningKey,
        fixture.device,
        fixture.scope,
        approval,
        fixture.appliedBody(approval),
    );
    expect(approval.authorizations).toEqual([]);
    expect(applied.targets).toEqual([]);
    expect(ConnectorMigrationPlanCodec.decode(ConnectorMigrationPlanCodec.encode(plan))).toEqual(
        plan,
    );
    expect(
        ConnectorMigrationApprovalCodec.decode(ConnectorMigrationApprovalCodec.encode(approval)),
    ).toEqual(approval);
    expect(
        ConnectorMigrationAppliedCodec.decode(ConnectorMigrationAppliedCodec.encode(applied)),
    ).toEqual(applied);
    expect(Proof.verifyPlan(SigningKey, fixture.scope, plan)).toBe(true);
    expect(Proof.verifyPlan(SigningKey, fixture.scope, { ...fixture.plan, sources: [] })).toBe(
        false,
    );
    expect(Proof.verifyApproval(SigningKey, fixture.scope, plan, approval)).toBe(true);
    expect(Proof.verifyApplied(SigningKey, fixture.scope, approval, applied)).toBe(true);
    expect(Proof.verifyApproval(SigningKey, fixture.scope, fixture.plan, approval)).toBe(false);
    expect(
        Proof.verifyApplied(SigningKey, fixture.scope, approval, {
            ...applied,
            approvalSha256: '0'.repeat(64),
        }),
    ).toBe(false);
    const nonempty: ConnectorMigrationApproval = Proof.signApproval(
        SigningKey,
        fixture.authority,
        fixture.scope,
        fixture.approvalBody(),
    );
    expect((): ConnectorMigrationApplied =>
        Proof.signApplied(SigningKey, fixture.device, fixture.scope, nonempty, {
            ...fixture.appliedBody(nonempty),
            targets: [],
        }),
    ).toThrow();
});

it('either damaged hybrid component, a different enrolled device/authority, or a wrong signature purpose invalidates each migration step', (): void => {
    using fixture: AdmissionMigrationFixture = new AdmissionMigrationFixture();
    using foreign: SigningKey = SigningKey.generate();
    const approval: ConnectorMigrationApproval = Proof.signApproval(
        SigningKey,
        fixture.authority,
        fixture.scope,
        fixture.approvalBody(),
    );
    const applied: ConnectorMigrationApplied = Proof.signApplied(
        SigningKey,
        fixture.device,
        fixture.scope,
        approval,
        fixture.appliedBody(approval),
    );
    for (const offset of [0, IdentityLengths.mlDsaSignature]) {
        const damagedPlan: Buffer = Buffer.from(fixture.plan.signature, 'base64url');
        damagedPlan[offset] = (damagedPlan[offset] ?? 0) ^ 1;
        expect(
            Proof.verifyPlan(SigningKey, fixture.scope, {
                ...fixture.plan,
                signature: damagedPlan.toString('base64url'),
            }),
        ).toBe(false);
        const damagedApproval: Buffer = Buffer.from(approval.signature, 'base64url');
        damagedApproval[offset] = (damagedApproval[offset] ?? 0) ^ 1;
        expect(
            Proof.verifyApproval(SigningKey, fixture.scope, fixture.plan, {
                ...approval,
                signature: damagedApproval.toString('base64url'),
            }),
        ).toBe(false);
        const damagedApplied: Buffer = Buffer.from(applied.signature, 'base64url');
        damagedApplied[offset] = (damagedApplied[offset] ?? 0) ^ 1;
        expect(
            Proof.verifyApplied(SigningKey, fixture.scope, approval, {
                ...applied,
                signature: damagedApplied.toString('base64url'),
            }),
        ).toBe(false);
    }
    for (const scope of [
        { ...fixture.scope, authorityId: 'foreign-authority' },
        { ...fixture.scope, environmentId: 'foreign-environment' },
        { ...fixture.scope, enrollmentId: 'conn_' + 'b'.repeat(64) },
        { ...fixture.scope, devicePublicKey: foreign.publicKey },
        { ...fixture.scope, authorityPublicKey: foreign.publicKey },
    ]) {
        expect(Proof.verifyApproval(SigningKey, scope, fixture.plan, approval)).toBe(false);
        expect(Proof.verifyApplied(SigningKey, scope, approval, applied)).toBe(false);
    }
    expect(
        Proof.verifyPlan(SigningKey, fixture.scope, {
            ...fixture.plan,
            signature: fixture.device.sign(
                SignaturePurpose.AdmissionMigrationApplied,
                Proof.planPayload(fixture.planBody()),
            ),
        }),
    ).toBe(false);
    expect(
        Proof.verifyApproval(SigningKey, fixture.scope, fixture.plan, {
            ...approval,
            signature: fixture.authority.sign(
                SignaturePurpose.AdmissionMigrationPlan,
                Proof.approvalPayload(fixture.approvalBody()),
            ),
        }),
    ).toBe(false);
    expect(
        Proof.verifyApplied(SigningKey, fixture.scope, approval, {
            ...applied,
            signature: fixture.device.sign(
                SignaturePurpose.AdmissionMigrationPlan,
                Proof.appliedPayload(fixture.appliedBody(approval)),
            ),
        }),
    ).toBe(false);
    expect((): ConnectorMigrationPlan => Proof.signPlan(foreign, fixture.planBody())).toThrow();
    expect((): ConnectorMigrationApproval =>
        Proof.signApproval(SigningKey, foreign, fixture.scope, fixture.approvalBody()),
    ).toThrow();
    expect((): ConnectorMigrationApplied =>
        Proof.signApplied(
            SigningKey,
            foreign,
            fixture.scope,
            approval,
            fixture.appliedBody(approval),
        ),
    ).toThrow();
});

it('approval retains the entire original randomized plan proof and Applied binds the exact approval proof and every target', (): void => {
    using fixture: AdmissionMigrationFixture = new AdmissionMigrationFixture();
    const alternative: ConnectorMigrationPlan = Proof.signPlan(fixture.device, fixture.planBody());
    expect(Proof.verifyPlan(SigningKey, fixture.scope, alternative)).toBe(true);
    expect(alternative.signature).not.toBe(fixture.plan.signature);
    expect(Proof.planSha256(alternative)).not.toBe(Proof.planSha256(fixture.plan));
    const approval: ConnectorMigrationApproval = Proof.signApproval(
        SigningKey,
        fixture.authority,
        fixture.scope,
        fixture.approvalBody(),
    );
    const alternateApproval: ConnectorMigrationApproval = Proof.signApproval(
        SigningKey,
        fixture.authority,
        fixture.scope,
        fixture.approvalBody(alternative),
    );
    expect(Proof.verifyApproval(SigningKey, fixture.scope, fixture.plan, alternateApproval)).toBe(
        false,
    );
    expect(Proof.verifyApproval(SigningKey, fixture.scope, alternative, alternateApproval)).toBe(
        true,
    );
    const resigned: ConnectorMigrationApproval = Proof.signApproval(
        SigningKey,
        fixture.authority,
        fixture.scope,
        fixture.approvalBody(),
    );
    const applied: ConnectorMigrationApplied = Proof.signApplied(
        SigningKey,
        fixture.device,
        fixture.scope,
        approval,
        fixture.appliedBody(approval),
    );
    expect(Proof.approvalSha256(resigned)).not.toBe(Proof.approvalSha256(approval));
    expect(Proof.verifyApplied(SigningKey, fixture.scope, resigned, applied)).toBe(false);
    expect(
        Proof.verifyApplied(SigningKey, fixture.scope, approval, {
            ...applied,
            targets: applied.targets.slice(0, 2),
        }),
    ).toBe(false);
    expect(
        Proof.verifyApplied(SigningKey, fixture.scope, approval, {
            ...applied,
            planSha256: 'f'.repeat(64),
        }),
    ).toBe(false);
    expect(
        Proof.verifyApplied(SigningKey, fixture.scope, approval, {
            ...applied,
            targets: applied.targets.map(
                (target: ConnectorMigrationTarget): ConnectorMigrationTarget => ({
                    ...target,
                    cipherSha256: 'f'.repeat(64),
                }),
            ),
        }),
    ).toBe(false);
});

it('every receipt/pending authorization is explicit and the fixed receiver lane determines its semantic hash', (): void => {
    using fixture: AdmissionMigrationFixture = new AdmissionMigrationFixture();
    const entries: readonly ConnectorMigrationAuthorization[] =
        fixture.approvalBody().authorizations;
    const first: ConnectorMigrationAuthorization | undefined = entries[1];
    const second: ConnectorMigrationAuthorization | undefined = entries[2];
    if (first === undefined || second === undefined || first.pending === null) {
        throw new Error('Two nonempty command histories required');
    }
    expect((): ConnectorMigrationApproval =>
        Proof.signApproval(SigningKey, fixture.authority, fixture.scope, {
            ...fixture.approvalBody(),
            authorizations: [entries[0], first, { ...second, pending: first.pending }].filter(
                (
                    entry: ConnectorMigrationAuthorization | undefined,
                ): entry is ConnectorMigrationAuthorization => entry !== undefined,
            ),
        }),
    ).toThrow();
    const joint: ConnectorMigrationApproval = Proof.signApproval(
        SigningKey,
        fixture.authority,
        fixture.scope,
        fixture.approvalBody(fixture.plan, fixture.authorization),
    );
    expect(Proof.verifyApproval(SigningKey, fixture.scope, fixture.plan, joint)).toBe(true);
    const wrongJournalPlan: ConnectorMigrationPlan = Proof.signPlan(fixture.device, {
        ...fixture.planBody(),
        sources: fixture.plan.sources.map(
            (source: ConnectorMigrationSource): ConnectorMigrationSource =>
                source.lane === ConnectorMigrationLane.Files
                    ? { ...source, journalId: 'f'.repeat(64) }
                    : source,
        ),
    });
    expect((): ConnectorMigrationApproval =>
        Proof.signApproval(
            SigningKey,
            fixture.authority,
            fixture.scope,
            fixture.approvalBody(wrongJournalPlan, fixture.authorization),
        ),
    ).toThrow();
});

it('closed migration codecs reject plaintext additions, reordered/duplicate sources, imprecise quantities and incomplete authority', (): void => {
    using fixture: AdmissionMigrationFixture = new AdmissionMigrationFixture();
    const first: (typeof fixture.plan.sources)[number] | undefined = fixture.plan.sources[0];
    if (first === undefined || first.pending === null) {
        throw new Error('First source required');
    }
    const invalids: readonly unknown[] = [
        { ...fixture.plan, sources: [first, first] },
        { ...fixture.plan, sources: [...fixture.plan.sources].reverse() },
        { ...fixture.plan, sources: [{ ...first, receipt: null }] },
        {
            ...fixture.plan,
            sources: [{ ...first, pending: { ...first.pending, sequence: 9007199254740996n } }],
        },
        { ...fixture.plan, sources: [{ ...first, sourceSha256: 'unknown' }] },
        { ...fixture.plan, sources: [{ ...first, request: { arguments: ['secret'] } }] },
    ];
    for (const invalid of invalids) {
        expect((): ConnectorMigrationPlan => ConnectorMigrationPlanCodec.local(invalid)).toThrow();
    }
    const parsed: unknown = JSON.parse(ConnectorMigrationPlanCodec.encode(fixture.plan));
    const raw: Readonly<Record<string, unknown>> = Boundary.record(parsed, [
        'authorityId',
        'environmentId',
        'enrollmentId',
        'devicePublicKey',
        'planId',
        'targetOperationSchema',
        'sources',
        'signature',
    ]);
    expect((): ConnectorMigrationPlan =>
        ConnectorMigrationPlanCodec.read({ ...raw, targetOperationSchema: 'legacy' }),
    ).toThrow();
    expect((): ConnectorMigrationPlan =>
        ConnectorMigrationPlanCodec.read({ ...raw, sourceSha256: 'a'.repeat(64) }),
    ).toThrow();
    const approval: ConnectorMigrationApproval = Proof.signApproval(
        SigningKey,
        fixture.authority,
        fixture.scope,
        fixture.approvalBody(),
    );
    expect((): ConnectorMigrationApproval =>
        ConnectorMigrationApprovalCodec.value({ ...approval, authorizations: [] }),
    ).toThrow();
    expect((): ConnectorMigrationApproval =>
        ConnectorMigrationApprovalCodec.value({
            ...approval,
            authorizations: approval.authorizations.map(
                (entry: ConnectorMigrationAuthorization): ConnectorMigrationAuthorization => ({
                    ...entry,
                    pending: null,
                }),
            ),
        }),
    ).toThrow();
    expect((): ConnectorMigrationPlan =>
        ConnectorMigrationPlanCodec.decode(' '.repeat(ConnectorMigrationLimits.planBytes + 1)),
    ).toThrow();
});
