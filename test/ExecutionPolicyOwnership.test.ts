// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

import { fstatSync } from 'node:fs';
import { ExecutionPolicy } from '../src/execution/ExecutionPolicy.js';
import { ExecutionConfiguration } from '../src/execution/ExecutionConfiguration.js';
import { ExecutionClient } from '../src/execution/ExecutionClient.js';
import type { ExecutionClientSettings } from '../src/execution/ExecutionClientSettings.js';
import type { WorkspaceInspection } from '../src/workspace/WorkspaceInspection.js';
import {
    ConnectorPrivateDirectory,
    ConnectorDirectoryPurpose,
} from '../src/runtime/ConnectorPrivateDirectory.js';
import { ConnectorOperationJournal } from '../src/runtime/ConnectorOperationJournal.js';
import type { ConnectorClientIdentity } from '../src/runtime/ConnectorClientConfiguration.js';
import type { ExecutionRequest } from '../src/execution/ExecutionJobs.js';
import type { ExecutionResult } from '../src/execution/ExecutionTypes.js';
import type { ExecutionOutput } from '../src/execution/ExecutionOutput.js';
import { ExecutionJournalCodec } from '../src/execution/ExecutionJournalCodec.js';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, it, vi, type MockInstance } from 'vitest';
import { SharedExecutionFixture } from './support/SharedExecutionFixture.js';
import { ConnectorClientExecution } from '../src/runtime/ConnectorClientExecution.js';
import { ExecutionAppArmorInstaller } from '../src/execution/ExecutionAppArmorInstaller.js';
import { ExecutionLane } from 'nerva-connector-protocol/execution/ExecutionLane.js';

const helpers: boolean =
    process.platform === 'linux' &&
    process.env['NERVA_CONNECTOR_FILES_HELPER'] !== undefined &&
    process.env['NERVA_CONNECTOR_EXEC_HELPER'] !== undefined;

it.skipIf(!helpers || process.env['NERVA_CONNECTOR_MEASURE_POLICY'] !== '1')(
    'measures unchanged two-lane startup with real pinned files and encrypted journals, without claiming MAC/command qualification',
    async (): Promise<void> => {
        await using fixture: SharedExecutionFixture = await SharedExecutionFixture.create();
        using mac: MockInstance<typeof ExecutionAppArmorInstaller.assertInstalled> = vi
            .spyOn(ExecutionAppArmorInstaller, 'assertInstalled')
            .mockResolvedValue();
        const settings: typeof fixture.identity.settings.execution =
            fixture.identity.settings.execution;
        if (settings === null) {
            throw new Error('Explicit paired fixture required');
        }
        const before: readonly Buffer[] = await Promise.all(
            Object.values(ExecutionLane).map((lane: ExecutionLane): Promise<Buffer> =>
                readFile(join(settings.stateDirectory, lane, 'execution-journal')),
            ),
        );
        const samples: number[] = [];
        for (let cohort: number = 0; cohort < 3; cohort++) {
            const started: number = performance.now();
            for (let round: number = 0; round < 30; round++) {
                await using owner: ConnectorClientExecution = await ConnectorClientExecution.load(
                    fixture.identity,
                );
                expect(owner.failed).toBe(false);
            }
            samples.push(performance.now() - started);
        }
        let index: number = 0;
        for (const lane of Object.values(ExecutionLane)) {
            const original: Buffer | undefined = before[index++];
            if (original === undefined) {
                throw new Error('Original lane bytes required');
            }
            expect(
                (await readFile(join(settings.stateDirectory, lane, 'execution-journal'))).equals(
                    original,
                ),
            ).toBe(true);
        }
        expect(mac).toHaveBeenCalled();
        process.stdout.write(
            'NERVA_SHARED_POLICY_MEASUREMENT ' +
                JSON.stringify({
                    samplesMs: samples,
                    startsPerCohort: 30,
                    cohorts: 3,
                    journalsUnchanged: true,
                    macAndCommandsQualified: false,
                }) +
                '\n',
        );
    },
);

it.skipIf(!helpers)(
    'one installation verifies one policy and MAC profile, then lends that same captured capability to both independent journals',
    async (): Promise<void> => {
        await using fixture: SharedExecutionFixture = await SharedExecutionFixture.create();
        using mac: MockInstance<typeof ExecutionAppArmorInstaller.assertInstalled> = vi
            .spyOn(ExecutionAppArmorInstaller, 'assertInstalled')
            .mockResolvedValue();
        using load: MockInstance<typeof ExecutionPolicy.load> = vi.spyOn(ExecutionPolicy, 'load');
        using lanes: MockInstance<typeof ExecutionClient.load> = vi.spyOn(ExecutionClient, 'load');
        const owner: ConnectorClientExecution = await ConnectorClientExecution.load(
            fixture.identity,
        );
        try {
            expect(owner.failed).toBe(false);
            expect(load).toHaveBeenCalledOnce();
            expect(mac).toHaveBeenCalledOnce();
            expect(lanes).toHaveBeenCalledTimes(2);
            const first: Parameters<typeof ExecutionClient.load> | undefined = lanes.mock.calls[0];
            const second: Parameters<typeof ExecutionClient.load> | undefined = lanes.mock.calls[1];
            if (first === undefined || second === undefined) {
                throw new Error('Both actual lane loads required');
            }
            expect(first[1].lane).toBe(ExecutionLane.First);
            expect(second[1].lane).toBe(ExecutionLane.Second);
            expect(first[2] === second[2]).toBe(true);
            first[2].assertSource(first[1].policyFile, [first[1].stateDirectory]);
        } finally {
            await owner[Symbol.asyncDispose]();
        }
        const policy: ExecutionPolicy | undefined = lanes.mock.calls[0]?.[2];
        if (policy === undefined) {
            throw new Error('Owned verified policy required');
        }
        expect((): void => policy.assertSource(fixture.native.executionPolicy, [])).toThrow(
            'authority',
        );
    },
);

it.skipIf(!helpers)(
    'disposing a borrowed lane releases only that lane journal and keeps the shared policy and other lane alive',
    async (): Promise<void> => {
        await using fixture: SharedExecutionFixture = await SharedExecutionFixture.create();
        const firstSettings: ExecutionClientSettings = fixture.settings(ExecutionLane.First);
        const secondSettings: ExecutionClientSettings = fixture.settings(ExecutionLane.Second);
        await using policy: ExecutionPolicy = await ExecutionConfiguration.loadPolicy(
            fixture.identity,
            firstSettings,
        );
        using mac: MockInstance<typeof ExecutionAppArmorInstaller.assertInstalled> = vi
            .spyOn(ExecutionAppArmorInstaller, 'assertInstalled')
            .mockResolvedValue();
        await ExecutionAppArmorInstaller.assertInstalled(policy.definition);
        expect(mac).toHaveBeenCalledOnce();
        await using first: ExecutionClient = await ExecutionClient.load(
            fixture.identity,
            firstSettings,
            policy,
        );
        await using second: ExecutionClient = await ExecutionClient.load(
            fixture.identity,
            secondSettings,
            policy,
        );
        await first[Symbol.asyncDispose]();
        policy.assertSource(firstSettings.policyFile, [firstSettings.stateDirectory]);
        expect(
            await policy.inspectWorkspace(
                fixture.native.executionRootId,
                (root: WorkspaceInspection): Promise<boolean> =>
                    Promise.resolve(fstatSync(root.descriptor).isDirectory()),
                new AbortController().signal,
            ),
        ).toBe(true);
        expect(second.failed).toBe(false);
        await using released: ConnectorOperationJournal<
            ExecutionRequest,
            ExecutionResult,
            ExecutionOutput
        > = await ConnectorOperationJournal.load(
            join(firstSettings.stateDirectory, ExecutionLane.First),
            fixture.identity.settings.enrollmentId,
            fixture.identity.key,
            new ExecutionJournalCodec(ExecutionLane.First),
        );
        expect(released.pending).toBe(null);
        await expect(
            ConnectorOperationJournal.load(
                join(secondSettings.stateDirectory, ExecutionLane.Second),
                fixture.identity.settings.enrollmentId,
                fixture.identity.key,
                new ExecutionJournalCodec(ExecutionLane.Second),
            ),
        ).rejects.toThrow();
    },
);

it.skipIf(!helpers)(
    'failed second-lane startup joins first-lane disposal before closing the shared policy or releasing installation exclusion',
    async (): Promise<void> => {
        await using fixture: SharedExecutionFixture = await SharedExecutionFixture.create();
        using mac: MockInstance<typeof ExecutionAppArmorInstaller.assertInstalled> = vi
            .spyOn(ExecutionAppArmorInstaller, 'assertInstalled')
            .mockResolvedValue();
        const actualLoad: typeof ExecutionClient.load = ExecutionClient.load.bind(ExecutionClient);
        const disposing: PromiseWithResolvers<ExecutionPolicy> =
            Promise.withResolvers<ExecutionPolicy>();
        const release: PromiseWithResolvers<undefined> = Promise.withResolvers<undefined>();
        const stops: MockInstance<ExecutionClient[typeof Symbol.asyncDispose]>[] = [];
        using load: MockInstance<typeof ExecutionClient.load> = vi
            .spyOn(ExecutionClient, 'load')
            .mockImplementation(
                async (
                    identity: ConnectorClientIdentity,
                    settings: ExecutionClientSettings,
                    policy: ExecutionPolicy,
                ): Promise<ExecutionClient> => {
                    if (settings.lane === ExecutionLane.Second) {
                        throw new Error('Owned second-lane startup failure');
                    }
                    const client: ExecutionClient = await actualLoad(identity, settings, policy);
                    const dispose: () => Promise<void> = client[Symbol.asyncDispose].bind(client);
                    stops.push(
                        vi
                            .spyOn(client, Symbol.asyncDispose)
                            .mockImplementation(async (): Promise<void> => {
                                disposing.resolve(policy);
                                await release.promise;
                                await dispose();
                            }),
                    );
                    return client;
                },
            );
        const started: Promise<ConnectorClientExecution> = ConnectorClientExecution.load(
            fixture.identity,
        );
        const joined: Promise<readonly PromiseSettledResult<ConnectorClientExecution>[]> =
            Promise.allSettled([started]);
        try {
            const policy: ExecutionPolicy = await Promise.race([
                disposing.promise,
                (async (): Promise<never> => {
                    await started;
                    throw new Error('Partial startup unexpectedly completed');
                })(),
            ]);
            policy.assertSource(fixture.native.executionPolicy, []);
            await expect(
                ConnectorPrivateDirectory.open(
                    fixture.settings(ExecutionLane.First).stateDirectory,
                    ConnectorDirectoryPurpose.Execution,
                ),
            ).rejects.toThrow();
            release.resolve(undefined);
            await expect(started).rejects.toThrow('second-lane');
            expect((): void => policy.assertSource(fixture.native.executionPolicy, [])).toThrow(
                'authority',
            );
            expect(load).toHaveBeenCalledTimes(2);
            expect(mac).toHaveBeenCalledOnce();
        } finally {
            release.resolve(undefined);
            await joined;
            for (const stop of stops) {
                stop.mockRestore();
            }
        }
        await using installation: ConnectorPrivateDirectory = await ConnectorPrivateDirectory.open(
            fixture.settings(ExecutionLane.First).stateDirectory,
            ConnectorDirectoryPurpose.Execution,
        );
        expect(installation.directory).toBe(fixture.settings(ExecutionLane.First).stateDirectory);
        await using journal: ConnectorOperationJournal<
            ExecutionRequest,
            ExecutionResult,
            ExecutionOutput
        > = await ConnectorOperationJournal.load(
            join(fixture.settings(ExecutionLane.First).stateDirectory, ExecutionLane.First),
            fixture.identity.settings.enrollmentId,
            fixture.identity.key,
            new ExecutionJournalCodec(ExecutionLane.First),
        );
        expect(journal.pending).toBe(null);
    },
);

it.skipIf(!helpers)(
    'a lane refuses unrelated source, incomplete protected references and closed borrowed policy before touching its journal',
    async (): Promise<void> => {
        await using fixture: SharedExecutionFixture = await SharedExecutionFixture.create();
        const settings: ExecutionClientSettings = fixture.settings(ExecutionLane.First);
        const original: Buffer = await readFile(
            join(settings.stateDirectory, settings.lane, 'execution-journal'),
        );
        await using incomplete: ExecutionPolicy = await ExecutionPolicy.load(
            settings.policyFile,
            [],
        );
        await expect(ExecutionClient.load(fixture.identity, settings, incomplete)).rejects.toThrow(
            'authority',
        );
        await using current: ExecutionPolicy = await ExecutionConfiguration.loadPolicy(
            fixture.identity,
            settings,
        );
        await expect(
            ExecutionClient.load(
                fixture.identity,
                { ...settings, policyFile: fixture.native.filePolicy },
                current,
            ),
        ).rejects.toThrow('installation');
        await current[Symbol.asyncDispose]();
        await expect(ExecutionClient.load(fixture.identity, settings, current)).rejects.toThrow(
            'authority',
        );
        expect(
            (
                await readFile(join(settings.stateDirectory, settings.lane, 'execution-journal'))
            ).equals(original),
        ).toBe(true);
        await using journal: ConnectorOperationJournal<
            ExecutionRequest,
            ExecutionResult,
            ExecutionOutput
        > = await ConnectorOperationJournal.load(
            join(settings.stateDirectory, settings.lane),
            fixture.identity.settings.enrollmentId,
            fixture.identity.key,
            new ExecutionJournalCodec(settings.lane),
        );
        expect(journal.pending).toBe(null);
    },
);
