// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

import { randomBytes } from 'node:crypto';
import { readFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { expect, it } from 'vitest';
import { ExecutionFixture } from './support/ExecutionFixture.js';
import type { ExecutionCgroupIdentity } from '../src/execution/ExecutionCgroupIdentity.js';
import type { ExecutionSandboxAdmission } from '../src/execution/ExecutionSandboxAdmission.js';
import type { ExecutionOutput } from '../src/execution/ExecutionOutput.js';
import { ExecutionOutputRetentionError } from '../src/execution/ExecutionOutputRetentionError.js';
import {
    ExecutionTermination,
    ExecutionFailure,
    ExecutionWorkspaceAccess,
    type ExecutionResult,
    type ExecutionBootstrap,
    ExecutionSetupFailure,
} from '../src/execution/ExecutionTypes.js';

const helper: string | undefined = process.env['NERVA_CONNECTOR_EXEC_HELPER'];

/** A failed admission seam cannot leave this qualification waiting on an unobserved callback. */
async function commitDeadline(signal: AbortSignal): Promise<never> {
    await delay(3000, undefined, { signal });
    throw new Error('Real empty-group commit boundary was not observed');
}

it.skipIf(helper === undefined)(
    'the real empty cgroup is captured before launch and no payload runs until its admission commit completes',
    async (): Promise<void> => {
        if (helper === undefined) {
            throw new Error('Explicit native execution helper required');
        }
        await using fixture: ExecutionFixture = await ExecutionFixture.create(helper);
        const entered: PromiseWithResolvers<undefined> = Promise.withResolvers<undefined>();
        const release: PromiseWithResolvers<undefined> = Promise.withResolvers<undefined>();
        const groups: ExecutionCgroupIdentity[] = [];
        const admission: ExecutionSandboxAdmission = await fixture.admission(
            async (group: ExecutionCgroupIdentity): Promise<void> => {
                groups.push(group);
                entered.resolve(undefined);
                await release.promise;
            },
        );
        const id: string = randomBytes(32).toString('hex');
        const configuration: ExecutionBootstrap = await fixture.configuration(
            'effect',
            ExecutionWorkspaceAccess.ReadWrite,
        );
        const task: Promise<ExecutionResult> = fixture.sandbox.execute(
            id,
            configuration,
            fixture.limits,
            5000,
            AbortSignal.timeout(6000),
            admission,
        );
        const joined: Promise<PromiseSettledResult<ExecutionResult>[]> = Promise.allSettled([task]);
        const deadline: AbortController = new AbortController();
        try {
            await Promise.race([entered.promise, commitDeadline(deadline.signal)]);
            expect(groups).toHaveLength(1);
            const group: ExecutionCgroupIdentity | undefined = groups[0];
            if (group === undefined) {
                throw new Error('Captured original group identity required');
            }
            expect(group.handleType).toBe(254);
            expect(group.bootId).toBe(
                (await readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim(),
            );
            expect(group).not.toEqual(admission.delegationIdentity);
            const directory: string = join(fixture.delegation, 'exec-' + id);
            expect(await readFile(join(directory, 'cgroup.procs'), 'utf8')).toBe('');
            expect(await readFile(join(directory, 'cgroup.events'), 'utf8')).toMatch(
                /^populated 0$/mu,
            );
            await delay(30);
            expect(await readdir(fixture.workspace)).not.toContain('effects');
            expect(await readFile(join(directory, 'cgroup.procs'), 'utf8')).toBe('');
        } finally {
            deadline.abort();
            release.resolve(undefined);
            await joined;
        }
        expect(await task).toMatchObject({ termination: ExecutionTermination.Exited, exitCode: 0 });
        expect(await readFile(join(fixture.workspace, 'effects'), 'utf8')).toBe('x');
        expect(
            (await readdir(fixture.delegation)).filter((name: string): boolean =>
                name.startsWith('exec-'),
            ),
        ).toEqual([]);
    },
);

it.skipIf(helper === undefined)(
    'slow output storage cannot keep detached native descendants alive after direct process close',
    async (): Promise<void> => {
        if (helper === undefined) {
            throw new Error('Explicit native helper required');
        }
        await using fixture: ExecutionFixture = await ExecutionFixture.create(helper);
        const release: PromiseWithResolvers<undefined> = Promise.withResolvers<undefined>();
        const observed: PromiseWithResolvers<undefined> = Promise.withResolvers<undefined>();
        const task: Promise<ExecutionResult> = fixture.sandbox.execute(
            randomBytes(32).toString('hex'),
            await fixture.configuration('detached-output', ExecutionWorkspaceAccess.ReadWrite),
            fixture.limits,
            5000,
            AbortSignal.timeout(6000),
            await fixture.admission(),
            {
                retain: async (_output: ExecutionOutput): Promise<void> => {
                    observed.resolve(undefined);
                    await release.promise;
                },
            },
        );
        const joined: Promise<PromiseSettledResult<ExecutionResult>[]> = Promise.allSettled([task]);
        try {
            await observed.promise;
            const groups: readonly string[] = (await readdir(fixture.delegation)).filter(
                (name: string): boolean => name.startsWith('exec-'),
            );
            expect(groups).toHaveLength(1);
            for (const group of groups) {
                const deadline: number = performance.now() + 2000;
                while (
                    !/^populated 0$/mu.test(
                        await readFile(join(fixture.delegation, group, 'cgroup.events'), 'utf8'),
                    )
                ) {
                    if (performance.now() >= deadline) {
                        throw new Error('Output storage retained live descendants');
                    }
                    await delay(10);
                }
            }
        } finally {
            release.resolve(undefined);
            await joined;
        }
        expect(await task).toMatchObject({
            exitCode: 0,
            stdoutBase64: Buffer.from('retained').toString('base64'),
        });
    },
);

it.skipIf(helper === undefined)(
    'accepted binary output is observed before native close and cancellation joins its exact prefix and descendants',
    async (): Promise<void> => {
        if (helper === undefined) {
            throw new Error('Explicit native helper required');
        }
        await using fixture: ExecutionFixture = await ExecutionFixture.create(helper);
        const cancel: AbortController = new AbortController();
        const saved: ExecutionOutput[] = [];
        const result: ExecutionResult = await fixture.sandbox.execute(
            randomBytes(32).toString('hex'),
            await fixture.configuration('output-hold', ExecutionWorkspaceAccess.ReadWrite),
            fixture.limits,
            5000,
            cancel.signal,
            await fixture.admission(),
            {
                retain: (output: ExecutionOutput): Promise<void> => {
                    saved.push(output);
                    cancel.abort();
                    return Promise.resolve();
                },
            },
        );
        const out: Buffer = Buffer.alloc(4096, 'O');
        out.set([0xef, 0xbb, 0xbf, 0, 255]);
        const expected: ExecutionOutput = {
            stdoutBase64: out.toString('base64'),
            stderrBase64: Buffer.from([0, 254, 69]).toString('base64'),
        };
        expect(saved).toEqual([expected]);
        expect(result).toMatchObject({
            ...expected,
            failure: ExecutionFailure.Cancelled,
            exitCode: null,
        });
        expect(
            (await readdir(fixture.delegation)).filter((name: string): boolean =>
                name.startsWith('exec-'),
            ),
        ).toEqual([]);
    },
);

it.skipIf(helper === undefined)(
    'a failed output sink kills native descendants and joins kernel cleanup before rejecting',
    async (): Promise<void> => {
        if (helper === undefined) {
            throw new Error('Explicit native helper required');
        }
        await using fixture: ExecutionFixture = await ExecutionFixture.create(helper);
        await expect(
            fixture.sandbox.execute(
                randomBytes(32).toString('hex'),
                await fixture.configuration('output-hold', ExecutionWorkspaceAccess.ReadWrite),
                fixture.limits,
                5000,
                AbortSignal.timeout(6000),
                await fixture.admission(),
                {
                    retain: (_output: ExecutionOutput): Promise<void> =>
                        Promise.reject(new Error('Owned output storage failed')),
                },
            ),
        ).rejects.toBeInstanceOf(ExecutionOutputRetentionError);
        expect(
            (await readdir(fixture.delegation)).filter((name: string): boolean =>
                name.startsWith('exec-'),
            ),
        ).toEqual([]);
        const next: ExecutionResult = await fixture.sandbox.execute(
            randomBytes(32).toString('hex'),
            await fixture.configuration('effect', ExecutionWorkspaceAccess.ReadWrite),
            fixture.limits,
            5000,
            AbortSignal.timeout(6000),
            await fixture.admission(),
        );
        expect(next.exitCode).toBe(0);
        expect(await readFile(join(fixture.workspace, 'effects'), 'utf8')).toBe('xx');
    },
);

/** Observes a payload-created marker after its descendant exists; elapsed time alone never proves a job started. */
async function running(path: string): Promise<void> {
    const deadline: number = performance.now() + 3000;
    while (true) {
        try {
            if ((await readFile(path, 'utf8')) === 'running') {
                return;
            }
        } catch (caught: unknown) {
            if (!(caught instanceof Error) || !('code' in caught) || caught.code !== 'ENOENT') {
                throw caught;
            }
        }
        if (performance.now() >= deadline) {
            throw new Error('Payload did not create its running marker');
        }
        await delay(10);
    }
}

it.skipIf(helper === undefined)(
    'actual namespaces, cgroups, Landlock and seccomp preserve allowed work while rejecting independent escape attempts',
    async (): Promise<void> => {
        if (helper === undefined) {
            throw new Error('Explicit native execution helper required');
        }
        await using fixture: ExecutionFixture = await ExecutionFixture.create(helper);
        for (const mode of Object.values(ExecutionWorkspaceAccess)) {
            const result: ExecutionResult = await fixture.sandbox.execute(
                randomBytes(32).toString('hex'),
                await fixture.configuration(mode, mode),
                fixture.limits,
                5000,
                AbortSignal.timeout(6000),
                await fixture.admission(),
            );
            expect(result).toMatchObject({
                termination: ExecutionTermination.Exited,
                failure: null,
                exitCode: 0,
            });
            expect(Buffer.from(result.stdoutBase64, 'base64').toString()).toContain(
                'denials verified',
            );
            expect(Buffer.from(result.stderrBase64, 'base64').toString()).toBe('');
            expect(await readFile(join(fixture.workspace, 'input'), 'utf8')).toBe('safe');
        }
        expect(await readFile(join(fixture.workspace, 'output'), 'utf8')).toBe('sandboxed');
        expect(
            (await readdir(fixture.delegation)).filter((name: string): boolean =>
                name.startsWith('exec-'),
            ),
        ).toEqual([]);
    },
    30000,
);

it.skipIf(helper === undefined)(
    'overlapping jobs retain their slots until cancellation and shutdown join every descendant',
    async (): Promise<void> => {
        if (helper === undefined) {
            throw new Error('Explicit native execution helper required');
        }
        await using fixture: ExecutionFixture = await ExecutionFixture.create(helper);
        const first: ExecutionBootstrap = await fixture.configuration(
            'hold-a',
            ExecutionWorkspaceAccess.ReadWrite,
        );
        const second: ExecutionBootstrap = { ...first, arguments: ['hold-b'] };
        const cancel: AbortController = new AbortController();
        const a: Promise<ExecutionResult> = fixture.sandbox.execute(
            randomBytes(32).toString('hex'),
            first,
            fixture.limits,
            5000,
            cancel.signal,
            await fixture.admission(),
        );
        const b: Promise<ExecutionResult> = fixture.sandbox.execute(
            randomBytes(32).toString('hex'),
            second,
            fixture.limits,
            5000,
            AbortSignal.timeout(6000),
            await fixture.admission(),
        );
        await Promise.all([
            running(join(fixture.workspace, 'hold-a')),
            running(join(fixture.workspace, 'hold-b')),
        ]);
        await expect(
            fixture.sandbox.execute(
                randomBytes(32).toString('hex'),
                first,
                fixture.limits,
                5000,
                AbortSignal.timeout(6000),
                await fixture.admission(),
            ),
        ).rejects.toThrow('admission unavailable');
        expect(
            (await readdir(fixture.delegation)).filter((name: string): boolean =>
                name.startsWith('exec-'),
            ),
        ).toHaveLength(2);
        cancel.abort();
        expect(await a).toMatchObject({
            termination: ExecutionTermination.Indeterminate,
            failure: ExecutionFailure.Cancelled,
        });
        expect(
            (await readdir(fixture.delegation)).filter((name: string): boolean =>
                name.startsWith('exec-'),
            ),
        ).toHaveLength(1);
        await fixture.sandbox[Symbol.asyncDispose]();
        expect((await b).termination).toBe(ExecutionTermination.Indeterminate);
        expect(
            (await readdir(fixture.delegation)).filter((name: string): boolean =>
                name.startsWith('exec-'),
            ),
        ).toEqual([]);
        await expect(
            fixture.sandbox.execute(
                randomBytes(32).toString('hex'),
                first,
                fixture.limits,
                5000,
                AbortSignal.timeout(6000),
                await fixture.admission(),
            ),
        ).rejects.toThrow('admission unavailable');
    },
    15000,
);

it.skipIf(helper === undefined)(
    'missing AppArmor authority and invalid namespace evidence stop before any payload effect',
    async (): Promise<void> => {
        if (helper === undefined) {
            throw new Error('Explicit native execution helper required');
        }
        await using fixture: ExecutionFixture = await ExecutionFixture.create(helper);
        const baseline: ExecutionBootstrap = await fixture.configuration(
            'hold-a',
            ExecutionWorkspaceAccess.ReadWrite,
        );
        for (const configuration of [
            {
                ...baseline,
                apparmorProfile: 'nerva-connector-exec-' + '0'.repeat(32) + '-' + '0'.repeat(64),
            },
            { ...baseline, parentNamespaces: { ...baseline.parentNamespaces, mnt: 'unvalidated' } },
        ]) {
            const result: ExecutionResult = await fixture.sandbox.execute(
                randomBytes(32).toString('hex'),
                configuration,
                fixture.limits,
                5000,
                AbortSignal.timeout(6000),
                await fixture.admission(),
            );
            expect(result).toMatchObject({
                termination: ExecutionTermination.Indeterminate,
                failure: ExecutionFailure.Sandbox,
                stdoutBase64: '',
                stderrBase64: '',
            });
            expect([
                ExecutionSetupFailure.Bootstrap,
                ExecutionSetupFailure.Namespaces,
                null,
            ]).toContain(result.setupFailure);
        }
        expect(await readdir(fixture.workspace)).not.toContain('hold-a');
        expect(
            (await readdir(fixture.delegation)).filter((name: string): boolean =>
                name.startsWith('exec-'),
            ),
        ).toEqual([]);
    },
);

it.skipIf(helper === undefined)(
    'aggregate task/memory limits, output bounds, file limits and timeout terminate the owned process tree',
    async (): Promise<void> => {
        if (helper === undefined) {
            throw new Error('Explicit native execution helper required');
        }
        await using fixture: ExecutionFixture = await ExecutionFixture.create(helper);
        const tasks: ExecutionResult = await fixture.sandbox.execute(
            randomBytes(32).toString('hex'),
            await fixture.configuration('tasks'),
            fixture.limits,
            5000,
            AbortSignal.timeout(6000),
            await fixture.admission(),
        );
        expect(tasks).toMatchObject({ termination: ExecutionTermination.Exited, exitCode: 0 });
        expect(Buffer.from(tasks.stdoutBase64, 'base64').toString()).toContain('tasks bounded');
        for (const action of ['loop', 'output', 'memory', 'file-limit', 'descendant']) {
            const result: ExecutionResult = await fixture.sandbox.execute(
                randomBytes(32).toString('hex'),
                await fixture.configuration(action, ExecutionWorkspaceAccess.ReadWrite),
                fixture.limits,
                action === 'loop' ? 200 : 5000,
                AbortSignal.timeout(7000),
                await fixture.admission(),
            );
            if (action === 'descendant') {
                expect([ExecutionTermination.Exited, ExecutionTermination.Indeterminate]).toContain(
                    result.termination,
                );
            } else {
                expect(result.termination, action).toBe(ExecutionTermination.Indeterminate);
            }
            if (action === 'loop') {
                expect(result.failure).toBe(ExecutionFailure.Timeout);
            }
            if (action === 'output') {
                expect(result.failure).toBe(ExecutionFailure.OutputLimit);
            }
            expect(
                Buffer.from(result.stdoutBase64, 'base64').byteLength +
                    Buffer.from(result.stderrBase64, 'base64').byteLength,
            ).toBeLessThanOrEqual(65536);
            expect(
                (await readdir(fixture.delegation)).filter((name: string): boolean =>
                    name.startsWith('exec-'),
                ),
            ).toEqual([]);
        }
        expect((await stat(join(fixture.workspace, 'large'))).size).toBeLessThanOrEqual(4096);
    },
    30000,
);
