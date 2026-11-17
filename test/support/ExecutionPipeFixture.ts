// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { ExecutionAppArmorMode } from '../../src/execution/ExecutionAppArmorProfile.js';
import { ExecutionBootstrapInputKind } from '../../src/execution/ExecutionBootstrapInput.js';
import { ExecutionNativePipeHandle } from '../../src/execution/ExecutionNativePipeHandle.js';
import type { ExecutionNativePipeBudget } from '../../src/execution/ExecutionNativePipeProtocol.js';
import type { ExecutionResult, ExecutionBootstrap } from '../../src/execution/ExecutionTypes.js';
import { ExecutionWorkspaceAccess } from '../../src/execution/ExecutionTypes.js';
import { ExecutionFixture } from './ExecutionFixture.js';

/** Probe actions are fixed test programs, not a remote program-selection API. */
export enum ExecutionPipeProbe {
    Echo = 'echo',
    Slow = 'slow',
    Hold = 'hold',
    Descendant = 'descendant',
    Write = 'write',
    ClosedInput = 'closed-input',
    Discard = 'discard',
}
/** The actual native operation and its observed completion remain owned by the containing fixture. */
export interface ExecutionPipeInvocation {
    readonly pipe: ExecutionNativePipeHandle;
    readonly incarnation: string;
    readonly executionDeadlineMs: bigint;
    readonly task: Promise<ExecutionResult>;
    readonly joined: Promise<PromiseSettledResult<ExecutionResult>[]>;
}
/** Owns one finite compiled test ELF and the existing real workspace/cgroup/MAC fixture. */
export class ExecutionPipeFixture implements AsyncDisposable {
    readonly #resources: AsyncDisposableStack;
    private constructor(
        resources: AsyncDisposableStack,
        public readonly native: ExecutionFixture,
    ) {
        this.#resources = resources;
    }

    public static async create(helper: string): Promise<ExecutionPipeFixture> {
        await using resources: AsyncDisposableStack = new AsyncDisposableStack();
        const directory: string = await mkdtemp(join(homedir(), '.nerva-pipe-probe-'));
        resources.defer(async (): Promise<void> => {
            await rm(directory, { recursive: true, force: true });
        });
        const probe: string = join(directory, 'probe');
        await promisify(execFile)(
            'cc',
            [
                '-O2',
                '-static',
                '-Wall',
                '-Wextra',
                '-Werror',
                '-o',
                probe,
                fileURLToPath(new URL('../../native/test/execution_pipe_probe.c', import.meta.url)),
            ],
            { timeout: 10000, maxBuffer: 8192 },
        );
        const native: ExecutionFixture = resources.use(
            await ExecutionFixture.create(helper, { probeFile: probe }),
        );
        await mkdir(join(native.workspace, 'nested'), { mode: 0o700 });
        return new ExecutionPipeFixture(resources.move(), native);
    }

    /** The trusted test explicitly selects Pipe; no public rule or signed-operation authorization is manufactured here. */
    public async launch(
        action: ExecutionPipeProbe,
        initial: string = '',
        access: ExecutionWorkspaceAccess = ExecutionWorkspaceAccess.ReadWrite,
        timeoutMs: number = 3000,
        signal: AbortSignal = AbortSignal.timeout(5000),
        budget: ExecutionNativePipeBudget = { maximumInputBytes: 65536n, maximumControls: 256 },
        incarnation: string = randomBytes(32).toString('hex'),
        executionDeadlineMs: bigint = BigInt(Date.now()) + BigInt(timeoutMs),
    ): Promise<ExecutionPipeInvocation> {
        const base: ExecutionBootstrap = await this.native.configuration(
            action,
            access,
            ExecutionAppArmorMode.Pipe,
        );
        const pipe: ExecutionNativePipeHandle = new ExecutionNativePipeHandle(
            incarnation,
            initial,
            budget,
            executionDeadlineMs,
        );
        const configuration: ExecutionBootstrap = {
            ...base,
            input: {
                kind: ExecutionBootstrapInputKind.Pipe,
                cwd: 'nested',
                environment: [{ name: 'APP_MODE', value: 'fixture' }],
                stdin: initial,
                incarnation,
                executionDeadlineMs,
                maximumInputBytes: budget.maximumInputBytes,
                maximumControls: budget.maximumControls,
                guardianProfile: base.apparmorProfile.replace(
                    'nerva-connector-exec-',
                    'nerva-connector-guard-',
                ),
            },
        };
        const task: Promise<ExecutionResult> = this.native.sandbox.execute(
            randomBytes(32).toString('hex'),
            configuration,
            this.native.limits,
            timeoutMs,
            signal,
            await this.native.admission(),
            null,
            pipe,
        );
        const joined: Promise<PromiseSettledResult<ExecutionResult>[]> = Promise.allSettled([task]);
        return { pipe, incarnation, executionDeadlineMs, task, joined };
    }

    /** All native descendants, groups, profiles, descriptors and task-owned ELF files join through their existing owners. */
    public async [Symbol.asyncDispose](): Promise<void> {
        await this.#resources[Symbol.asyncDispose]();
    }
}
