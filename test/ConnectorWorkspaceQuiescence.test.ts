// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, it, vi, type MockInstance } from 'vitest';
import { ConnectorClientFiles } from '../src/runtime/ConnectorClientFiles.js';
import { ConnectorFilesystem } from '../src/runtime/ConnectorFilesystem.js';
import { ConnectorFileProof } from 'nerva-connector-protocol/protocol/ConnectorFileProof.js';
import { SignaturePurpose } from 'nerva-connector-protocol/identity/IdentityFormat.js';
import type {
    ConnectorFileAcknowledgment,
    ConnectorFileCompletion,
    ConnectorFilePermit,
} from 'nerva-connector-protocol/protocol/ConnectorFileJobs.js';
import type {
    ConnectorCapturedFileEffect,
    ConnectorCapturedExecutionEffect,
} from '../src/runtime/ConnectorEffectContext.js';
import { ConnectorClientExecution } from '../src/runtime/ConnectorClientExecution.js';
import { ConnectorFrameKind } from '../src/protocol/ConnectorTransport.js';
import { ExecutionClient } from '../src/execution/ExecutionClient.js';
import { ExecutionConfiguration } from '../src/execution/ExecutionConfiguration.js';
import { ExecutionPairPreparation } from '../src/execution/ExecutionPairPreparation.js';
import { ExecutionPolicy } from '../src/execution/ExecutionPolicy.js';
import {
    type ExecutionPermit,
    type ExecutionCompletion,
} from 'nerva-connector-protocol/execution/ExecutionJobs.js';
import { ExecutionLane } from 'nerva-connector-protocol/execution/ExecutionLane.js';
import type { ExecutionClientSettings } from '../src/execution/ExecutionClientSettings.js';
import type { ConnectorDeviceLease } from 'nerva-connector-protocol/protocol/ConnectorDevice.js';
import { CapturedEffectsFixture } from './support/CapturedEffectsFixture.js';
import { ExecutionFixture } from './support/ExecutionFixture.js';
import { ExecutionIdentity } from './support/ExecutionIdentity.js';
import { setup } from './support/ExecutionSetup.js';

const filesHelper: string | undefined = process.env['NERVA_CONNECTOR_FILES_HELPER'];
const execHelper: string | undefined = process.env['NERVA_CONNECTOR_EXEC_HELPER'];

it.skipIf(filesHelper === undefined)(
    'a real file source is nonquiescent before Started commits and after native completion until the exact signed acknowledgment',
    async (): Promise<void> => {
        await using fixture: CapturedEffectsFixture = await CapturedEffectsFixture.create();
        await writeFile(join(fixture.history.files.root, 'destination'), 'OLD', { mode: 0o600 });
        await using client: ConnectorClientFiles = await ConnectorClientFiles.load(
            fixture.history.identity,
        );
        expect(client.workspaceSource.quiescent).toBe(true);
        const source: typeof client.workspaceSource = client.workspaceSource;
        const captured: PromiseWithResolvers<undefined> = Promise.withResolvers<undefined>();
        const release: PromiseWithResolvers<undefined> = Promise.withResolvers<undefined>();
        const original: typeof ConnectorFilesystem.prototype.effectContext =
            ConnectorFilesystem.prototype.effectContext.bind(source.filesystem);
        const inspect: MockInstance<typeof original> = vi
            .spyOn(ConnectorFilesystem.prototype, 'effectContext')
            .mockImplementationOnce(async function (
                this: ConnectorFilesystem,
                rootId: string,
            ): Promise<ConnectorCapturedFileEffect> {
                expect(source.quiescent).toBe(false);
                const effect: ConnectorCapturedFileEffect = await original(rootId);
                captured.resolve(undefined);
                await release.promise;
                return effect;
            });
        const before: Buffer = await readFile(join(fixture.history.state, 'file-journal'));
        const permit: ConnectorFilePermit = fixture.permit();
        const task: Promise<ConnectorFileCompletion> = client.execute(
            permit,
            permit.leaseId,
            permit.expiresAtMs + 10000n,
        );
        try {
            await Promise.race([captured.promise, task]);
            expect(source.quiescent).toBe(false);
            expect(await readFile(join(fixture.history.state, 'file-journal'))).toEqual(before);
        } finally {
            release.resolve(undefined);
            inspect.mockRestore();
        }
        const completed: ConnectorFileCompletion = await task;
        expect(completed.response.ok).toBe(true);
        expect(source.quiescent).toBe(false);
        const value: Omit<ConnectorFileAcknowledgment, 'signature'> = {
            authorityId: fixture.history.identity.authority.authorityId,
            enrollmentId: completed.enrollmentId,
            leaseId: completed.leaseId,
            jobId: completed.jobId,
            sequence: completed.sequence,
            dispatchId: completed.dispatchId,
            requestHash: completed.requestHash,
            admissionHash: completed.admissionHash,
            responseHash: completed.responseHash,
        };
        await client.acknowledge(
            {
                ...value,
                signature: ConnectorFileProof.sign(
                    fixture.history.identity.key,
                    SignaturePurpose.OperationFileAcknowledgment,
                    ConnectorFileProof.acknowledgment(value),
                ),
            },
            permit.leaseId,
        );
        expect(source.quiescent).toBe(true);
    },
);

it.skipIf(execHelper === undefined)(
    'either actual command lane blocks joint publication while a durable terminal original awaits its signed acknowledgment, including after restart',
    async (): Promise<void> => {
        if (execHelper === undefined) {
            throw new Error('Explicit native execution helper required');
        }
        await using fixture: ExecutionFixture = await ExecutionFixture.create(execHelper);
        const settings: ExecutionClientSettings = await setup(fixture);
        using authority: ExecutionIdentity = new ExecutionIdentity(fixture.directory, settings);
        await ExecutionPairPreparation.prepare(authority.identity, true);
        const lease: ConnectorDeviceLease = authority.lease();
        let completion: ExecutionCompletion;
        {
            await using policy: ExecutionPolicy = await ExecutionConfiguration.loadPolicy(
                authority.identity,
                settings,
            );
            await using client: ExecutionClient = await ExecutionClient.load(
                authority.identity,
                { ...settings, lane: ExecutionLane.Second },
                policy,
            );
            expect(client.quiescent).toBe(true);
            const permit: ExecutionPermit = authority.permit(
                client.profile,
                lease,
                'effect',
                1n,
                ExecutionLane.Second,
            );
            completion = await client.cancel(
                authority.cancel(permit, lease),
                authority.session(lease),
            );
            expect(client.quiescent).toBe(false);
        }
        await using owner: ConnectorClientExecution = await ConnectorClientExecution.load(
            authority.identity,
        );
        const source: typeof owner.workspaceSource = owner.workspaceSource;
        expect(source.quiescent).toBe(false);
        const link: Parameters<ConnectorClientExecution['activate']>[0] = {
            session: authority.session(lease),
            leaseId: lease.leaseId,
            send: (): void => {},
            close: (): void => {},
        };
        owner.activate(link);
        owner.receive(
            {
                kind: ConnectorFrameKind.ExecutionAcknowledgment,
                acknowledgment: authority.ack(completion),
            },
            link,
        );
        await vi.waitFor((): void => expect(source.quiescent).toBe(true));
        owner.detach(link);
        expect(source.quiescent).toBe(true);
    },
    20000,
);

it.skipIf(execHelper === undefined)(
    'actual command capture blocks quiescence before any Started bytes and native effect, and completion remains unacknowledged',
    async (): Promise<void> => {
        if (execHelper === undefined) {
            throw new Error('Explicit native execution helper required');
        }
        await using fixture: ExecutionFixture = await ExecutionFixture.create(execHelper);
        const settings: ExecutionClientSettings = await setup(fixture);
        using authority: ExecutionIdentity = new ExecutionIdentity(fixture.directory, settings);
        await ExecutionPairPreparation.prepare(authority.identity, true);
        await using policy: ExecutionPolicy = await ExecutionConfiguration.loadPolicy(
            authority.identity,
            settings,
        );
        await using client: ExecutionClient = await ExecutionClient.load(
            authority.identity,
            settings,
            policy,
        );
        const lease: ConnectorDeviceLease = authority.lease();
        const permit: ExecutionPermit = authority.permit(client.profile, lease);
        const before: Buffer = await readFile(
            join(ExecutionConfiguration.journalDirectory(settings), 'execution-journal'),
        );
        const captured: PromiseWithResolvers<undefined> = Promise.withResolvers<undefined>();
        const release: PromiseWithResolvers<undefined> = Promise.withResolvers<undefined>();
        const original: typeof policy.effectContext = policy.effectContext.bind(policy);
        const inspect: MockInstance<typeof original> = vi
            .spyOn(policy, 'effectContext')
            .mockImplementationOnce(
                async (rootId: string): Promise<ConnectorCapturedExecutionEffect> => {
                    expect(client.quiescent).toBe(false);
                    const effect: ConnectorCapturedExecutionEffect = await original.call(
                        policy,
                        rootId,
                    );
                    captured.resolve(undefined);
                    await release.promise;
                    return effect;
                },
            );
        const task: Promise<ExecutionCompletion> = client.execute(permit, authority.session(lease));
        try {
            await Promise.race([captured.promise, task]);
            expect(client.quiescent).toBe(false);
            expect(
                await readFile(
                    join(ExecutionConfiguration.journalDirectory(settings), 'execution-journal'),
                ),
            ).toEqual(before);
        } finally {
            release.resolve(undefined);
            inspect.mockRestore();
        }
        const completed: ExecutionCompletion = await task;
        expect(completed.response.exitCode).toBe(0);
        expect(client.quiescent).toBe(false);
        await client.acknowledge(authority.ack(completed), authority.session(lease));
        expect(client.quiescent).toBe(true);
    },
    20000,
);
