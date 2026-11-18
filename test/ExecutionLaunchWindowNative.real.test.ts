// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

import { constants } from 'node:fs';
import { open, type FileHandle } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { createHash, randomBytes } from 'node:crypto';
import { expect, it, vi, type MockInstance } from 'vitest';
import { ExecutionPipeFixture } from './support/ExecutionPipeFixture.js';
import { ExecutionCgroup } from '../src/execution/ExecutionCgroup.js';
import { ExecutionAppArmorMode } from '../src/execution/ExecutionAppArmorProfile.js';
import { ExecutionBootstrapInputKind } from '../src/execution/ExecutionBootstrapInput.js';
import { ExecutionNativePipeCommandKind } from '../src/execution/ExecutionNativePipeProtocol.js';
import { ExecutionNativePipeHandle } from '../src/execution/ExecutionNativePipeHandle.js';
import {
    ExecutionWorkspaceAccess,
    ExecutionTermination,
    type ExecutionResult,
} from 'nerva-connector-protocol/execution/ExecutionTypes.js';
import { type ExecutionBootstrap } from '../src/execution/ExecutionBootstrap.js';

const helper: string | undefined = process.env['NERVA_CONNECTOR_EXEC_HELPER'];

it.skipIf(helper === undefined).each([true, false])(
    'trusted native setup held after controller admission reports Ready only within its sealed start window (expired=%s)',
    async (expired: boolean): Promise<void> => {
        if (helper === undefined) {
            throw new Error('Explicit unused candidate required');
        }
        await using fixture: ExecutionPipeFixture = await ExecutionPipeFixture.create(helper);
        const base: ExecutionBootstrap = await fixture.native.configuration(
            'hold',
            ExecutionWorkspaceAccess.ReadWrite,
            ExecutionAppArmorMode.Pipe,
        );
        const admission: Awaited<ReturnType<typeof fixture.native.admission>> =
            await fixture.native.admission();
        const expiry: bigint = BigInt(Date.now()) + (expired ? 1000n : 10000n);
        const controller: AbortController = new AbortController();
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
        const configuration: ExecutionBootstrap = {
            ...base,
            admissionExpiresAtMs: expiry,
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
        const freezers: Set<FileHandle> = new Set();
        const thaws: Promise<PromiseSettledResult<void>[]>[] = [];
        let attach: MockInstance<ExecutionCgroup['attach']> = vi.spyOn(
            ExecutionCgroup.prototype,
            'attach',
        );
        async function paused(this: ExecutionCgroup, pid: number): Promise<void> {
            attach.mockRestore();
            try {
                await this.attach(pid);
            } finally {
                attach = vi.spyOn(ExecutionCgroup.prototype, 'attach').mockImplementation(paused);
            }
            const frozen: FileHandle = await open(
                '/proc/self/fd/' + this.directory.fd.toString() + '/cgroup.freeze',
                constants.O_WRONLY | constants.O_NOFOLLOW,
            );
            freezers.add(frozen);
            await frozen.write('1', 0, 'utf8');
            const task: Promise<void> = (async (): Promise<void> => {
                await delay(1500);
                await frozen.write('0', 0, 'utf8');
            })();
            thaws.push(Promise.allSettled([task]));
        }
        attach.mockImplementation(paused);
        try {
            const task: Promise<ExecutionResult> = fixture.native.sandbox.execute(
                randomBytes(32).toString('hex'),
                configuration,
                fixture.native.limits,
                4000,
                AbortSignal.any([controller.signal, AbortSignal.timeout(6000)]),
                {
                    ...admission,
                    expiresAtMs: expiry,
                    assertLaunch: (): void => {
                        fixture.native.assertLaunch();
                        if (BigInt(Date.now()) >= expiry) {
                            throw new Error('Test start admission expired');
                        }
                    },
                },
                null,
                pipe,
            );
            if (expired) {
                await expect(pipe.ready).rejects.toThrow();
            } else {
                await pipe.ready;
                controller.abort();
            }
            const result: ExecutionResult = await task;
            if (expired) {
                expect(BigInt(Date.now())).toBeGreaterThanOrEqual(expiry);
            }
            expect(result).toMatchObject({
                termination: ExecutionTermination.Indeterminate,
                exitCode: null,
                stdoutBase64: '',
            });
            expect(pipe.cursor()).toMatchObject({
                initialAccepted: false,
                acceptedOffset: 0n,
                processedSequence: null,
            });
        } finally {
            controller.abort();
            attach.mockRestore();
            await Promise.all(thaws);
            await Promise.all([...freezers].map((file: FileHandle): Promise<void> => file.close()));
            pipe.close();
        }
    },
);

it.skipIf(helper === undefined)(
    'a payload already admitted before short expiry retains its separate running lifetime and explicit initial0/EOF input',
    async (): Promise<void> => {
        if (helper === undefined) {
            throw new Error('Explicit unused candidate required');
        }
        await using fixture: ExecutionPipeFixture = await ExecutionPipeFixture.create(helper);
        const base: ExecutionBootstrap = await fixture.native.configuration(
            'echo',
            ExecutionWorkspaceAccess.ReadWrite,
            ExecutionAppArmorMode.Pipe,
        );
        const admission: Awaited<ReturnType<typeof fixture.native.admission>> =
            await fixture.native.admission();
        const expiry: bigint = BigInt(Date.now()) + 1000n;
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
        const configuration: ExecutionBootstrap = {
            ...base,
            admissionExpiresAtMs: expiry,
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
        const controller: AbortController = new AbortController();
        const task: Promise<ExecutionResult> = fixture.native.sandbox.execute(
            randomBytes(32).toString('hex'),
            configuration,
            fixture.native.limits,
            4000,
            AbortSignal.any([controller.signal, AbortSignal.timeout(6000)]),
            {
                ...admission,
                expiresAtMs: expiry,
                assertLaunch: (): void => {
                    if (BigInt(Date.now()) >= expiry) {
                        throw new Error('Test start admission expired');
                    }
                },
            },
            null,
            pipe,
        );
        const joined: Promise<PromiseSettledResult<ExecutionResult>[]> = Promise.allSettled([task]);
        try {
            await pipe.ready;
            await delay(Number(expiry - BigInt(Date.now()) + 20n));
            await pipe.send({
                kind: ExecutionNativePipeCommandKind.Data,
                deliveryExpiresAtMs: pipe.executionDeadlineMs,
                incarnation,
                inputSequence: 0n,
                offset: 0n,
                inputHash: randomBytes(32).toString('hex'),
                dataHash: createHash('sha256').update(Buffer.alloc(0)).digest('hex'),
                byteLength: 0n,
                dataBase64: '',
            });
            await pipe.send({
                kind: ExecutionNativePipeCommandKind.End,
                deliveryExpiresAtMs: pipe.executionDeadlineMs,
                incarnation,
                inputSequence: 1n,
                offset: 0n,
                inputHash: randomBytes(32).toString('hex'),
            });
            expect(await task).toMatchObject({
                termination: ExecutionTermination.Exited,
                exitCode: 0,
                stdoutBase64: '',
            });
        } finally {
            controller.abort();
            pipe.close();
            await joined;
        }
    },
);
