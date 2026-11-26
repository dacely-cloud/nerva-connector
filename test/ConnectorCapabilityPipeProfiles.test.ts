// SPDX-FileCopyrightText: 2026 Dacely <business@dacely.com>
// SPDX-License-Identifier: LicenseRef-Proprietary

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, it, vi, type MockInstance } from 'vitest';
import { ConnectorServiceFixture } from './support/ConnectorServiceFixture.js';
import { ExecutionMachineFixture } from './support/ExecutionMachineFixture.js';
import { ConnectorCapabilityInstallation } from '../src/install/ConnectorCapabilityInstallation.js';
import {
    ConnectorCapabilityPlans,
    type ConnectorCapabilityPlan,
    type ConnectorCapabilityRequest,
} from '../src/install/ConnectorCapabilityPlan.js';
import {
    ConnectorCapabilityPhase,
    ConnectorCapabilityState,
    type ConnectorCapabilityRecord,
} from '../src/install/ConnectorCapabilityState.js';
import { ProtectedFiles } from '../src/local/ProtectedFiles.js';
import {
    ConnectorClientConfiguration,
    type ConnectorClientIdentity,
} from '../src/runtime/ConnectorClientConfiguration.js';
import type { ConnectorClientSettings } from '../src/runtime/ConnectorClientSettings.js';
import {
    ConnectorPrivateDirectory,
    ConnectorDirectoryPurpose,
} from '../src/runtime/ConnectorPrivateDirectory.js';
import { ExecutionPairPreparation } from '../src/execution/ExecutionPairPreparation.js';
import { ExecutionAppArmorInstaller } from '../src/execution/ExecutionAppArmorInstaller.js';
import {
    ExecutionAppArmorMode,
    ExecutionAppArmorProfile,
    type ExecutionAppArmorDefinition,
} from '../src/execution/ExecutionAppArmorProfile.js';
import { ExecutionInteractiveRuleCodec } from 'nerva-connector-protocol/execution/ExecutionInteractiveRuleCodec.js';
import { ExecutionInteractiveTransport } from 'nerva-connector-protocol/execution/ExecutionInteractive.js';
import { ExecutionInputKind } from 'nerva-connector-protocol/execution/ExecutionInput.js';
import {
    type ExecutionPolicyDefinition,
    type ExecutionProgramPolicy,
} from 'nerva-connector-protocol/execution/ExecutionPolicyTypes.js';
import { ExecutionArgumentKind } from 'nerva-connector-protocol/execution/ExecutionArgumentKind.js';

/** Composition is exercised for both production mode sets without invoking native payloads. */
enum CapabilityExecutionModes {
    Pipe = 'pipe',
    Mixed = 'mixed',
}

/** Real signed local installation and durable setup intent surround injected preflight/kernel seams; no native journal or payload runs. */
class CapabilityPipeFixture implements AsyncDisposable {
    private constructor(
        public readonly service: ConnectorServiceFixture,
        public readonly definition: ExecutionPolicyDefinition,
        public readonly plan: ConnectorCapabilityPlan,
        public readonly requestFile: string,
    ) {}

    public static async create(modes: CapabilityExecutionModes): Promise<CapabilityPipeFixture> {
        const service: ConnectorServiceFixture = await ConnectorServiceFixture.create();
        try {
            const cgroupRoot: string = join(service.release.directory, 'cgroups');
            await mkdir(cgroupRoot, { mode: 0o700 });
            const pipe: ExecutionProgramPolicy = {
                ...ExecutionMachineFixture.program(),
                id: 'pipe',
                arguments: [
                    ExecutionInteractiveRuleCodec.read({
                        kind: ExecutionArgumentKind.InteractiveInvocation,
                        invocation: ExecutionMachineFixture.rule(),
                        transports: [ExecutionInteractiveTransport.Pipe],
                        controls: [ExecutionInputKind.Data, ExecutionInputKind.End],
                        maximumInputBytes: '65536',
                        maximumControls: 256,
                        maximumResizes: 0,
                    }),
                ],
            };
            const definition: ExecutionPolicyDefinition = {
                ...ExecutionMachineFixture.policy(),
                cgroupRoot,
                programs:
                    modes === CapabilityExecutionModes.Mixed
                        ? [ExecutionMachineFixture.program(), pipe]
                        : [pipe],
            };
            const bytes: Buffer = Buffer.from(
                JSON.stringify(definition, (_key: string, value: unknown): unknown =>
                    typeof value === 'bigint' ? value.toString() : value,
                ),
            );
            const executionPolicyFile: string = join(
                service.release.directory,
                'approved-execution.json',
            );
            await writeFile(executionPolicyFile, bytes, { mode: 0o600 });
            const request: ConnectorCapabilityRequest = {
                installationDirectory: service.layout.installationDirectory,
                filesPolicyFile: null,
                executionPolicyFile,
            };
            const requestFile: string = join(service.release.directory, 'capability-request.json');
            await writeFile(requestFile, JSON.stringify(request), { mode: 0o600 });
            return new CapabilityPipeFixture(
                service,
                definition,
                { request, files: null, execution: { bytes, execution: definition } },
                requestFile,
            );
        } catch (caught: unknown) {
            await service[Symbol.asyncDispose]();
            throw caught;
        }
    }

    public get runtimeFile(): string {
        return join(this.service.layout.installationDirectory, 'state/device.json');
    }

    public get capabilityDirectory(): string {
        return join(this.service.layout.installationDirectory, 'capabilities');
    }

    public async phase(phase: ConnectorCapabilityPhase): Promise<void> {
        await using owner: ConnectorPrivateDirectory = await ConnectorPrivateDirectory.open(
            this.capabilityDirectory,
            ConnectorDirectoryPurpose.Installation,
        );
        const record: ConnectorCapabilityRecord | null = await ConnectorCapabilityState.read(owner);
        if (record === null) {
            throw new Error('Actual retained setup intent required');
        }
        if (phase === ConnectorCapabilityPhase.Active) {
            const identity: ConnectorClientIdentity = await ConnectorClientConfiguration.load(
                this.runtimeFile,
            );
            using secrets: DisposableStack = new DisposableStack();
            secrets.use(identity.key);
            const target: ConnectorClientSettings = {
                ...identity.settings,
                execution: {
                    policyFile: join(this.capabilityDirectory, 'execution-policy.json'),
                    stateDirectory: join(this.capabilityDirectory, 'execution'),
                },
            };
            const bytes: Buffer = Buffer.from(JSON.stringify(target));
            expect(ConnectorCapabilityState.hash(bytes)).toBe(record.targetSha256);
            await writeFile(this.runtimeFile, bytes, { mode: 0o600 });
        }
        await ConnectorCapabilityState.write(owner, { ...record, phase }, false);
    }

    public async [Symbol.asyncDispose](): Promise<void> {
        await this.service[Symbol.asyncDispose]();
    }
}

it.each(Object.values(CapabilityExecutionModes))(
    'actual capability installer composes %s profile requirements before preparation and rechecks every retained phase without reinstalling',
    async (modes: CapabilityExecutionModes): Promise<void> => {
        await using fixture: CapabilityPipeFixture = await CapabilityPipeFixture.create(modes);
        using plan: MockInstance<typeof ConnectorCapabilityPlans.read> = vi
            .spyOn(ConnectorCapabilityPlans, 'read')
            .mockResolvedValue(fixture.plan);
        using install: MockInstance<typeof ExecutionAppArmorInstaller.install> = vi
            .spyOn(ExecutionAppArmorInstaller, 'install')
            .mockImplementation(
                (
                    definition: ExecutionPolicyDefinition,
                    mode: ExecutionAppArmorMode = ExecutionAppArmorMode.Foreground,
                ): Promise<ExecutionAppArmorDefinition> =>
                    Promise.resolve(ExecutionAppArmorProfile.generate(definition, mode)),
            );
        using prepare: MockInstance<typeof ExecutionPairPreparation.prepare> = vi
            .spyOn(ExecutionPairPreparation, 'prepare')
            .mockRejectedValue(new Error('Controlled native journal boundary'));
        const expected: readonly ExecutionAppArmorMode[] =
            modes === CapabilityExecutionModes.Mixed
                ? [ExecutionAppArmorMode.Foreground, ExecutionAppArmorMode.Pipe]
                : [ExecutionAppArmorMode.Pipe];
        const names: readonly string[] = expected.flatMap(
            (mode: ExecutionAppArmorMode): readonly string[] => {
                const profile: ExecutionAppArmorDefinition = ExecutionAppArmorProfile.generate(
                    fixture.definition,
                    mode,
                );
                return [
                    profile.name,
                    profile.launcherName,
                    ...(profile.guardianName === null ? [] : [profile.guardianName]),
                ];
            },
        );
        const pipe: ExecutionAppArmorDefinition = ExecutionAppArmorProfile.generate(
            fixture.definition,
            ExecutionAppArmorMode.Pipe,
        );
        let missing: boolean = true;
        const original: typeof ProtectedFiles.readTrusted =
            ProtectedFiles.readTrusted.bind(ProtectedFiles);
        using inventory: MockInstance<typeof ProtectedFiles.readTrusted> = vi
            .spyOn(ProtectedFiles, 'readTrusted')
            .mockImplementation(
                async (path: string, maximumBytes: number, secret: boolean): Promise<Buffer> => {
                    if (path !== '/sys/kernel/security/apparmor/profiles') {
                        return await original(path, maximumBytes, secret);
                    }
                    return Buffer.from(
                        names
                            .filter(
                                (name: string): boolean => !missing || name !== pipe.guardianName,
                            )
                            .map((name: string): string => name + ' (enforce)')
                            .join('\n'),
                    );
                },
            );
        const runtime: Buffer = await readFile(fixture.runtimeFile);
        await expect(
            ConnectorCapabilityInstallation.install(
                fixture.requestFile,
                AbortSignal.timeout(10000),
            ),
        ).rejects.toThrow('not installed');
        expect(prepare).not.toHaveBeenCalled();
        expect(await readFile(fixture.runtimeFile)).toEqual(runtime);
        missing = false;
        install.mockClear();
        await expect(
            ConnectorCapabilityInstallation.install(
                fixture.requestFile,
                AbortSignal.timeout(10000),
            ),
        ).rejects.toThrow('Controlled native journal boundary');
        expect(install.mock.calls).toEqual(
            expected.map(
                (
                    mode: ExecutionAppArmorMode,
                ): readonly [ExecutionPolicyDefinition, ExecutionAppArmorMode] => [
                    fixture.definition,
                    mode,
                ],
            ),
        );
        expect(prepare).toHaveBeenCalledOnce();
        expect(await readFile(fixture.runtimeFile)).toEqual(runtime);
        const installationCalls: number = install.mock.calls.length;
        missing = true;
        let retainedRuntime: Buffer = runtime;
        for (const phase of [ConnectorCapabilityPhase.Prepared, ConnectorCapabilityPhase.Active]) {
            await fixture.phase(phase);
            retainedRuntime = await readFile(fixture.runtimeFile);
            await expect(
                ConnectorCapabilityInstallation.install(
                    fixture.requestFile,
                    AbortSignal.timeout(10000),
                ),
            ).rejects.toThrow('not installed');
            expect(await readFile(fixture.runtimeFile)).toEqual(retainedRuntime);
            expect(install).toHaveBeenCalledTimes(installationCalls);
            expect(prepare).toHaveBeenCalledOnce();
        }
        const replacement: Buffer = Buffer.from('changed approved policy bytes');
        plan.mockResolvedValue({
            ...fixture.plan,
            execution: { bytes: replacement, execution: fixture.definition },
        });
        await expect(
            ConnectorCapabilityInstallation.install(
                fixture.requestFile,
                AbortSignal.timeout(10000),
            ),
        ).rejects.toThrow('original intent');
        expect(install).toHaveBeenCalledTimes(installationCalls);
        expect(await readFile(fixture.runtimeFile)).toEqual(retainedRuntime);
        expect(inventory).toHaveBeenCalled();
    },
);
