// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

import { ExecutionConfiguration } from '../src/execution/ExecutionConfiguration.js';
import type { ConnectorCapturedExecutionEffect } from '../src/runtime/ConnectorEffectContext.js';
import type { ExecutionCgroupIdentity } from '../src/execution/ExecutionCgroupIdentity.js';
import { ExecutionJournalInstallation } from '../src/execution/ExecutionJournalInstallation.js';
import { readFile, writeFile, mkdir, readdir, rm, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { expect, it } from 'vitest';
import { ExecutionFixture } from './support/ExecutionFixture.js';
import { setup } from './support/ExecutionSetup.js';
import { ExecutionIdentity } from './support/ExecutionIdentity.js';
import { ExecutionClient } from '../src/execution/ExecutionClient.js';
import type { ExecutionClientSettings } from '../src/execution/ExecutionClientSettings.js';
import { ExecutionPolicy } from '../src/execution/ExecutionPolicy.js';
import type { ExecutionOutput } from 'nerva-connector-protocol/execution/ExecutionOutput.js';
import { ExecutionJournalCodec } from '../src/execution/ExecutionJournalCodec.js';
import { ConnectorOperationJournal } from '../src/runtime/ConnectorOperationJournal.js';
import { ExecutionProof } from 'nerva-connector-protocol/execution/ExecutionProof.js';
import {
    ExecutionFailure,
    ExecutionTermination,
    type ExecutionResult,
} from 'nerva-connector-protocol/execution/ExecutionTypes.js';
import { ExecutionLane } from 'nerva-connector-protocol/execution/ExecutionLane.js';
import type {
    ExecutionPermit,
    ExecutionPublication,
    ExecutionCompletion,
    ExecutionRequest,
    ExecutionAcknowledgment,
    ExecutionAcknowledged,
} from 'nerva-connector-protocol/execution/ExecutionJobs.js';
import type { ConnectorDeviceLease } from 'nerva-connector-protocol/protocol/ConnectorDevice.js';
import {
    SignaturePurpose,
    IdentityLengths,
} from 'nerva-connector-protocol/identity/IdentityFormat.js';
import { SigningKey } from '../src/identity/SigningKey.js';
import type { ConnectorClientIdentity } from '../src/runtime/ConnectorClientConfiguration.js';
import { ConnectorClientSession } from '../src/runtime/ConnectorClientSession.js';
import { ExecutionPairPreparation } from '../src/execution/ExecutionPairPreparation.js';
import { ConnectorClientExecution } from '../src/runtime/ConnectorClientExecution.js';
import { ConnectorClientFiles } from '../src/runtime/ConnectorClientFiles.js';
import { ConnectorFileMode } from 'nerva-connector-protocol/protocol/ConnectorFiles.js';
import { createHash } from 'node:crypto';
import { ExecutionAppArmorInstaller } from '../src/execution/ExecutionAppArmorInstaller.js';
import { ExecutionPolicyCodec } from '../src/execution/ExecutionPolicyCodec.js';

const helper: string | undefined = process.env['NERVA_CONNECTOR_EXEC_HELPER'];
const filesHelper: string | undefined = process.env['NERVA_CONNECTOR_FILES_HELPER'];

it.skipIf(helper === undefined)(
    'normal command ownership refuses absent enforcing profiles before opening or creating journal state',
    async (): Promise<void> => {
        if (helper === undefined) {
            throw new Error('Explicit native execution helper required');
        }
        await using fixture: ExecutionFixture = await ExecutionFixture.create(helper);
        const settings: ExecutionClientSettings = await setup(fixture);
        using authority: ExecutionIdentity = new ExecutionIdentity(fixture.directory, settings);
        const definition: ReturnType<typeof ExecutionPolicyCodec.policy> =
            ExecutionPolicyCodec.policy(JSON.parse(await readFile(settings.policyFile, 'utf8')));
        await ExecutionAppArmorInstaller.assertInstalled(definition);
        await ExecutionAppArmorInstaller.remove(definition);
        try {
            await expect(ConnectorClientExecution.load(authority.identity)).rejects.toThrow(
                'enforcing',
            );
            expect(await readdir(settings.stateDirectory)).toEqual([]);
        } finally {
            await ExecutionAppArmorInstaller.install(definition);
        }
    },
);

it.skipIf(helper === undefined || filesHelper === undefined)(
    'a file-write grant cannot expose the actual execution runtime even when policy and journals are elsewhere',
    async (): Promise<void> => {
        if (helper === undefined || filesHelper === undefined) {
            throw new Error('Explicit native helpers required');
        }
        await using fixture: ExecutionFixture = await ExecutionFixture.create(helper);
        const settings: ExecutionClientSettings = await setup(fixture);
        using authority: ExecutionIdentity = new ExecutionIdentity(fixture.directory, settings);
        const stateDirectory: string = join(fixture.directory, 'file-state');
        const stagingPath: string = join(fixture.directory, 'file-staging');
        for (const path of [stateDirectory, stagingPath]) {
            await mkdir(path, { mode: 0o700 });
        }
        const policyFile: string = join(fixture.directory, 'file-policy.json');
        await writeFile(
            policyFile,
            JSON.stringify({
                mode: ConnectorFileMode.ReadWrite,
                revision: '1',
                helperFile: filesHelper,
                helperSha256: createHash('sha256')
                    .update(await readFile(filesHelper))
                    .digest('hex'),
                roots: [{ id: 'runtime', path: fixture.runtime, stagingPath }],
            }),
            { mode: 0o600 },
        );
        const identity: ConnectorClientIdentity = {
            ...authority.identity,
            settings: {
                ...authority.identity.settings,
                files: { policyFile, stateDirectory },
                execution: {
                    policyFile: settings.policyFile,
                    stateDirectory: settings.stateDirectory,
                },
            },
        };
        await expect(ConnectorClientFiles.initialize(identity)).rejects.toThrow();
        expect(await readdir(stateDirectory)).toEqual([]);
        expect(await readFile(join(fixture.workspace, 'input'), 'utf8')).toBe('safe');
    },
);

it.skipIf(helper === undefined)(
    'original pairing prepares both lanes once, excludes live installation and never repairs configured lost history',
    async (): Promise<void> => {
        if (helper === undefined) {
            throw new Error('Explicit native execution helper required');
        }
        await using fixture: ExecutionFixture = await ExecutionFixture.create(helper);
        const settings: ExecutionClientSettings = await setup(fixture);
        using authority: ExecutionIdentity = new ExecutionIdentity(fixture.directory, settings);
        const identity: ConnectorClientIdentity = {
            ...authority.identity,
            settings: {
                ...authority.identity.settings,
                execution: {
                    policyFile: settings.policyFile,
                    stateDirectory: settings.stateDirectory,
                },
            },
        };
        await ExecutionPairPreparation.prepare(identity, true);
        await ExecutionPairPreparation.prepare(identity, false);
        {
            await using owner: ConnectorClientExecution =
                await ConnectorClientExecution.load(identity);
            expect(owner.failed).toBe(false);
            await expect(
                ExecutionJournalInstallation.initialize(identity, settings),
            ).rejects.toThrow();
        }
        const first: string = join(
            settings.stateDirectory,
            ExecutionLane.First,
            'execution-journal',
        );
        const second: string = join(
            settings.stateDirectory,
            ExecutionLane.Second,
            'execution-journal',
        );
        const retained: Buffer = await readFile(second);
        await rm(first);
        await expect(ExecutionPairPreparation.prepare(identity, false)).rejects.toThrow(
            'lost its original',
        );
        await expect(lstat(first)).rejects.toThrow();
        expect(await readFile(second)).toEqual(retained);
    },
);

/** Each replacement proof retains the original dispatch/request/sequence while binding the fresh authenticated lease and finite clocks. */
function renew(
    authority: ExecutionIdentity,
    original: ExecutionPermit,
    lease: ConnectorDeviceLease,
): ExecutionPermit {
    const now: bigint = BigInt(Date.now());
    return authority.sign({
        ...original,
        leaseId: lease.leaseId,
        issuedAtMs: now,
        expiresAtMs: now + 1000n,
        executionDeadlineMs: now + 5000n,
    });
}

it.skipIf(helper === undefined)(
    'both signature components and exact purpose/target/deadlines are mandatory before journal admission or an effect',
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
        const unsafe: ConnectorClientIdentity = {
            ...authority.identity,
            settings: {
                ...authority.identity.settings,
                files: {
                    policyFile: join(fixture.workspace, 'file-policy.json'),
                    stateDirectory: join(fixture.directory, 'file-state'),
                },
            },
        };
        await expect(ExecutionJournalInstallation.initialize(unsafe, settings)).rejects.toThrow();
        await expect(ExecutionClient.load(authority.identity, settings, policy)).rejects.toThrow();
        await ExecutionJournalInstallation.initialize(authority.identity, settings);
        await expect(
            ExecutionJournalInstallation.initialize(authority.identity, settings),
        ).rejects.toThrow();
        await using client: ExecutionClient = await ExecutionClient.load(
            authority.identity,
            settings,
            policy,
        );
        using unconfirmed: ConnectorClientSession = new ConnectorClientSession(authority.identity);
        expect((): void => {
            client.publication(unconfirmed);
        }).toThrow();
        await expect(ExecutionClient.load(authority.identity, settings, policy)).rejects.toThrow();
        const lease: ConnectorDeviceLease = authority.lease();
        const publication: ExecutionPublication = client.publication(authority.session(lease));
        expect(
            SigningKey.verify(
                SignaturePurpose.ExecutionProfile,
                authority.device.publicKey,
                ExecutionProof.publication(publication),
                publication.signature,
            ),
        ).toBe(true);
        expect(
            JSON.stringify(publication, (_key: string, value: unknown): unknown =>
                typeof value === 'bigint' ? value.toString() : value,
            ),
        ).not.toContain('/usr/bin/probe');
        const permit: ExecutionPermit = authority.permit(publication.profile, lease);
        const original: Buffer = await readFile(
            join(settings.stateDirectory, settings.lane, 'execution-journal'),
        );
        const candidates: ExecutionPermit[] = [];
        for (const offset of [0, IdentityLengths.mlDsaSignature]) {
            const signature: Buffer = Buffer.from(permit.signature, 'base64url');
            signature[offset] = (signature[offset] ?? 0) ^ 1;
            candidates.push({ ...permit, signature: signature.toString('base64url') });
        }
        candidates.push(
            {
                ...permit,
                signature: authority.authority.sign(
                    SignaturePurpose.OperationFilePermit,
                    ExecutionProof.permit(permit),
                ),
            },
            authority.sign({ ...permit, environmentId: 'another-environment' }),
            authority.sign({ ...permit, lane: ExecutionLane.Second }),
            authority.sign({ ...permit, requestHash: 'b'.repeat(64) }),
            authority.sign({ ...permit, executionDeadlineMs: permit.issuedAtMs + 30001n }),
            authority.sign({ ...permit, authorityId: 'another-authority' }),
            authority.sign({ ...permit, issuedAtMs: 1n, expiresAtMs: 2n, executionDeadlineMs: 3n }),
        );
        for (const changed of candidates) {
            await expect(client.execute(changed, authority.session(lease))).rejects.toThrow();
        }
        expect(
            await readFile(join(settings.stateDirectory, settings.lane, 'execution-journal')),
        ).toEqual(original);
        expect(await readdir(fixture.workspace)).not.toContain('effects');
        expect(
            (await readdir(fixture.delegation)).filter((name: string): boolean =>
                name.startsWith('exec-'),
            ),
        ).toEqual([]);
        const completed: ExecutionCompletion = await client.execute(
            permit,
            authority.session(lease),
        );
        expect(completed.response).toMatchObject({
            termination: ExecutionTermination.Exited,
            exitCode: 0,
        });
        expect(await readFile(join(fixture.workspace, 'effects'), 'utf8')).toBe('x');
        const acknowledgment: ExecutionAcknowledgment = authority.ack(completed);
        for (const offset of [0, IdentityLengths.mlDsaSignature]) {
            const signature: Buffer = Buffer.from(acknowledgment.signature, 'base64url');
            signature[offset] = (signature[offset] ?? 0) ^ 1;
            await expect(
                client.acknowledge(
                    { ...acknowledgment, signature: signature.toString('base64url') },
                    authority.session(lease),
                ),
            ).rejects.toThrow();
        }
        const receipt: ExecutionAcknowledged = await client.acknowledge(
            acknowledgment,
            authority.session(lease),
        );
        expect(
            SigningKey.verify(
                SignaturePurpose.OperationExecutionAcknowledged,
                authority.device.publicKey,
                ExecutionProof.acknowledged(receipt),
                receipt.signature,
            ),
        ).toBe(true);
        await expect(client.execute(permit, authority.session(lease))).rejects.toThrow();
    },
);

it.skipIf(helper === undefined)(
    'two signed lanes run independent native descendants while duplicate local owners and cross-lane permits are denied',
    async (): Promise<void> => {
        if (helper === undefined) {
            throw new Error('Explicit native execution helper required');
        }
        await using fixture: ExecutionFixture = await ExecutionFixture.create(helper);
        const first: ExecutionClientSettings = await setup(fixture);
        using authority: ExecutionIdentity = new ExecutionIdentity(fixture.directory, first);
        await using policy: ExecutionPolicy = await ExecutionConfiguration.loadPolicy(
            authority.identity,
            first,
        );
        await ExecutionAppArmorInstaller.assertInstalled(policy.definition);
        const second: ExecutionClientSettings = { ...first, lane: ExecutionLane.Second };
        await ExecutionJournalInstallation.initialize(authority.identity, first);
        await ExecutionJournalInstallation.initialize(authority.identity, second);
        await using a: ExecutionClient = await ExecutionClient.load(
            authority.identity,
            first,
            policy,
        );
        await using b: ExecutionClient = await ExecutionClient.load(
            authority.identity,
            second,
            policy,
        );
        await expect(ExecutionClient.load(authority.identity, first, policy)).rejects.toThrow();
        await expect(ExecutionClient.load(authority.identity, second, policy)).rejects.toThrow();
        const lease: ConnectorDeviceLease = authority.lease();
        const session: ConnectorClientSession = authority.session(lease);
        const firstPublication: ExecutionPublication = a.publication(session);
        const secondPublication: ExecutionPublication = b.publication(session);
        expect(firstPublication.journalId).not.toBe(secondPublication.journalId);
        const firstPermit: ExecutionPermit = authority.permit(
            firstPublication.profile,
            lease,
            'hold-a',
            1n,
            ExecutionLane.First,
        );
        const secondPermit: ExecutionPermit = authority.permit(
            secondPublication.profile,
            lease,
            'hold-b',
            1n,
            ExecutionLane.Second,
        );
        await expect(a.execute(secondPermit, session)).rejects.toThrow();
        await expect(b.execute(firstPermit, session)).rejects.toThrow();
        const tasks: readonly Promise<ExecutionCompletion>[] = [
            a.execute(firstPermit, session),
            b.execute(secondPermit, session),
        ];
        const joined: Promise<readonly PromiseSettledResult<ExecutionCompletion>[]> =
            Promise.allSettled(tasks);
        const deadline: number = performance.now() + 3000;
        try {
            while (true) {
                const names: readonly string[] = await readdir(fixture.workspace);
                if (names.includes('hold-a') && names.includes('hold-b')) {
                    break;
                }
                if (performance.now() >= deadline) {
                    throw new Error(
                        'Both signed command lanes must reach their native running markers',
                    );
                }
                await delay(10);
            }
            expect(
                (await readdir(fixture.delegation)).filter((name: string): boolean =>
                    name.startsWith('exec-'),
                ),
            ).toHaveLength(2);
            expect(
                await readFile(join(first.stateDirectory, first.lane, 'execution-journal')),
            ).not.toEqual(
                await readFile(join(second.stateDirectory, second.lane, 'execution-journal')),
            );
        } finally {
            await a[Symbol.asyncDispose]();
            await b[Symbol.asyncDispose]();
            await joined;
        }
        for (const result of await joined) {
            expect(result.status).toBe('fulfilled');
            if (result.status === 'fulfilled') {
                expect(result.value.response.failure).toBe(ExecutionFailure.Cancelled);
            }
        }
        expect(
            (await readdir(fixture.delegation)).filter((name: string): boolean =>
                name.startsWith('exec-'),
            ),
        ).toEqual([]);
    },
);

it.skipIf(helper === undefined)(
    'retained command output survives reopen and replacement authentication without repeating the effect',
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
        let permit: ExecutionPermit;
        let completed: ExecutionCompletion;
        {
            await using client: ExecutionClient = await ExecutionClient.load(
                authority.identity,
                settings,
                policy,
            );
            const lease: ConnectorDeviceLease = authority.lease();
            permit = authority.permit(client.publication(authority.session(lease)).profile, lease);
            completed = await client.execute(permit, authority.session(lease));
            expect((await client.execute(permit, authority.session(lease))).response).toEqual(
                completed.response,
            );
        }
        await writeFile(join(fixture.workspace, 'effects'), 'changed-after-execution');
        const retained: string = await readFile(
            join(settings.stateDirectory, settings.lane, 'execution-journal'),
            'utf8',
        );
        expect(retained).not.toContain('effect applied');
        expect(retained).not.toContain(Buffer.from('effect applied\n').toString('base64'));
        await using client: ExecutionClient = await ExecutionClient.load(
            authority.identity,
            settings,
            policy,
        );
        const replacement: ConnectorDeviceLease = authority.lease();
        const replay: ExecutionCompletion = await client.execute(
            renew(authority, permit, replacement),
            authority.session(replacement),
        );
        expect(replay.response).toEqual(completed.response);
        expect(replay.responseHash).toBe(completed.responseHash);
        expect(replay.leaseId).not.toBe(completed.leaseId);
        expect(await readFile(join(fixture.workspace, 'effects'), 'utf8')).toBe(
            'changed-after-execution',
        );
        await client.acknowledge(authority.ack(replay), authority.session(replacement));
        await client.acknowledge(authority.ack(replay), authority.session(replacement));
        await client.execute(
            authority.permit(
                client.publication(authority.session(replacement)).profile,
                replacement,
                'effect',
                2n,
            ),
            authority.session(replacement),
        );
        expect(await readFile(join(fixture.workspace, 'effects'), 'utf8')).toBe(
            'changed-after-executionx',
        );
    },
);

it.skipIf(helper === undefined)(
    'a real effect without a durable result recovers indeterminate without another command',
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
        let permit: ExecutionPermit;
        {
            await using client: ExecutionClient = await ExecutionClient.load(
                authority.identity,
                settings,
                policy,
            );
            const lease: ConnectorDeviceLease = authority.lease();
            permit = authority.permit(client.publication(authority.session(lease)).profile, lease);
        }
        {
            await using journal: ConnectorOperationJournal<
                ExecutionRequest,
                ExecutionResult,
                ExecutionOutput
            > = await ConnectorOperationJournal.load(
                join(settings.stateDirectory, settings.lane),
                authority.identity.settings.enrollmentId,
                authority.device,
                new ExecutionJournalCodec(settings.lane),
            );
            const context: ConnectorCapturedExecutionEffect = await policy.effectContext(
                permit.request.rootId,
            );
            expect((await journal.begin(permit, context)).fresh).toBe(true);
            const response: ExecutionResult = await policy.execute(
                {
                    policySha256: permit.request.policySha256,
                    programId: permit.request.programId,
                    rootId: permit.request.rootId,
                    arguments: permit.request.arguments,
                },
                ExecutionProof.cgroupId(journal.id, permit),
                AbortSignal.timeout(6000),
                {
                    context,
                    expiresAtMs: permit.expiresAtMs,
                    assertLaunch: (): void => {
                        if (BigInt(Date.now()) >= permit.expiresAtMs) {
                            throw new Error('Fixture start expired');
                        }
                    },
                    commit: async (group: ExecutionCgroupIdentity): Promise<void> => {
                        await journal.bindExecutionGroup(permit, group);
                    },
                },
                {
                    retain: async (output: ExecutionOutput): Promise<void> =>
                        await journal.retain(permit, output),
                },
            );
            expect(response.exitCode).toBe(0);
        }
        expect(await readFile(join(fixture.workspace, 'effects'), 'utf8')).toBe('x');
        await writeFile(join(fixture.workspace, 'effects'), 'changed-before-recovery');
        await using client: ExecutionClient = await ExecutionClient.load(
            authority.identity,
            settings,
            policy,
        );
        const replacement: ConnectorDeviceLease = authority.lease();
        const result: ExecutionCompletion = await client.execute(
            renew(authority, permit, replacement),
            authority.session(replacement),
        );
        expect(result.response).toMatchObject({
            termination: ExecutionTermination.Indeterminate,
            failure: ExecutionFailure.Interrupted,
            exitCode: null,
            stdoutBase64: Buffer.from('effect applied\n').toString('base64'),
            stderrBase64: '',
        });
        expect(await readFile(join(fixture.workspace, 'effects'), 'utf8')).toBe(
            'changed-before-recovery',
        );
        await client.acknowledge(authority.ack(result), authority.session(replacement));
    },
);
