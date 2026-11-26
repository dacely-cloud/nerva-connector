// SPDX-FileCopyrightText: 2026 Dacely <business@dacely.com>
// SPDX-License-Identifier: LicenseRef-Proprietary

import { randomBytes, createHash } from 'node:crypto';
import { expect, it } from 'vitest';
import { ExecutionPipeFixture } from './support/ExecutionPipeFixture.js';
import { ExecutionAppArmorMode } from '../src/execution/ExecutionAppArmorProfile.js';
import { ExecutionBootstrapInputKind } from '../src/execution/ExecutionBootstrapInput.js';
import { ExecutionNativePipeHandle } from '../src/execution/ExecutionNativePipeHandle.js';
import {
    ExecutionNativePipeCommandKind,
    ExecutionNativePipeEventKind,
} from '../src/execution/ExecutionNativePipeProtocol.js';
import type { ExecutionMachineEnvironmentValue } from 'nerva-connector-protocol/execution/ExecutionMachineInvocation.js';
import {
    ExecutionSetupFailure,
    ExecutionTermination,
    ExecutionWorkspaceAccess,
    type ExecutionResult,
} from 'nerva-connector-protocol/execution/ExecutionTypes.js';
import { type ExecutionBootstrap } from '../src/execution/ExecutionBootstrap.js';

const helper: string | undefined = process.env['NERVA_CONNECTOR_EXEC_HELPER'];

it.skipIf(helper === undefined)(
    'actual candidate accepts maximum C0 argv, all32 positions, full environment and NUL initial0 under genuine Pipe confinement',
    async (): Promise<void> => {
        if (helper === undefined) {
            throw new Error('Explicit unused candidate required');
        }
        await using fixture: ExecutionPipeFixture = await ExecutionPipeFixture.create(helper);
        const initial: Buffer = Buffer.alloc(1024);
        const incarnation: string = randomBytes(32).toString('hex');
        const pipe: ExecutionNativePipeHandle = new ExecutionNativePipeHandle(
            incarnation,
            initial.toString(),
            { maximumInputBytes: 65536n, maximumControls: 256 },
            BigInt(Date.now()) + 60000n,
        );
        const base: ExecutionBootstrap = await fixture.native.configuration(
            'bootstrap-bounds',
            ExecutionWorkspaceAccess.ReadWrite,
            ExecutionAppArmorMode.Pipe,
        );
        const args: readonly string[] = [
            'bootstrap-bounds',
            ...Array.from({ length: 31 }, (_unused: unknown, index: number): string =>
                '\u0001'.repeat(index === 0 ? 4074 : index === 1 ? 4073 : 1),
            ),
        ];
        const environment: readonly ExecutionMachineEnvironmentValue[] = [
            ...Array.from(
                { length: 15 },
                (_unused: unknown, index: number): ExecutionMachineEnvironmentValue => ({
                    name: 'APP' + index.toString().padStart(2, '0'),
                    value: '\u0001'.repeat(index === 0 ? 66 : 62),
                }),
            ),
            { name: 'APP_MODE', value: 'fixture' },
        ];
        const configuration: ExecutionBootstrap = {
            ...base,
            arguments: args,
            input: {
                kind: ExecutionBootstrapInputKind.Pipe,
                executionDeadlineMs: pipe.executionDeadlineMs,
                cwd: 'nested',
                environment,
                stdin: initial.toString(),
                incarnation,
                guardianProfile: base.apparmorProfile.replace(
                    'nerva-connector-exec-',
                    'nerva-connector-guard-',
                ),
                maximumInputBytes: 65536n,
                maximumControls: 256,
            },
        };
        expect(
            args.reduce((size: number, arg: string): number => size + Buffer.byteLength(arg), 0),
        ).toBe(8192);
        expect(
            environment.reduce(
                (size: number, entry: ExecutionMachineEnvironmentValue): number =>
                    size + Buffer.byteLength(entry.name) + Buffer.byteLength(entry.value),
                0,
            ),
        ).toBe(1024);
        const task: Promise<ExecutionResult> = fixture.native.sandbox.execute(
            randomBytes(32).toString('hex'),
            configuration,
            fixture.native.limits,
            3000,
            AbortSignal.timeout(5000),
            await fixture.native.admission(),
            null,
            pipe,
        );
        const joined: Promise<PromiseSettledResult<ExecutionResult>[]> = Promise.allSettled([task]);
        try {
            expect((await pipe.ready).kind).toBe(ExecutionNativePipeEventKind.Ready);
            expect(
                (
                    await pipe.send({
                        kind: ExecutionNativePipeCommandKind.Data,
                        deliveryExpiresAtMs: pipe.executionDeadlineMs,
                        incarnation,
                        inputSequence: 0n,
                        offset: 0n,
                        inputHash: randomBytes(32).toString('hex'),
                        dataHash: createHash('sha256').update(initial).digest('hex'),
                        byteLength: 1024n,
                        dataBase64: initial.toString('base64'),
                    })
                ).kind,
            ).toBe(ExecutionNativePipeEventKind.Applied);
            expect(
                (
                    await pipe.send({
                        kind: ExecutionNativePipeCommandKind.End,
                        deliveryExpiresAtMs: pipe.executionDeadlineMs,
                        incarnation,
                        inputSequence: 1n,
                        offset: 1024n,
                        inputHash: randomBytes(32).toString('hex'),
                    })
                ).kind,
            ).toBe(ExecutionNativePipeEventKind.Applied);
            const result: ExecutionResult = await task;
            expect(result.setupFailure).toBeNull();
            expect(result.termination).toBe(ExecutionTermination.Exited);
            expect(result.exitCode).toBe(0);
            expect(Buffer.from(result.stdoutBase64, 'base64')).toEqual(initial);
            expect(Buffer.from(result.stderrBase64, 'base64').toString()).toBe('real EOF\n');
        } finally {
            pipe.close();
            await joined;
        }
    },
);

it.skipIf(helper === undefined)(
    'actual unused helper rejects unknown bootstrap fields before any native Ready or application input',
    async (): Promise<void> => {
        if (helper === undefined) {
            throw new Error('Explicit unused native candidate required');
        }
        await using fixture: ExecutionPipeFixture = await ExecutionPipeFixture.create(helper);
        const incarnation: string = randomBytes(32).toString('hex');
        const pipe: ExecutionNativePipeHandle = new ExecutionNativePipeHandle(
            incarnation,
            '',
            {
                maximumInputBytes: 65536n,
                maximumControls: 256,
            },
            BigInt(Date.now()) + 60000n,
        );
        const base: ExecutionBootstrap = await fixture.native.configuration(
            'hold',
            ExecutionWorkspaceAccess.ReadWrite,
            ExecutionAppArmorMode.Pipe,
        );
        const configuration: ExecutionBootstrap = {
            ...base,
            input: {
                kind: ExecutionBootstrapInputKind.Pipe,
                executionDeadlineMs: pipe.executionDeadlineMs,
                cwd: 'nested',
                environment: [{ name: 'APP_MODE', value: 'fixture' }],
                stdin: '',
                incarnation,
                guardianProfile: base.apparmorProfile.replace(
                    'nerva-connector-exec-',
                    'nerva-connector-guard-',
                ),
                maximumInputBytes: 65536n,
                maximumControls: 256,
            },
        };
        Reflect.defineProperty(configuration, 'unknown', { value: true, enumerable: true });
        try {
            const task: Promise<ExecutionResult> = fixture.native.sandbox.execute(
                randomBytes(32).toString('hex'),
                configuration,
                fixture.native.limits,
                3000,
                AbortSignal.timeout(5000),
                await fixture.native.admission(),
                null,
                pipe,
            );
            await expect(pipe.ready).rejects.toThrow();
            expect(await task).toMatchObject({
                setupFailure: ExecutionSetupFailure.Bootstrap,
                exitCode: null,
                termination: ExecutionTermination.Indeterminate,
            });
            expect(pipe.cursor()).toMatchObject({
                initialAccepted: false,
                acceptedOffset: 0n,
                processedSequence: null,
            });
        } finally {
            pipe.close();
        }
    },
);
