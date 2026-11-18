// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

import { ConnectorAuthorizationKind } from 'nerva-connector-protocol/protocol/ConnectorAuthorization.js';
import { ConnectorAuthorizationProof } from 'nerva-connector-protocol/protocol/ConnectorAuthorizationProof.js';
import { createHash } from 'node:crypto';
import { readFile, writeFile, access, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { expect, it, vi, type MockInstance } from 'vitest';
import { Boundary } from 'nerva-connector-protocol/protocol/Boundary.js';
import { ExecutionAppArmorInstaller } from '../src/execution/ExecutionAppArmorInstaller.js';
import type {
    ExecutionPolicyDefinition,
    ExecutionRootPolicy,
} from 'nerva-connector-protocol/execution/ExecutionPolicyTypes.js';
import { ExecutionJournalCodec } from '../src/execution/ExecutionJournalCodec.js';
import { type ExecutionRequest } from 'nerva-connector-protocol/execution/ExecutionJobs.js';
import { ExecutionLane } from 'nerva-connector-protocol/execution/ExecutionLane.js';
import { ExecutionJobsCodec } from '../src/execution/ExecutionJobsCodec.js';
import { ExecutionProof } from 'nerva-connector-protocol/execution/ExecutionProof.js';
import type { ExecutionResult } from 'nerva-connector-protocol/execution/ExecutionTypes.js';
import type { ExecutionOutput } from 'nerva-connector-protocol/execution/ExecutionOutput.js';
import { ConnectorEffectKind } from '../src/runtime/ConnectorEffectContext.js';
import { ConnectorOperationJournal } from '../src/runtime/ConnectorOperationJournal.js';
import {
    ConnectorPrivateDirectory,
    ConnectorDirectoryPurpose,
} from '../src/runtime/ConnectorPrivateDirectory.js';
import { JointWorkspaceCapture } from '../src/workspace/JointWorkspaceCapture.js';
import { JointWorkspaceConfiguration } from '../src/workspace/JointWorkspaceConfiguration.js';
import { JointWorkspaceInstallation } from '../src/workspace/JointWorkspaceInstallation.js';
import { JointWorkspaceJournal } from '../src/workspace/JointWorkspaceJournal.js';
import { JointWorkspaceInstallationFixture } from './support/JointWorkspaceInstallationFixture.js';

const helpers: boolean =
    process.platform === 'linux' &&
    process.env['NERVA_CONNECTOR_FILES_HELPER'] !== undefined &&
    process.env['NERVA_CONNECTOR_EXEC_HELPER'] !== undefined;

it.skipIf(!helpers)(
    'approval input inside an existing customer root is refused before creating any workspace setup state',
    async (): Promise<void> => {
        await using fixture: JointWorkspaceInstallationFixture =
            await JointWorkspaceInstallationFixture.create();
        using mac: MockInstance<typeof ExecutionAppArmorInstaller.assertInstalled> = vi
            .spyOn(ExecutionAppArmorInstaller, 'assertInstalled')
            .mockResolvedValue();
        const input: string = join(fixture.source.native.root, 'untrusted-workspace-request.json');
        await writeFile(input, JointWorkspaceConfiguration.encode(fixture.mapping), {
            mode: 0o600,
        });
        const original: readonly Buffer[] = await fixture.originalBytes();
        await expect(
            JointWorkspaceInstallation.initialize(
                fixture.identity.configurationFile,
                input,
                fixture.signal,
            ),
        ).rejects.toThrow();
        expect(mac).toHaveBeenCalledOnce();
        expect(await fixture.originalBytes()).toEqual(original);
        await expect(access(fixture.paths.setupFile)).rejects.toThrow();
        await expect(access(fixture.paths.stateDirectory)).rejects.toThrow();
    },
);

it.skipIf(!helpers)(
    'an actual physically different second pair cannot publish the mapping or erase the completed first descriptor',
    async (): Promise<void> => {
        await using fixture: JointWorkspaceInstallationFixture =
            await JointWorkspaceInstallationFixture.create(true);
        using mac: MockInstance<typeof ExecutionAppArmorInstaller.assertInstalled> = vi
            .spyOn(ExecutionAppArmorInstaller, 'assertInstalled')
            .mockResolvedValue();
        const definition: ExecutionPolicyDefinition = fixture.source.native.executionDefinition;
        const first: ExecutionRootPolicy | undefined = definition.roots[0];
        if (first === undefined) {
            throw new Error('Original fixture root required');
        }
        const third: string = join(fixture.source.native.directory, 'third-project');
        await mkdir(third, { mode: 0o700 });
        await writeFile(
            fixture.source.native.executionPolicy,
            JointWorkspaceInstallationFixture.encode({
                ...definition,
                roots: [
                    ...definition.roots,
                    {
                        id: 'commands-second',
                        path: third,
                        access: first.access,
                    },
                ],
            }),
            { mode: 0o600 },
        );
        using capture: MockInstance<typeof JointWorkspaceCapture.prototype.capture> = vi.spyOn(
            JointWorkspaceCapture.prototype,
            'capture',
        );
        await expect(
            JointWorkspaceInstallation.initialize(
                fixture.identity.configurationFile,
                fixture.requestFile,
                fixture.signal,
            ),
        ).rejects.toThrow();
        expect(capture).toHaveBeenCalledTimes(2);
        expect(mac).toHaveBeenCalledOnce();
        expect(
            await JointWorkspaceConfiguration.read(fixture.identity.settings.privateKeyFile),
        ).toBeNull();
        await access(fixture.paths.setupFile);
        await access(join(fixture.paths.stateDirectory, 'workspace-binding-1'));
        await expect(
            access(join(fixture.paths.stateDirectory, 'workspace-binding-2')),
        ).rejects.toThrow();
    },
);

it.skipIf(!helpers)(
    'changed source policy after completed setup is refused without recapture, allocation or rewriting original history',
    async (): Promise<void> => {
        await using fixture: JointWorkspaceInstallationFixture =
            await JointWorkspaceInstallationFixture.create();
        using mac: MockInstance<typeof ExecutionAppArmorInstaller.assertInstalled> = vi
            .spyOn(ExecutionAppArmorInstaller, 'assertInstalled')
            .mockResolvedValue();
        await JointWorkspaceInstallation.initialize(
            fixture.identity.configurationFile,
            fixture.requestFile,
            fixture.signal,
        );
        const head: Buffer = await readFile(join(fixture.paths.stateDirectory, 'workspace-head'));
        const archive: Buffer = await readFile(
            join(fixture.paths.stateDirectory, 'workspace-binding-1'),
        );
        const original: unknown = JSON.parse(
            await readFile(fixture.source.native.filePolicy, 'utf8'),
        );
        const policy: Readonly<Record<string, unknown>> = Boundary.record(original, [
            'mode',
            'revision',
            'helperFile',
            'helperSha256',
            'roots',
        ]);
        await writeFile(
            fixture.source.native.filePolicy,
            JSON.stringify({ ...policy, revision: '2' }),
            { mode: 0o600 },
        );
        using capture: MockInstance<typeof JointWorkspaceCapture.prototype.capture> = vi.spyOn(
            JointWorkspaceCapture.prototype,
            'capture',
        );
        await expect(
            JointWorkspaceInstallation.initialize(
                fixture.identity.configurationFile,
                fixture.requestFile,
                fixture.signal,
            ),
        ).rejects.toThrow();
        expect(capture).not.toHaveBeenCalled();
        expect(mac).toHaveBeenCalled();
        expect(await readFile(join(fixture.paths.stateDirectory, 'workspace-head'))).toEqual(head);
        expect(await readFile(join(fixture.paths.stateDirectory, 'workspace-binding-1'))).toEqual(
            archive,
        );
        await expect(access(fixture.paths.setupFile)).rejects.toThrow();
    },
);

it.skipIf(!helpers)(
    'an original pending command blocks every setup mutation while its ciphertext remains byte-identical',
    async (): Promise<void> => {
        await using fixture: JointWorkspaceInstallationFixture =
            await JointWorkspaceInstallationFixture.create();
        using mac: MockInstance<typeof ExecutionAppArmorInstaller.assertInstalled> = vi
            .spyOn(ExecutionAppArmorInstaller, 'assertInstalled')
            .mockResolvedValue();
        const settings: typeof fixture.identity.settings.execution =
            fixture.identity.settings.execution;
        if (settings === null) {
            throw new Error('Actual original execution journals required');
        }
        const request: ExecutionRequest = ExecutionJobsCodec.request({
            requestId: 'pending-original',
            policySha256: createHash('sha256')
                .update(await readFile(settings.policyFile))
                .digest('hex'),
            rootId: fixture.source.native.executionRootId,
            programId: 'probe',
            arguments: [],
        });
        {
            await using lane: ConnectorOperationJournal<
                ExecutionRequest,
                ExecutionResult,
                ExecutionOutput
            > = await ConnectorOperationJournal.load(
                join(settings.stateDirectory, ExecutionLane.First),
                fixture.identity.settings.enrollmentId,
                fixture.identity.key,
                new ExecutionJournalCodec(ExecutionLane.First),
            );
            await lane.begin(
                {
                    jobId: 'original-job',
                    sequence: 1n,
                    dispatchId: Buffer.alloc(32).toString('base64url'),
                    request,
                    requestHash: ExecutionProof.requestHash(request),
                    authorization: { kind: ConnectorAuthorizationKind.Independent },
                    admissionHash: ConnectorAuthorizationProof.execution(
                        ExecutionProof.requestHash(request),
                        ExecutionLane.First,
                        { kind: ConnectorAuthorizationKind.Independent },
                    ),
                },
                { kind: ConnectorEffectKind.ExecutionNotStarted },
            );
        }
        const original: readonly Buffer[] = await fixture.originalBytes();
        await expect(
            JointWorkspaceInstallation.initialize(
                fixture.identity.configurationFile,
                fixture.requestFile,
                fixture.signal,
            ),
        ).rejects.toThrow();
        expect(await fixture.originalBytes()).toEqual(original);
        expect(mac).toHaveBeenCalledOnce();
        await expect(access(fixture.paths.setupFile)).rejects.toThrow();
        await expect(access(fixture.paths.stateDirectory)).rejects.toThrow();
    },
);

it.skipIf(!helpers)(
    'the actual live Runtime lock prevents setup before any installation mutation',
    async (): Promise<void> => {
        await using fixture: JointWorkspaceInstallationFixture =
            await JointWorkspaceInstallationFixture.create();
        await using runtime: ConnectorPrivateDirectory = await ConnectorPrivateDirectory.open(
            dirname(fixture.identity.settings.privateKeyFile),
            ConnectorDirectoryPurpose.Runtime,
        );
        const original: readonly Buffer[] = await fixture.originalBytes();
        await expect(
            JointWorkspaceInstallation.initialize(
                fixture.identity.configurationFile,
                fixture.requestFile,
                fixture.signal,
            ),
        ).rejects.toThrow();
        expect(await fixture.originalBytes()).toEqual(original);
        await expect(access(fixture.paths.setupFile)).rejects.toThrow();
        await expect(access(fixture.paths.stateDirectory)).rejects.toThrow();
        expect(runtime.directory).toBe(dirname(fixture.identity.settings.privateKeyFile));
    },
);

it.skipIf(!helpers)(
    'a prepared intent without a historical head remains explicit fail-closed state across exact retries',
    async (): Promise<void> => {
        await using fixture: JointWorkspaceInstallationFixture =
            await JointWorkspaceInstallationFixture.create();
        using mac: MockInstance<typeof ExecutionAppArmorInstaller.assertInstalled> = vi
            .spyOn(ExecutionAppArmorInstaller, 'assertInstalled')
            .mockResolvedValue();
        using creation: MockInstance<typeof JointWorkspaceJournal.initialize> = vi
            .spyOn(JointWorkspaceJournal, 'initialize')
            .mockRejectedValue(new Error('Owned fixture interrupted before head creation'));
        await expect(
            JointWorkspaceInstallation.initialize(
                fixture.identity.configurationFile,
                fixture.requestFile,
                fixture.signal,
            ),
        ).rejects.toThrow();
        creation.mockRestore();
        const intent: Buffer = await readFile(fixture.paths.setupFile);
        using retry: MockInstance<typeof JointWorkspaceJournal.initialize> = vi.spyOn(
            JointWorkspaceJournal,
            'initialize',
        );
        await expect(
            JointWorkspaceInstallation.initialize(
                fixture.identity.configurationFile,
                fixture.requestFile,
                fixture.signal,
            ),
        ).rejects.toThrow();
        expect(retry).not.toHaveBeenCalled();
        expect(await readFile(fixture.paths.setupFile)).toEqual(intent);
        await expect(
            access(join(fixture.paths.stateDirectory, 'workspace-head')),
        ).rejects.toThrow();
        expect(mac).toHaveBeenCalled();
    },
);
