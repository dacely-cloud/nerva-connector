// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

import { spawn, type ChildProcess } from 'node:child_process';
import type { ExecutionSandboxAdmission } from '../src/execution/ExecutionSandboxAdmission.js';
import type { ExecutionResourceLimits } from '../src/execution/ExecutionTypes.js';
import { readFile, readdir, type FileHandle } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, it, vi, type MockInstance } from 'vitest';
import { ExecutionFixture } from './support/ExecutionFixture.js';
import { setup } from './support/ExecutionSetup.js';
import { ExecutionIdentity } from './support/ExecutionIdentity.js';
import { ExecutionPolicy } from '../src/execution/ExecutionPolicy.js';
import { ExecutionConfiguration } from '../src/execution/ExecutionConfiguration.js';
import type { ExecutionClientSettings } from '../src/execution/ExecutionClientSettings.js';
import { ExecutionClient } from '../src/execution/ExecutionClient.js';
import { ExecutionJournalCodec } from '../src/execution/ExecutionJournalCodec.js';
import type { ConnectorJournalPending } from '../src/runtime/ConnectorJournalState.js';
import { ExecutionJournalInstallation } from '../src/execution/ExecutionJournalInstallation.js';
import { ExecutionCgroup } from '../src/execution/ExecutionCgroup.js';
import { ExecutionCgroupAllocationError } from '../src/execution/ExecutionCgroupAllocationError.js';
import { ExecutionCgroupIdentityCodec } from '../src/execution/ExecutionCgroupIdentityCodec.js';
import type { ExecutionCgroupIdentity } from '../src/execution/ExecutionCgroupIdentity.js';
import type {
    ExecutionCompletion,
    ExecutionPermit,
    ExecutionRequest,
} from '../src/execution/ExecutionJobs.js';
import type { ExecutionResult } from '../src/execution/ExecutionTypes.js';
import type { ExecutionOutput } from '../src/execution/ExecutionOutput.js';
import { WorkspaceIdentityProcess } from '../src/workspace/WorkspaceIdentityProcess.js';
import type { WorkspaceDirectoryInspection } from '../src/workspace/WorkspaceDirectoryInspection.js';
import { ConnectorOperationJournal } from '../src/runtime/ConnectorOperationJournal.js';
import {
    ConnectorEffectKind,
    type ConnectorCapturedExecutionEffect,
} from '../src/runtime/ConnectorEffectContext.js';
import { ConnectorEffectContextCodec } from '../src/runtime/ConnectorEffectContextCodec.js';
import type { ConnectorDeviceLease } from 'nerva-connector-protocol/protocol/ConnectorDevice.js';

/** Failed assertions still recover through exact retained resource owners, never a pathname kill. */
interface AllocationFixtureOwnership {
    policy: ExecutionPolicy | null;
    allocation: AsyncDisposable | null;
}

const helper: string | undefined = process.env['NERVA_CONNECTOR_EXEC_HELPER'];

it.skipIf(helper === undefined)(
    'failed child-group capture and unproven allocation cleanup keep Started exact, reject execution retries and join only owned cleanup on shutdown',
    async (): Promise<void> => {
        if (helper === undefined) {
            throw new Error('Explicit current native execution helper required');
        }
        await using fixture: ExecutionFixture = await ExecutionFixture.create(helper);
        const settings: ExecutionClientSettings = await setup(fixture);
        using authority: ExecutionIdentity = new ExecutionIdentity(fixture.directory, settings);
        await ExecutionJournalInstallation.initialize(authority.identity, settings);
        const ownership: AllocationFixtureOwnership = { policy: null, allocation: null };
        await using fallback: AsyncDisposableStack = new AsyncDisposableStack();
        fallback.defer(async (): Promise<void> => {
            await ownership.allocation?.[Symbol.asyncDispose]();
            await ownership.policy?.[Symbol.asyncDispose]();
        });
        await using policy: ExecutionPolicy = await ExecutionConfiguration.loadPolicy(
            authority.identity,
            settings,
        );
        ownership.policy = policy;
        const context: ConnectorCapturedExecutionEffect = await policy.effectContext('project');
        expect(context.group).toBe(null);
        await using client: ExecutionClient = await ExecutionClient.load(
            authority.identity,
            settings,
            policy,
        );
        const lease: ConnectorDeviceLease = authority.lease();
        const permit: ExecutionPermit = authority.permit(
            client.publication(authority.session(lease)).profile,
            lease,
        );
        const captures: MockInstance<typeof WorkspaceIdentityProcess.prototype.cgroup>[] = [];
        let parentMatched: boolean = false;
        let started: Buffer;
        let allocationDirectory: FileHandle | null = null;
        {
            using allocations: MockInstance<typeof ExecutionCgroup.create> = vi.spyOn(
                ExecutionCgroup,
                'create',
            );
            using cleanup: MockInstance<ExecutionCgroup[typeof Symbol.asyncDispose]> = vi
                .spyOn(ExecutionCgroup.prototype, Symbol.asyncDispose)
                .mockRejectedValue(new Error('Controlled allocation cleanup failure'));
            const first: MockInstance<typeof WorkspaceIdentityProcess.prototype.cgroup> = vi.spyOn(
                WorkspaceIdentityProcess.prototype,
                'cgroup',
            );
            captures.push(first);
            first.mockImplementationOnce(async function (
                this: WorkspaceIdentityProcess,
                root: WorkspaceDirectoryInspection,
            ): Promise<ExecutionCgroupIdentity> {
                first.mockRestore();
                const identity: ExecutionCgroupIdentity = await this.cgroup(root);
                parentMatched = ExecutionCgroupIdentityCodec.same(identity, context.delegation);
                captures.push(
                    vi
                        .spyOn(WorkspaceIdentityProcess.prototype, 'cgroup')
                        .mockRejectedValue(
                            new Error('Controlled original child identity capture failure'),
                        ),
                );
                return identity;
            });
            try {
                const result: readonly PromiseSettledResult<ExecutionCompletion>[] =
                    await Promise.allSettled([client.execute(permit, authority.session(lease))]);
                const allocation: (typeof allocations.mock.results)[number] | undefined =
                    allocations.mock.results[0];
                if (allocation === undefined || allocation.type !== 'return') {
                    throw new Error('Real attempted kernel allocation required');
                }
                try {
                    await allocation.value;
                } catch (caught: unknown) {
                    if (
                        !(caught instanceof ExecutionCgroupAllocationError) ||
                        !(caught.owner instanceof ExecutionCgroup)
                    ) {
                        throw new Error('Exact unreturned allocation owner was not retained', {
                            cause: caught,
                        });
                    }
                    ownership.allocation = caught.owner;
                    allocationDirectory = caught.owner.directory;
                }
                if (ownership.allocation === null) {
                    throw new Error('Original allocation cleanup owner required');
                }
                expect(result[0]?.status).toBe('rejected');
                expect(parentMatched).toBe(true);
                expect(allocations).toHaveBeenCalledOnce();
                expect(captures[1]).toHaveBeenCalledOnce();
                expect(cleanup).toHaveBeenCalled();
                expect(policy.failed).toBe(true);
                expect(client.failed).toBe(true);
                started = await readFile(
                    join(settings.stateDirectory, settings.lane, 'execution-journal'),
                );
                await expect(client.execute(permit, authority.session(lease))).rejects.toThrow();
                expect(allocations).toHaveBeenCalledOnce();
                expect(
                    (
                        await readFile(
                            join(settings.stateDirectory, settings.lane, 'execution-journal'),
                        )
                    ).equals(started),
                ).toBe(true);
                expect((await readdir(fixture.workspace)).includes('effects')).toBe(false);
            } finally {
                for (const capture of captures.reverse()) {
                    capture.mockRestore();
                }
            }
        }
        await client[Symbol.asyncDispose]();
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
            const original: ConnectorJournalPending<
                ExecutionRequest,
                ExecutionResult,
                ExecutionOutput
            > | null = journal.pending;
            expect(original?.effectContext.kind).toBe(ConnectorEffectKind.CapturedExecution);
            expect(
                original !== null &&
                    ConnectorEffectContextCodec.encode(original.effectContext) ===
                        ConnectorEffectContextCodec.encode(context),
            ).toBe(true);
            expect(original?.response).toBe(null);
            expect(original?.progress).toBe(null);
            expect(original?.requestHash).toBe(permit.requestHash);
            expect(original?.jobId).toBe(permit.jobId);
            expect(original?.dispatchId).toBe(permit.dispatchId);
            expect(original?.sequence).toBe(permit.sequence);
        }
        expect(
            (await readdir(fixture.delegation)).filter((name: string): boolean =>
                name.startsWith('exec-'),
            ).length,
        ).toBe(1);
        await policy[Symbol.asyncDispose]();
        expect(policy.failed).toBe(true);
        expect((): void => policy.assertSource(settings.policyFile, [])).toThrow('authority');
        if (allocationDirectory === null) {
            throw new Error('Captured owned allocation descriptor required');
        }
        expect(allocationDirectory.fd).toBe(-1);
        expect(
            (await readdir(fixture.delegation)).filter((name: string): boolean =>
                name.startsWith('exec-'),
            ),
        ).toEqual([]);
        expect(
            (
                await readFile(join(settings.stateDirectory, settings.lane, 'execution-journal'))
            ).equals(started),
        ).toBe(true);
        expect((await readdir(fixture.workspace)).includes('effects')).toBe(false);
    },
);

it.skipIf(helper === undefined)(
    'a removed-group close failure retries only owned FD closure and cannot kill or unlink a replacement group at the same name',
    async (): Promise<void> => {
        if (helper === undefined) {
            throw new Error('Explicit current native execution helper required');
        }
        await using fixture: ExecutionFixture = await ExecutionFixture.create(helper);
        const admission: ExecutionSandboxAdmission = await fixture.admission();
        const limits: ExecutionResourceLimits = {
            memoryBytes: 33554432n,
            maximumTasks: 2,
            cpuQuotaMicros: 1000,
        };
        const id: string = 'e'.repeat(64);
        await using group: ExecutionCgroup = await ExecutionCgroup.create(
            fixture.sandbox.capabilities.cgroupParent,
            id,
            limits,
            admission.delegationIdentity,
            {
                helper: fixture.sandbox.capabilities.trampoline,
                capture: admission.capture,
                signal: new AbortController().signal,
            },
        );
        using kill: MockInstance<typeof group.kill> = vi.spyOn(group, 'kill');
        using close: MockInstance<FileHandle['close']> = vi
            .spyOn(group.directory, 'close')
            .mockRejectedValueOnce(new Error('Controlled owned group FD close failure'));
        await expect(group[Symbol.asyncDispose]()).rejects.toThrow('closure');
        expect(group.directory.fd >= 0).toBe(true);
        expect(kill).toHaveBeenCalledOnce();
        await expect(
            readFile(join(fixture.delegation, 'exec-' + id, 'cgroup.events')),
        ).rejects.toThrow();
        await using replacement: ExecutionCgroup = await ExecutionCgroup.create(
            fixture.sandbox.capabilities.cgroupParent,
            id,
            limits,
            admission.delegationIdentity,
            {
                helper: fixture.sandbox.capabilities.trampoline,
                capture: admission.capture,
                signal: new AbortController().signal,
            },
        );
        expect(ExecutionCgroupIdentityCodec.same(group.identity, replacement.identity)).toBe(false);
        const child: ChildProcess = spawn('/usr/bin/sleep', ['60'], { stdio: 'ignore' });
        const done: PromiseWithResolvers<undefined> = Promise.withResolvers<undefined>();
        child.once('close', (): void => done.resolve(undefined));
        child.once('error', done.reject);
        await using childOwner: AsyncDisposableStack = new AsyncDisposableStack();
        childOwner.defer(async (): Promise<void> => {
            if (child.exitCode === null && child.signalCode === null) {
                child.kill('SIGKILL');
            }
            await done.promise;
        });
        const pid: number | undefined = child.pid;
        if (pid === undefined) {
            throw new Error('Exact owned canary child required');
        }
        await replacement.attach(pid);
        await group[Symbol.asyncDispose]();
        expect(group.directory.fd).toBe(-1);
        expect(close).toHaveBeenCalledTimes(2);
        expect(kill).toHaveBeenCalledOnce();
        expect(child.exitCode).toBe(null);
        expect(child.signalCode).toBe(null);
        expect(
            await readFile(join(fixture.delegation, 'exec-' + id, 'cgroup.events'), 'utf8'),
        ).toMatch(/^populated 1$/mu);
        await group[Symbol.asyncDispose]();
        expect(close).toHaveBeenCalledTimes(2);
        expect(kill).toHaveBeenCalledOnce();
        expect(child.exitCode).toBe(null);
        expect(child.signalCode).toBe(null);
    },
);
