// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, it, vi, type MockInstance } from 'vitest';
import { ExecutionInputJournalFixture as Fixture } from './support/ExecutionInputJournalFixture.js';
import { deadlineLease, type ExecutionDeadlineLease } from './support/ExecutionDeadlineLease.js';
import { ExecutionInputPreparationCodec } from '../src/execution/ExecutionInputPreparationCodec.js';
import { ExecutionInputJournalValidation } from '../src/execution/ExecutionInputJournalValidation.js';
import { ExecutionInputJournalOwner } from '../src/execution/ExecutionInputJournalOwner.js';
import {
    ExecutionInputJournalPhase,
    type ExecutionInputJournalPreparation,
} from '../src/execution/ExecutionInputJournalTypes.js';
import type {
    ExecutionInteractiveInvocationRule,
    ExecutionInteractiveLaunch,
} from 'nerva-connector-protocol/execution/ExecutionInteractiveInvocation.js';
import type { ExecutionPermit } from 'nerva-connector-protocol/execution/ExecutionJobs.js';
import { ExecutionProof } from 'nerva-connector-protocol/execution/ExecutionProof.js';
import { ConnectorAuthorizationProof } from 'nerva-connector-protocol/protocol/ConnectorAuthorizationProof.js';
import { SignaturePurpose } from 'nerva-connector-protocol/identity/IdentityFormat.js';
import { ConnectorOperationJournal } from '../src/runtime/ConnectorOperationJournal.js';
import { ConnectorEffectKind } from '../src/runtime/ConnectorEffectContext.js';
import { ExecutionJournalCodec } from '../src/execution/ExecutionJournalCodec.js';
import { ExecutionLaunchAdmission } from '../src/execution/ExecutionLaunchAdmission.js';
import type { ExecutionRequest } from 'nerva-connector-protocol/execution/ExecutionJobs.js';
import type { ExecutionResult } from 'nerva-connector-protocol/execution/ExecutionTypes.js';
import type { ExecutionOutput } from 'nerva-connector-protocol/execution/ExecutionOutput.js';

/** Real fixture authority signatures validate preparation; no Ready, native start or input acceptance is claimed. */
function signed(fixture: Fixture, value: ExecutionPermit): ExecutionPermit {
    return {
        ...value,
        signature: fixture.peer.authority.sign(
            SignaturePurpose.OperationExecutionPermit,
            ExecutionProof.permit(value),
        ),
    };
}

function preparation(
    fixture: Fixture,
    target: ExecutionDeadlineLease,
): ExecutionInputJournalPreparation {
    const rule: ExecutionInteractiveInvocationRule = {
        ...fixture.rule(),
        invocation: { ...fixture.rule().invocation, maximumTimeoutMs: 30000 },
    };
    const first: ReturnType<Fixture['admission']> = fixture.admission();
    const now: bigint = BigInt(Date.now());
    const launch: ExecutionInteractiveLaunch = {
        ...first.launch,
        invocation: { ...first.launch.invocation, timeoutMs: 30000 },
        executionDeadlineMs: now + 20000n,
    };
    const request: ExecutionPermit['request'] = fixture.request(launch, rule, first.ready.sequence);
    const requestHash: string = ExecutionProof.requestHash(request);
    const permit: ExecutionPermit = signed(fixture, {
        ...fixture.permit(first),
        request,
        requestHash,
        admissionHash: ConnectorAuthorizationProof.execution(
            requestHash,
            fixture.scope.lane,
            fixture.permit(first).authorization,
        ),
        leaseId: target.lease.leaseId,
        issuedAtMs: now,
        expiresAtMs: now + 1000n,
        executionDeadlineMs: launch.executionDeadlineMs,
    });
    return { permit, rule, launch, incarnation: first.ready.incarnation };
}

it('genuinely signed preparation preserves a running deadline beyond the aged current lease while start authority remains bounded', async (): Promise<void> => {
    await using fixture: Fixture = await Fixture.create();
    const target: ExecutionDeadlineLease = deadlineLease(
        fixture.peer.identity,
        fixture.peer.authority,
    );
    using session: typeof target.session = target.session;
    const codec: ExecutionInputPreparationCodec = new ExecutionInputPreparationCodec(
        new ExecutionInputJournalValidation(fixture.peer.identity, fixture.scope),
    );
    const captured: ExecutionInputJournalPreparation = codec.capture(preparation(fixture, target));
    expect(captured.permit.executionDeadlineMs).toBeGreaterThan(target.lease.expiresAtMs);
    expect(captured.permit.expiresAtMs).toBeLessThanOrEqual(target.lease.expiresAtMs);
    expect((): void => codec.fresh(captured, session, BigInt(Date.now()))).not.toThrow();
    await using owner: ExecutionInputJournalOwner = await ExecutionInputJournalOwner.open(
        fixture.directory,
        fixture.peer.identity,
        fixture.scope,
    );
    await owner.prepareFresh(captured, session, BigInt(Date.now()));
    const retained: ReturnType<ExecutionInputJournalOwner['recordState']> = owner.recordState();
    expect(retained.phase).toBe(ExecutionInputJournalPhase.Prepared);
    if (retained.phase !== ExecutionInputJournalPhase.Prepared) {
        throw new Error('Preparation must not fabricate Ready');
    }
    expect(retained.preparation.permit.executionDeadlineMs).toBe(
        captured.launch.executionDeadlineMs,
    );
    expect(retained.preparation.permit.expiresAtMs).toBe(captured.permit.expiresAtMs);
});

it('genuine signatures cannot extend start permission beyond the current lease, revive expiry or replace its exact binding', async (): Promise<void> => {
    await using fixture: Fixture = await Fixture.create();
    const target: ExecutionDeadlineLease = deadlineLease(
        fixture.peer.identity,
        fixture.peer.authority,
    );
    using session: typeof target.session = target.session;
    const codec: ExecutionInputPreparationCodec = new ExecutionInputPreparationCodec(
        new ExecutionInputJournalValidation(fixture.peer.identity, fixture.scope),
    );
    const original: ExecutionInputJournalPreparation = preparation(fixture, target);
    const now: bigint = BigInt(Date.now());
    const candidates: readonly ExecutionPermit[] = [
        signed(fixture, { ...original.permit, expiresAtMs: target.lease.expiresAtMs + 1n }),
        signed(fixture, { ...original.permit, issuedAtMs: now - 2000n, expiresAtMs: now - 1n }),
        signed(fixture, { ...original.permit, leaseId: Buffer.alloc(32, 2).toString('base64url') }),
    ];
    for (const permit of candidates) {
        const candidate: ExecutionInputJournalPreparation = codec.capture({ ...original, permit });
        expect((): void => codec.fresh(candidate, session, now)).toThrow();
    }
    expect((): ExecutionInputJournalPreparation =>
        codec.capture({
            ...original,
            permit: signed(fixture, {
                ...original.permit,
                executionDeadlineMs: original.permit.issuedAtMs + 30001n,
            }),
        }),
    ).toThrow();
    expect((): void => codec.fresh(original, session, target.lease.expiresAtMs)).toThrow();
});

it('launch admission rechecks the short current lease at every pre-exec boundary without truncating the immutable execution deadline', async (): Promise<void> => {
    await using fixture: Fixture = await Fixture.create();
    const target: ExecutionDeadlineLease = deadlineLease(
        fixture.peer.identity,
        fixture.peer.authority,
    );
    using session: typeof target.session = target.session;
    const original: ExecutionInputJournalPreparation = preparation(fixture, target);
    const directory: string = join(fixture.root, 'main');
    await mkdir(directory, { mode: 0o700 });
    await ConnectorOperationJournal.initialize(
        directory,
        fixture.peer.identity.settings.enrollmentId,
        fixture.peer.device,
        new ExecutionJournalCodec(fixture.scope.lane),
    );
    await using journal: ConnectorOperationJournal<
        ExecutionRequest,
        ExecutionResult,
        ExecutionOutput
    > = await ConnectorOperationJournal.load(
        directory,
        fixture.peer.identity.settings.enrollmentId,
        fixture.peer.device,
        new ExecutionJournalCodec(fixture.scope.lane),
    );
    await journal.begin(original.permit, { kind: ConnectorEffectKind.ExecutionNotStarted });
    const admission: ExecutionLaunchAdmission = new ExecutionLaunchAdmission(
        original.permit,
        session,
        journal,
        new AbortController().signal,
    );
    expect((): void => admission.assert()).not.toThrow();
    expect(admission.expiresAtMs).toBe(original.permit.expiresAtMs);
    const overlong: ExecutionPermit = signed(fixture, {
        ...original.permit,
        expiresAtMs: target.lease.expiresAtMs + 1n,
    });
    expect((): void =>
        new ExecutionLaunchAdmission(
            overlong,
            session,
            journal,
            new AbortController().signal,
        ).assert(),
    ).toThrow();
    const clock: MockInstance<typeof Date.now> = vi
        .spyOn(Date, 'now')
        .mockReturnValue(Number(original.permit.expiresAtMs));
    try {
        expect((): void => admission.assert()).toThrow();
    } finally {
        clock.mockRestore();
    }
    session[Symbol.dispose]();
    expect((): void => admission.assert()).toThrow();
});
