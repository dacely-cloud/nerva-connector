// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

import { ConnectorAuthorizationKind } from 'nerva-connector-protocol/protocol/ConnectorAuthorization.js';
import { ConnectorAuthorizationProof } from '../src/protocol/ConnectorAuthorizationProof.js';
import { ExecutionAppArmorInstaller } from '../src/execution/ExecutionAppArmorInstaller.js';
import { ExecutionConfiguration } from '../src/execution/ExecutionConfiguration.js';
import { ExecutionPolicy } from '../src/execution/ExecutionPolicy.js';
import { readFile, readdir } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { expect, it } from 'vitest';
import { ExecutionFixture } from './support/ExecutionFixture.js';
import { ExecutionIdentity } from './support/ExecutionIdentity.js';
import { setup } from './support/ExecutionSetup.js';
import { ExecutionClient } from '../src/execution/ExecutionClient.js';
import type { ExecutionClientSettings } from '../src/execution/ExecutionClientSettings.js';
import { ExecutionJournalInstallation } from '../src/execution/ExecutionJournalInstallation.js';
import {
    type ExecutionPermit,
    type ExecutionCancellation,
    type ExecutionCompletion,
} from '../src/execution/ExecutionJobs.js';
import { ExecutionLane } from 'nerva-connector-protocol/execution/ExecutionLane.js';
import { ExecutionFailure, ExecutionTermination } from '../src/execution/ExecutionTypes.js';
import { ExecutionProof } from '../src/execution/ExecutionProof.js';
import { ExecutionJobsCodec } from '../src/execution/ExecutionJobsCodec.js';
import {
    IdentityLengths,
    SignaturePurpose,
} from 'nerva-connector-protocol/identity/IdentityFormat.js';
import type { ConnectorDeviceLease } from 'nerva-connector-protocol/protocol/ConnectorDevice.js';
import type { ConnectorClientSession } from '../src/runtime/ConnectorClientSession.js';
import { Boundary } from 'nerva-connector-protocol/protocol/Boundary.js';

const helper: string | undefined = process.env['NERVA_CONNECTOR_EXEC_HELPER'];

/** Observe actual native code reaching its workspace marker before requesting a stop. */
async function running(fixture: ExecutionFixture, markers: readonly string[]): Promise<void> {
    const deadline: number = performance.now() + 3000;
    while (true) {
        const names: readonly string[] = await readdir(fixture.workspace);
        if (markers.every((marker: string): boolean => names.includes(marker))) {
            return;
        }
        if (performance.now() >= deadline) {
            throw new Error('Native original did not reach its running marker');
        }
        await delay(10);
    }
}

it.skipIf(helper === undefined)(
    'a dual-signed stop joins only its original native descendants across lease replacement and leaves the other lane and next command usable',
    async (): Promise<void> => {
        if (helper === undefined) {
            throw new Error('Explicit native execution helper required');
        }
        await using fixture: ExecutionFixture = await ExecutionFixture.create(helper);
        const settings: ExecutionClientSettings = await setup(fixture);
        using authority: ExecutionIdentity = new ExecutionIdentity(fixture.directory, settings);
        await using policy: ExecutionPolicy = await ExecutionConfiguration.loadPolicy(
            authority.identity,
            settings,
        );
        await ExecutionAppArmorInstaller.assertInstalled(policy.definition);
        const secondSettings: ExecutionClientSettings = { ...settings, lane: ExecutionLane.Second };
        await ExecutionJournalInstallation.initialize(authority.identity, settings);
        await ExecutionJournalInstallation.initialize(authority.identity, secondSettings);
        await using first: ExecutionClient = await ExecutionClient.load(
            authority.identity,
            settings,
            policy,
        );
        await using second: ExecutionClient = await ExecutionClient.load(
            authority.identity,
            secondSettings,
            policy,
        );
        const lease: ConnectorDeviceLease = authority.lease();
        const session: ConnectorClientSession = authority.session(lease);
        const permit: ExecutionPermit = authority.permit(
            first.publication(session).profile,
            lease,
            'effect-hold',
        );
        const other: ExecutionPermit = authority.permit(
            second.publication(session).profile,
            lease,
            'hold-b',
            1n,
            ExecutionLane.Second,
        );
        const original: Promise<ExecutionCompletion> = first.execute(permit, session);
        const parallel: Promise<ExecutionCompletion> = second.execute(other, session);
        const joined: Promise<readonly PromiseSettledResult<ExecutionCompletion>[]> =
            Promise.allSettled([original, parallel]);
        try {
            await running(fixture, ['effect-hold', 'hold-b']);
            const cancellation: ExecutionCancellation = authority.cancel(permit, lease);
            const candidates: ExecutionCancellation[] = [];
            for (const offset of [0, IdentityLengths.mlDsaSignature]) {
                const signature: Buffer = Buffer.from(cancellation.signature, 'base64url');
                signature[offset] = (signature[offset] ?? 0) ^ 1;
                candidates.push({ ...cancellation, signature: signature.toString('base64url') });
            }
            candidates.push(
                {
                    ...cancellation,
                    signature: authority.authority.sign(
                        SignaturePurpose.OperationExecutionPermit,
                        ExecutionProof.cancellation(cancellation),
                    ),
                },
                authority.signCancellation({ ...cancellation, environmentId: 'other-environment' }),
                authority.signCancellation({
                    ...cancellation,
                    enrollmentId: 'conn_' + 'b'.repeat(64),
                }),
                authority.signCancellation({ ...cancellation, authorityId: 'other-authority' }),
                authority.signCancellation({ ...cancellation, lane: ExecutionLane.Second }),
                authority.signCancellation({ ...cancellation, requestHash: 'a'.repeat(64) }),
                authority.signCancellation({ ...cancellation, jobId: 'other-job' }),
                authority.signCancellation({ ...cancellation, sequence: 2n }),
                authority.signCancellation({
                    ...cancellation,
                    dispatchId: randomBytes(32).toString('base64url'),
                }),
                authority.signCancellation({ ...cancellation, issuedAtMs: 1n, expiresAtMs: 2n }),
                authority.signCancellation({
                    ...cancellation,
                    expiresAtMs: lease.expiresAtMs + 1n,
                }),
            );
            const journalPath: string = join(
                settings.stateDirectory,
                settings.lane,
                'execution-journal',
            );
            const journal: Buffer = await readFile(journalPath);
            for (const value of candidates) {
                await expect(first.cancel(value, session)).rejects.toThrow();
            }
            expect(await readFile(journalPath)).toEqual(journal);
            expect(
                (await readdir(fixture.delegation)).filter((name: string): boolean =>
                    name.startsWith('exec-'),
                ),
            ).toHaveLength(2);
            const replacement: ConnectorDeviceLease = authority.lease();
            const current: ConnectorClientSession = authority.session(replacement);
            await expect(first.cancel(cancellation, current)).rejects.toThrow();
            const stop: ExecutionCancellation = authority.cancel(permit, replacement);
            const results: readonly ExecutionCompletion[] = await Promise.all([
                first.cancel(stop, current),
                first.cancel(stop, current),
            ]);
            const retained: ExecutionCompletion = await original;
            for (const value of results) {
                expect(value.response.failure).toBe(ExecutionFailure.Cancelled);
                expect(value.response).toEqual(retained.response);
                expect(value.leaseId).toBe(replacement.leaseId);
                expect(authority.ack(value).responseHash).toBe(retained.responseHash);
            }
            expect(await readFile(join(fixture.workspace, 'effects'), 'utf8')).toBe('x');
            expect(
                (await readdir(fixture.delegation)).filter((name: string): boolean =>
                    name.startsWith('exec-'),
                ),
            ).toHaveLength(1);
            expect(
                (await first.cancel(authority.cancel(permit, replacement), current)).response,
            ).toEqual(retained.response);
            const cancelled: ExecutionCompletion | undefined = results[0];
            if (cancelled === undefined) {
                throw new Error('Missing retained cancellation result');
            }
            await first.acknowledge(authority.ack(cancelled), current);
            const next: ExecutionPermit = authority.permit(
                first.publication(current).profile,
                replacement,
                'effect',
                2n,
            );
            expect((await first.execute(next, current)).response.termination).toBe(
                ExecutionTermination.Exited,
            );
            expect(await readFile(join(fixture.workspace, 'effects'), 'utf8')).toBe('xx');
            await expect(first.cancel(stop, current)).rejects.toThrow();
            const stopped: ExecutionCompletion = await second.cancel(
                authority.cancel(other, replacement),
                current,
            );
            expect(stopped.response.failure).toBe(ExecutionFailure.Cancelled);
            expect(
                (await readdir(fixture.delegation)).filter((name: string): boolean =>
                    name.startsWith('exec-'),
                ),
            ).toEqual([]);
        } finally {
            await first[Symbol.asyncDispose]();
            await second[Symbol.asyncDispose]();
            await joined;
        }
    },
);

it.skipIf(helper === undefined)(
    'a stop arriving before start seals the original across reopen and rejects later execution without an effect',
    async (): Promise<void> => {
        if (helper === undefined) {
            throw new Error('Explicit native execution helper required');
        }
        await using fixture: ExecutionFixture = await ExecutionFixture.create(helper);
        const settings: ExecutionClientSettings = await setup(fixture);
        using authority: ExecutionIdentity = new ExecutionIdentity(fixture.directory, settings);
        await using policy: ExecutionPolicy = await ExecutionConfiguration.loadPolicy(
            authority.identity,
            settings,
        );
        await ExecutionAppArmorInstaller.assertInstalled(policy.definition);
        await ExecutionJournalInstallation.initialize(authority.identity, settings);
        const lease: ConnectorDeviceLease = authority.lease();
        const session: ConnectorClientSession = authority.session(lease);
        let permit: ExecutionPermit;
        let result: ExecutionCompletion;
        {
            await using client: ExecutionClient = await ExecutionClient.load(
                authority.identity,
                settings,
                policy,
            );
            permit = authority.permit(client.publication(session).profile, lease);
            const stop: ExecutionCancellation = authority.cancel(permit, lease);
            result = await client.cancel(stop, session);
            expect(result.response.failure).toBe(ExecutionFailure.Cancelled);
            expect((await client.execute(permit, session)).response).toEqual(result.response);
            expect(await readdir(fixture.workspace)).not.toContain('effects');
        }
        await using client: ExecutionClient = await ExecutionClient.load(
            authority.identity,
            settings,
            policy,
        );
        const renewed: ConnectorDeviceLease = authority.lease();
        const current: ConnectorClientSession = authority.session(renewed);
        expect((await client.cancel(authority.cancel(permit, renewed), current)).responseHash).toBe(
            result.responseHash,
        );
        const now: bigint = BigInt(Date.now());
        const replay: ExecutionPermit = authority.sign({
            ...permit,
            leaseId: renewed.leaseId,
            issuedAtMs: now,
            expiresAtMs: now + 1000n,
            executionDeadlineMs: now + 5000n,
        });
        const retained: ExecutionCompletion = await client.execute(replay, current);
        expect(retained.response).toEqual(result.response);
        expect(authority.ack(retained).responseHash).toBe(result.responseHash);
        await client.acknowledge(authority.ack(retained), current);
        const pending: ExecutionPermit = authority.permit(
            client.publication(current).profile,
            renewed,
            'effect',
            2n,
        );
        const original: Promise<ExecutionCompletion> = client.execute(pending, current);
        const joined: Promise<readonly PromiseSettledResult<ExecutionCompletion>[]> =
            Promise.allSettled([original]);
        try {
            const cancelled: ExecutionCompletion = await client.cancel(
                authority.cancel(pending, renewed),
                current,
            );
            expect(cancelled.response.failure).toBe(ExecutionFailure.Cancelled);
            expect((await original).responseHash).toBe(cancelled.responseHash);
        } finally {
            await joined;
        }
        expect(await readdir(fixture.workspace)).not.toContain('effects');
        expect(
            (await readdir(fixture.delegation)).filter((name: string): boolean =>
                name.startsWith('exec-'),
            ),
        ).toEqual([]);
    },
);

it.skipIf(helper === undefined)(
    'completion winning the stop race retains the successful original and never fabricates a cancelled result',
    async (): Promise<void> => {
        if (helper === undefined) {
            throw new Error('Explicit native execution helper required');
        }
        await using fixture: ExecutionFixture = await ExecutionFixture.create(helper);
        const settings: ExecutionClientSettings = await setup(fixture);
        using authority: ExecutionIdentity = new ExecutionIdentity(fixture.directory, settings);
        await using policy: ExecutionPolicy = await ExecutionConfiguration.loadPolicy(
            authority.identity,
            settings,
        );
        await ExecutionAppArmorInstaller.assertInstalled(policy.definition);
        await ExecutionJournalInstallation.initialize(authority.identity, settings);
        await using client: ExecutionClient = await ExecutionClient.load(
            authority.identity,
            settings,
            policy,
        );
        const lease: ConnectorDeviceLease = authority.lease();
        const session: ConnectorClientSession = authority.session(lease);
        const permit: ExecutionPermit = authority.permit(
            client.publication(session).profile,
            lease,
        );
        const completed: ExecutionCompletion = await client.execute(permit, session);
        const stopped: ExecutionCompletion = await client.cancel(
            authority.cancel(permit, lease),
            session,
        );
        expect(stopped.response).toEqual(completed.response);
        expect(stopped.responseHash).toBe(completed.responseHash);
        expect(stopped.response.termination).toBe(ExecutionTermination.Exited);
        expect(await readFile(join(fixture.workspace, 'effects'), 'utf8')).toBe('x');
    },
);

it('a stop codec rejects additional start authority, zero sequences and validity outside the finite window', (): void => {
    using authority: ExecutionIdentity = new ExecutionIdentity('/not-used');
    const lease: ConnectorDeviceLease = authority.lease();
    const stop: ExecutionCancellation = authority.signCancellation({
        authorityId: 'cloud',
        environmentId: lease.environmentId,
        enrollmentId: lease.enrollmentId,
        lane: ExecutionLane.First,
        leaseId: lease.leaseId,
        jobId: 'job',
        sequence: 1n,
        dispatchId: randomBytes(32).toString('base64url'),
        requestHash: 'a'.repeat(64),
        authorization: { kind: ConnectorAuthorizationKind.Independent },
        admissionHash: ConnectorAuthorizationProof.execution('a'.repeat(64), ExecutionLane.First, {
            kind: ConnectorAuthorizationKind.Independent,
        }),
        request: {
            requestId: 'request',
            policySha256: 'a'.repeat(64),
            programId: 'tool',
            rootId: 'project',
            arguments: [],
        },
        issuedAtMs: lease.issuedAtMs,
        expiresAtMs: lease.issuedAtMs + 1000n,
    });
    const raw: unknown = JSON.parse(ExecutionJobsCodec.encode(stop));
    const encoded: Readonly<Record<string, unknown>> = Boundary.record(raw, Object.keys(stop));
    expect(ExecutionJobsCodec.cancellation(encoded)).toEqual(stop);
    for (const change of [
        { executionDeadlineMs: '5000' },
        { sequence: '0' },
        { expiresAtMs: stop.issuedAtMs.toString() },
        { expiresAtMs: (stop.issuedAtMs + 10001n).toString() },
    ]) {
        expect((): void => {
            ExecutionJobsCodec.cancellation({
                ...encoded,
                ...change,
            });
        }).toThrow();
    }
});
