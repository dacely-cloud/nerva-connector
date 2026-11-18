// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

import { expect, it, vi, type MockInstance } from 'vitest';
import { ProtectedFiles } from '../src/local/ProtectedFiles.js';
import { ExecutionPipePolicy } from '../src/execution/ExecutionPipePolicy.js';
import { ExecutionAppArmorRequirements } from '../src/execution/ExecutionAppArmorRequirements.js';
import { ExecutionAppArmorInstaller } from '../src/execution/ExecutionAppArmorInstaller.js';
import {
    ExecutionAppArmorMode,
    ExecutionAppArmorProfile,
    type ExecutionAppArmorDefinition,
} from '../src/execution/ExecutionAppArmorProfile.js';
import { ExecutionInteractiveRuleCodec } from 'nerva-connector-protocol/execution/ExecutionInteractiveRuleCodec.js';
import { ExecutionInteractiveTransport } from 'nerva-connector-protocol/execution/ExecutionInteractive.js';
import { ExecutionInputKind } from 'nerva-connector-protocol/execution/ExecutionInput.js';
import { ExecutionPolicyCodec } from '../src/execution/ExecutionPolicyCodec.js';
import {
    type ExecutionArgumentRule,
    type ExecutionProgramPolicy,
    type ExecutionPolicyDefinition,
} from 'nerva-connector-protocol/execution/ExecutionPolicyTypes.js';
import { ExecutionArgumentKind } from 'nerva-connector-protocol/execution/ExecutionArgumentKind.js';
import type { ExecutionInteractiveInvocationRule } from 'nerva-connector-protocol/execution/ExecutionInteractiveInvocation.js';
import { ExecutionMachineFixture } from './support/ExecutionMachineFixture.js';

/** Pure policy and kernel-inventory fixtures perform no installation, kernel mutation or native execution. */
class PipePolicyFixture {
    public static rule(): ExecutionInteractiveInvocationRule {
        return ExecutionInteractiveRuleCodec.read({
            kind: ExecutionArgumentKind.InteractiveInvocation,
            invocation: ExecutionMachineFixture.rule(),
            transports: [ExecutionInteractiveTransport.Pipe],
            controls: [ExecutionInputKind.Data, ExecutionInputKind.End],
            maximumInputBytes: '65536',
            maximumControls: 256,
            maximumResizes: 0,
        });
    }

    public static program(
        rule: ExecutionInteractiveInvocationRule = this.rule(),
    ): ExecutionProgramPolicy {
        return { ...ExecutionMachineFixture.program(), id: 'pipe', arguments: [rule] };
    }

    public static policy(): ExecutionPolicyDefinition {
        return {
            ...ExecutionMachineFixture.policy(),
            programs: [ExecutionMachineFixture.program(), this.program()],
        };
    }

    public static inventory(profile: ExecutionAppArmorDefinition): readonly string[] {
        return [
            profile.name,
            profile.launcherName,
            ...(profile.guardianName === null ? [] : [profile.guardianName]),
        ];
    }

    public static wire(definition: ExecutionPolicyDefinition = this.policy()): unknown {
        const raw: unknown = JSON.parse(
            JSON.stringify(definition, (_key: string, value: unknown): unknown =>
                typeof value === 'bigint' ? value.toString() : value,
            ),
        );
        return raw;
    }
}

it('local Pipe validation preserves exact maximum counters and accepts only the existing pinned Machine authority', (): void => {
    const rule: ExecutionInteractiveInvocationRule = PipePolicyFixture.rule();
    const validated: ExecutionInteractiveInvocationRule | null = ExecutionPipePolicy.program(
        PipePolicyFixture.program(rule),
        5000,
    );
    expect(validated).toEqual(rule);
    expect(validated?.maximumInputBytes).toBe(65536n);
    expect(Object.isFrozen(validated)).toBe(true);
    expect(ExecutionPipePolicy.program(ExecutionMachineFixture.program(), 5000)).toBeNull();
    expect(
        ExecutionPipePolicy.program(
            PipePolicyFixture.program({
                ...rule,
                maximumInputBytes: 0n,
                maximumControls: 2,
                controls: [ExecutionInputKind.Data, ExecutionInputKind.End],
            }),
            5000,
        )?.maximumInputBytes,
    ).toBe(0n);
    for (const maximumInputBytes of ['65537', '-1', '01', 65536]) {
        expect(() => ExecutionInteractiveRuleCodec.read({ ...rule, maximumInputBytes })).toThrow();
    }
});

it('local Pipe rejects PTY, resize, mixed placement, duplicate controls and nested authority outside the pinned table or timeout', (): void => {
    const rule: ExecutionInteractiveInvocationRule = PipePolicyFixture.rule();
    const changes: readonly ExecutionInteractiveInvocationRule[] = [
        { ...rule, transports: [ExecutionInteractiveTransport.Pty] },
        {
            ...rule,
            transports: [ExecutionInteractiveTransport.Pipe, ExecutionInteractiveTransport.Pty],
        },
        {
            ...rule,
            transports: [ExecutionInteractiveTransport.Pty],
            controls: [ExecutionInputKind.Data, ExecutionInputKind.Resize],
            maximumResizes: 1,
        },
        { ...rule, controls: [ExecutionInputKind.Data, ExecutionInputKind.Data] },
        { ...rule, controls: [ExecutionInputKind.End] },
        { ...rule, controls: [ExecutionInputKind.Data] },
        { ...rule, maximumControls: 1 },
        { ...rule, maximumInputBytes: 65537n },
        { ...rule, invocation: { ...rule.invocation, maximumTimeoutMs: 5001 } },
        {
            ...rule,
            invocation: {
                ...rule.invocation,
                commands: [{ alias: 'not-pinned', executableIndex: 2 }],
            },
        },
        {
            ...rule,
            invocation: {
                ...rule.invocation,
                shell: { executableIndex: 2, fixedArguments: ['-c'] },
            },
        },
    ];
    for (const change of changes) {
        expect(() =>
            ExecutionPipePolicy.program(PipePolicyFixture.program(change), 5000),
        ).toThrow();
    }
    const mixed: readonly (readonly ExecutionArgumentRule[])[] = [
        [rule, rule],
        [rule, ExecutionMachineFixture.rule()],
        [rule, { kind: ExecutionArgumentKind.Text, maximumBytes: 16 }],
    ];
    for (const argumentsList of mixed) {
        expect(() =>
            ExecutionPipePolicy.program(
                { ...PipePolicyFixture.program(), arguments: argumentsList },
                5000,
            ),
        ).toThrow();
    }
});

it('required profile modes derive from every local grant, deduplicate modes and never widen foreground trace authority', (): void => {
    const definition: ExecutionPolicyDefinition = PipePolicyFixture.policy();
    expect(ExecutionAppArmorRequirements.modes(definition)).toEqual([
        ExecutionAppArmorMode.Foreground,
        ExecutionAppArmorMode.Pipe,
    ]);
    expect(
        ExecutionAppArmorRequirements.modes({
            ...definition,
            programs: [
                PipePolicyFixture.program(),
                { ...PipePolicyFixture.program(), id: 'second-pipe' },
            ],
        }),
    ).toEqual([ExecutionAppArmorMode.Pipe]);
    expect(ExecutionAppArmorRequirements.modes(ExecutionMachineFixture.policy())).toEqual([
        ExecutionAppArmorMode.Foreground,
    ]);
    expect(() => ExecutionAppArmorRequirements.modes({ ...definition, programs: [] })).toThrow();
    const foreground: ExecutionAppArmorDefinition = ExecutionAppArmorProfile.generate(
        definition,
        ExecutionAppArmorMode.Foreground,
    );
    const pipe: ExecutionAppArmorDefinition = ExecutionAppArmorProfile.generate(
        definition,
        ExecutionAppArmorMode.Pipe,
    );
    expect(foreground.guardianName).toBeNull();
    expect(foreground.source).not.toContain('tracedby');
    expect(pipe.guardianName).not.toBeNull();
    expect(PipePolicyFixture.inventory(pipe)).toHaveLength(3);
    expect(pipe.name).not.toBe(foreground.name);
});

it('required assertions reject each missing or complaining Pipe stack member even when the complete foreground stack enforces', async (): Promise<void> => {
    const definition: ExecutionPolicyDefinition = PipePolicyFixture.policy();
    const foreground: ExecutionAppArmorDefinition = ExecutionAppArmorProfile.generate(definition);
    const pipe: ExecutionAppArmorDefinition = ExecutionAppArmorProfile.generate(
        definition,
        ExecutionAppArmorMode.Pipe,
    );
    const names: readonly string[] = [
        ...PipePolicyFixture.inventory(foreground),
        ...PipePolicyFixture.inventory(pipe),
    ];
    using read: MockInstance<typeof ProtectedFiles.readTrusted> = vi.spyOn(
        ProtectedFiles,
        'readTrusted',
    );
    read.mockResolvedValue(
        Buffer.from(names.map((name: string): string => name + ' (enforce)').join('\n')),
    );
    await ExecutionAppArmorInstaller.assertRequired(definition);
    for (const missing of PipePolicyFixture.inventory(pipe)) {
        for (const suffix of ['', ' (complain)']) {
            read.mockResolvedValue(
                Buffer.from(
                    names
                        .map((name: string): string =>
                            name === missing
                                ? suffix === ''
                                    ? ''
                                    : name + suffix
                                : name + ' (enforce)',
                        )
                        .join('\n'),
                ),
            );
            await expect(ExecutionAppArmorInstaller.assertRequired(definition)).rejects.toThrow(
                'not installed',
            );
        }
    }
    expect(read).toHaveBeenCalledWith('/sys/kernel/security/apparmor/profiles', 1048576, false);
});

it('explicit required installation prepares both exact modes and verifies all enforcing stacks before returning', async (): Promise<void> => {
    const definition: ExecutionPolicyDefinition = PipePolicyFixture.policy();
    using install: MockInstance<typeof ExecutionAppArmorInstaller.install> = vi
        .spyOn(ExecutionAppArmorInstaller, 'install')
        .mockImplementation(
            (
                policy: ExecutionPolicyDefinition,
                mode: ExecutionAppArmorMode = ExecutionAppArmorMode.Foreground,
            ): Promise<ExecutionAppArmorDefinition> =>
                Promise.resolve(ExecutionAppArmorProfile.generate(policy, mode)),
        );
    using assert: MockInstance<typeof ExecutionAppArmorInstaller.assertInstalled> = vi
        .spyOn(ExecutionAppArmorInstaller, 'assertInstalled')
        .mockResolvedValue();
    await ExecutionAppArmorInstaller.installRequired(definition);
    expect(install.mock.calls).toEqual([
        [definition, ExecutionAppArmorMode.Foreground],
        [definition, ExecutionAppArmorMode.Pipe],
    ]);
    expect(assert.mock.calls).toEqual([
        [definition, ExecutionAppArmorMode.Foreground],
        [definition, ExecutionAppArmorMode.Pipe],
    ]);
    assert.mockRejectedValue(new Error('Missing enforcing guardian'));
    await expect(ExecutionAppArmorInstaller.installRequired(definition)).rejects.toThrow(
        'Missing enforcing guardian',
    );
    install.mockClear();
    await expect(
        ExecutionAppArmorInstaller.installRequired({
            ...definition,
            programs: [
                PipePolicyFixture.program({
                    ...PipePolicyFixture.rule(),
                    transports: [ExecutionInteractiveTransport.Pty],
                }),
            ],
        }),
    ).rejects.toThrow();
    expect(install).not.toHaveBeenCalled();
});

it('the production policy boundary admits only complete canonical Pipe grants while retaining exact counters and foreground rules', (): void => {
    const definition: ExecutionPolicyDefinition = PipePolicyFixture.policy();
    expect(ExecutionPolicyCodec.policy(PipePolicyFixture.wire())).toEqual(definition);
    const rule: ExecutionInteractiveInvocationRule = PipePolicyFixture.rule();
    const invalid: readonly ExecutionInteractiveInvocationRule[] = [
        { ...rule, transports: [ExecutionInteractiveTransport.Pty] },
        {
            ...rule,
            transports: [ExecutionInteractiveTransport.Pipe, ExecutionInteractiveTransport.Pty],
        },
        { ...rule, controls: [ExecutionInputKind.Data] },
        { ...rule, maximumControls: 1 },
        { ...rule, maximumControls: 257 },
        { ...rule, maximumInputBytes: -1n },
        { ...rule, maximumInputBytes: 65537n },
        { ...rule, maximumResizes: 1 },
        {
            ...rule,
            invocation: {
                ...rule.invocation,
                commands: [{ alias: 'not-pinned', executableIndex: 2 }],
            },
        },
        { ...rule, invocation: { ...rule.invocation, maximumTimeoutMs: 5001 } },
    ];
    for (const changed of invalid) {
        const policy: ExecutionPolicyDefinition = {
            ...definition,
            programs: [PipePolicyFixture.program(changed)],
        };
        expect(() => ExecutionPolicyCodec.policy(PipePolicyFixture.wire(policy))).toThrow();
    }
    const encoded: string = JSON.stringify(PipePolicyFixture.wire());
    for (const replacement of ['65536', '"065536"']) {
        const raw: unknown = JSON.parse(
            encoded.replace('"maximumInputBytes":"65536"', '"maximumInputBytes":' + replacement),
        );
        expect(() => ExecutionPolicyCodec.policy(raw)).toThrow();
    }
    expect(() =>
        ExecutionPolicyCodec.policy(
            PipePolicyFixture.wire({
                ...definition,
                programs: [
                    {
                        ...PipePolicyFixture.program(),
                        arguments: [rule, ExecutionMachineFixture.rule()],
                    },
                ],
            }),
        ),
    ).toThrow();
    const zero: ExecutionPolicyDefinition = {
        ...definition,
        programs: [
            PipePolicyFixture.program({ ...rule, maximumInputBytes: 0n, maximumControls: 2 }),
        ],
    };
    expect(ExecutionPolicyCodec.policy(PipePolicyFixture.wire(zero))).toEqual(zero);
});
