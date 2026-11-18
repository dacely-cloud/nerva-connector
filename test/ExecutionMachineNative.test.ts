// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { ExecutionPolicy } from '../src/execution/ExecutionPolicy.js';
import { ExecutionPolicyCodec } from '../src/execution/ExecutionPolicyCodec.js';
import type {
    ExecutionPolicyDefinition,
    ExecutionProgramPolicy,
    ExecutionRootPolicy,
} from 'nerva-connector-protocol/execution/ExecutionPolicyTypes.js';
import { ExecutionMachineRuleCodec } from 'nerva-connector-protocol/execution/ExecutionMachineRuleCodec.js';
import { ExecutionMachineInvocationCodec } from 'nerva-connector-protocol/execution/ExecutionMachineInvocationCodec.js';
import {
    ExecutionMachineMode,
    type ExecutionMachineInput,
    type ExecutionMachineInvocationRule,
} from 'nerva-connector-protocol/execution/ExecutionMachineInvocation.js';
import {
    ExecutionTermination,
    ExecutionWorkspaceAccess,
    ExecutionSetupFailure,
    ExecutionFailure,
    type ExecutionResult,
} from 'nerva-connector-protocol/execution/ExecutionTypes.js';
import { ExecutionFixture } from './support/ExecutionFixture.js';
import { ExecutionMachineFixture } from './support/ExecutionMachineFixture.js';

/** Test actions remain finite probe operations inside the real confined process. */
enum ProbeAction {
    Input = 'machine-input',
    Loop = 'loop',
}
/** Every native case owns a policy, complete input and finite requested wall budget. */
interface NativeInvocationCase {
    readonly policy: ExecutionPolicy;
    readonly mode: ExecutionMachineMode;
    readonly cwd: string;
    readonly action: ProbeAction;
    readonly timeoutMs: number;
}

const helper: string | undefined = process.env['NERVA_CONNECTOR_EXEC_HELPER'];

it.skipIf(helper === undefined)(
    'real pinned shell and argv preserve descriptor cwd, exact sealed stdin and declared environment under native confinement',
    async (): Promise<void> => {
        if (helper === undefined) {
            throw new Error('Explicit qualification helper required');
        }
        await using fixture: ExecutionFixture = await ExecutionFixture.create(helper);
        await fixture.installProgram('/usr/bin/bash', '/usr/bin/bash');
        await mkdir(join(fixture.workspace, 'nested'), { mode: 0o700 });
        await symlink('nested', join(fixture.workspace, 'alias'));
        const path: string = await fixture.policy(helper, ExecutionWorkspaceAccess.ReadWrite);
        const raw: unknown = JSON.parse(await readFile(path, 'utf8'));
        const original: ExecutionPolicyDefinition = ExecutionPolicyCodec.policy(raw);
        const probe: ExecutionProgramPolicy | undefined = original.programs[0];
        if (probe === undefined) {
            throw new Error('Pinned fixture probe required');
        }
        const rule: ExecutionMachineInvocationRule = ExecutionMachineRuleCodec.read({
            ...ExecutionMachineFixture.rule(),
            commands: [{ alias: 'probe', executableIndex: 1 }],
        });
        const definition: ExecutionPolicyDefinition = {
            ...original,
            programs: [
                {
                    ...probe,
                    id: 'machine',
                    path: '/usr/bin/bash',
                    sha256: createHash('sha256')
                        .update(await readFile('/usr/bin/bash'))
                        .digest('hex'),
                    arguments: [rule],
                    children: [{ path: probe.path, sha256: probe.sha256 }],
                },
            ],
        };
        await writeFile(
            path,
            JSON.stringify(definition, (_key: string, value: unknown): unknown =>
                typeof value === 'bigint' ? value.toString() : value,
            ),
            { mode: 0o600 },
        );
        await fixture.installProfile(definition);
        await using policy: ExecutionPolicy = await ExecutionPolicy.load(path, []);
        const execute: (specification: NativeInvocationCase) => Promise<ExecutionResult> = async (
            specification: NativeInvocationCase,
        ): Promise<ExecutionResult> => {
            const { mode, cwd, policy, action, timeoutMs }: NativeInvocationCase = specification;
            const common: ExecutionMachineInput = {
                cwd,
                environment: [{ name: 'APP_MODE', value: 'fixture' }],
                stdin: 'before\0after\n',
                timeoutMs,
            };
            const payload: string = ExecutionMachineInvocationCodec.encode(
                rule,
                mode === ExecutionMachineMode.Shell
                    ? { mode, script: 'exec /usr/bin/probe ' + action, ...common }
                    : { mode, command: 'probe', argv: [action], ...common },
            );
            return await policy.execute(
                {
                    policySha256: policy.policySha256,
                    programId: 'machine',
                    rootId: 'project',
                    arguments: [payload],
                },
                randomBytes(32).toString('hex'),
                AbortSignal.timeout(10000),
                await fixture.policyAdmission(policy),
            );
        };
        const baseline: NativeInvocationCase = {
            policy,
            mode: ExecutionMachineMode.Argv,
            cwd: 'nested',
            action: ProbeAction.Input,
            timeoutMs: 3000,
        };
        for (const mode of [ExecutionMachineMode.Argv, ExecutionMachineMode.Shell]) {
            const result: ExecutionResult = await execute({ ...baseline, mode });
            expect(result, Buffer.from(result.stderrBase64, 'base64').toString()).toMatchObject({
                termination: ExecutionTermination.Exited,
                exitCode: 0,
                setupFailure: null,
            });
            expect(Buffer.from(result.stdoutBase64, 'base64').toString()).toBe(
                'machine inputs verified\n',
            );
            expect(
                await readFile(join(fixture.workspace, 'nested', 'relative-effect'), 'utf8'),
            ).toBe('native');
            await rm(join(fixture.workspace, 'nested', 'relative-effect'));
        }
        const refused: ExecutionResult = await execute({ ...baseline, cwd: 'alias' });
        expect(refused.setupFailure).toBe(ExecutionSetupFailure.Configuration);
        expect(refused.stdoutBase64).toBe('');
        await expect(
            readFile(join(fixture.workspace, 'nested', 'relative-effect')),
        ).rejects.toMatchObject({ code: 'ENOENT' });
        const startedAt: number = performance.now();
        const timed: ExecutionResult = await execute({
            ...baseline,
            action: ProbeAction.Loop,
            timeoutMs: 100,
        });
        expect(timed.failure).toBe(ExecutionFailure.Timeout);
        expect(performance.now() - startedAt).toBeLessThan(2000);
        const readOnlyDefinition: ExecutionPolicyDefinition = {
            ...definition,
            roots: definition.roots.map((root: ExecutionRootPolicy): ExecutionRootPolicy => ({
                ...root,
                access: ExecutionWorkspaceAccess.ReadOnly,
            })),
        };
        const readOnlyPath: string = join(fixture.directory, 'readonly-execution-policy.json');
        await writeFile(
            readOnlyPath,
            JSON.stringify(readOnlyDefinition, (_key: string, value: unknown): unknown =>
                typeof value === 'bigint' ? value.toString() : value,
            ),
            { mode: 0o600 },
        );
        await fixture.installProfile(readOnlyDefinition);
        await using readOnly: ExecutionPolicy = await ExecutionPolicy.load(readOnlyPath, []);
        const deniedWrite: ExecutionResult = await execute({ ...baseline, policy: readOnly });
        expect(
            deniedWrite,
            Buffer.from(deniedWrite.stderrBase64, 'base64').toString(),
        ).toMatchObject({
            termination: ExecutionTermination.Exited,
            exitCode: 1,
            setupFailure: null,
        });
        await expect(
            readFile(join(fixture.workspace, 'nested', 'relative-effect')),
        ).rejects.toMatchObject({ code: 'ENOENT' });
    },
    30000,
);
