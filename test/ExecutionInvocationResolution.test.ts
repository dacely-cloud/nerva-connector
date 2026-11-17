// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

import { expect, it } from 'vitest';
import { ExecutionInputCodec } from '../src/execution/ExecutionInputCodec.js';
import { ExecutionBootstrapInputKind } from '../src/execution/ExecutionBootstrapInput.js';
import {
    ExecutionInvocationResolution as Resolution,
    type ExecutionResolvedInvocation,
} from '../src/execution/ExecutionResolvedInvocation.js';
import {
    type ExecutionInvocation,
    type ExecutionProgramPolicy,
    type ExecutionBinaryPolicy,
} from '../src/execution/ExecutionPolicyTypes.js';
import { ExecutionArgumentKind } from 'nerva-connector-protocol/execution/ExecutionArgumentKind.js';
import { ExecutionMachineInvocationCodec as Codec } from '../src/execution/ExecutionMachineInvocationCodec.js';
import { ExecutionMachineRuleCodec } from '../src/execution/ExecutionMachineRuleCodec.js';
import type { ExecutionMachineInvocationRule } from 'nerva-connector-protocol/execution/ExecutionMachineInvocation.js';
import { ExecutionMachineFixture as Fixture } from './support/ExecutionMachineFixture.js';

/** The actual unchanged invocation decoder validates the outer signed argument array. */
function invocation(program: ExecutionProgramPolicy, args: readonly string[]): ExecutionInvocation {
    return ExecutionInputCodec.invocation({
        policySha256: 'a'.repeat(64),
        programId: program.id,
        rootId: 'project',
        arguments: args,
    });
}

it('ordinary positional literals, choices, paths and JSON-looking text retain Fixed input and exact argv', (): void => {
    const json: string = Codec.encode(Fixture.rule(), Fixture.shell());
    const program: ExecutionProgramPolicy = {
        ...Fixture.program(),
        arguments: [
            { kind: ExecutionArgumentKind.Literal, value: '--fixed' },
            { kind: ExecutionArgumentKind.Choice, values: ['inspect'] },
            { kind: ExecutionArgumentKind.RelativePath, maximumBytes: 64 },
            { kind: ExecutionArgumentKind.Text, maximumBytes: 4096 },
        ],
    };
    const resolved: ExecutionResolvedInvocation = Resolution.capture(
        program,
        invocation(program, ['inspect', 'src/main.ts', json]),
        5000,
    );
    expect(resolved).toEqual({
        program: { path: '/usr/bin/bash', sha256: 'a'.repeat(64) },
        arguments: ['--fixed', 'inspect', 'src/main.ts', json],
        input: { kind: ExecutionBootstrapInputKind.Fixed },
        timeoutMs: 5000,
        interactive: null,
    });
    expect(Object.keys(resolved.input)).toEqual(['kind']);
    expect(Object.isFrozen(resolved)).toBe(true);
    expect(Object.isFrozen(resolved.arguments)).toBe(true);
    expect(Object.isFrozen(resolved.input)).toBe(true);
});

it('explicit canonical Shell input selects the pinned shell, appends its script once and retains finite application input', (): void => {
    const program: ExecutionProgramPolicy = Fixture.program();
    const payload: string = Codec.encode(Fixture.rule(), {
        ...Fixture.shell(),
        script: 'printf "%s" "$APP_MODE"',
        cwd: 'src',
        environment: [{ name: 'APP_MODE', value: 'test' }],
        stdin: 'first\0😀\nlast',
        timeoutMs: 900,
    });
    const resolved: ExecutionResolvedInvocation = Resolution.capture(
        program,
        invocation(program, [payload]),
        5000,
    );
    expect(resolved).toEqual({
        program: { path: '/usr/bin/bash', sha256: 'a'.repeat(64) },
        arguments: ['--noprofile', '--norc', '-c', 'printf "%s" "$APP_MODE"'],
        input: {
            kind: ExecutionBootstrapInputKind.Machine,
            cwd: 'src',
            environment: [{ name: 'APP_MODE', value: 'test' }],
            stdin: 'first\0😀\nlast',
        },
        timeoutMs: 900,
        interactive: null,
    });
    expect(resolved.arguments).not.toContain(payload);
    expect(Object.isFrozen(resolved.program)).toBe(true);
    expect(Object.isFrozen(resolved.input)).toBe(true);
    if (resolved.input.kind !== ExecutionBootstrapInputKind.Machine) {
        throw new Error('Explicit Machine bootstrap input required');
    }
    expect(Object.isFrozen(resolved.input.environment)).toBe(true);
    expect(Object.isFrozen(resolved.input.environment[0])).toBe(true);
});

it('explicit canonical Argv input resolves the actual pinned child bytes without shell joining or shell-name inference', (): void => {
    const program: ExecutionProgramPolicy = Fixture.program();
    const payload: string = Codec.encode(Fixture.rule(), {
        ...Fixture.argv(),
        argv: ['--eval', 'process.stdout.write("literal; $(id)")'],
        stdin: 'finite input',
        timeoutMs: 100,
    });
    const resolved: ExecutionResolvedInvocation = Resolution.capture(
        program,
        invocation(program, [payload]),
        5000,
    );
    expect(resolved).toEqual({
        program: { path: '/usr/bin/node', sha256: 'b'.repeat(64) },
        arguments: ['--eval', 'process.stdout.write("literal; $(id)")'],
        input: {
            kind: ExecutionBootstrapInputKind.Machine,
            cwd: 'src',
            environment: [
                { name: 'APP_MODE', value: 'test' },
                { name: 'LANG', value: 'C.UTF-8' },
            ],
            stdin: 'finite input',
        },
        timeoutMs: 100,
        interactive: null,
    });
    expect(resolved.arguments).not.toContain('-c');
});

it('resolved plans detach executable pins and all application inputs before any asynchronous admission boundary', async (): Promise<void> => {
    const program: ExecutionProgramPolicy = Fixture.program();
    const source: ExecutionInvocation = invocation(program, [
        Codec.encode(Fixture.rule(), Fixture.argv()),
    ]);
    const resolved: ExecutionResolvedInvocation = Resolution.capture(program, source, 5000);
    expect(Object.isFrozen(resolved)).toBe(true);
    expect(Object.isFrozen(resolved.program)).toBe(true);
    expect(Object.isFrozen(resolved.arguments)).toBe(true);
    expect(Object.isFrozen(resolved.input)).toBe(true);
    const child: ExecutionBinaryPolicy | undefined = program.children[0];
    if (child === undefined) {
        throw new Error('Existing pinned child fixture required');
    }
    expect(Reflect.set(child, 'path', '/usr/bin/changed')).toBe(true);
    expect(Reflect.set(child, 'sha256', 'c'.repeat(64))).toBe(true);
    expect(Reflect.set(program, 'children', [])).toBe(true);
    expect(Reflect.set(program, 'path', '/usr/bin/other-shell')).toBe(true);
    expect(Reflect.set(program, 'arguments', [])).toBe(true);
    expect(Reflect.set(source.arguments, '0', Codec.encode(Fixture.rule(), Fixture.shell()))).toBe(
        true,
    );
    await Promise.resolve();
    expect(resolved.program).toEqual({ path: '/usr/bin/node', sha256: 'b'.repeat(64) });
    expect(resolved.arguments).toEqual(['--version']);
    expect(resolved.input).toEqual({
        kind: ExecutionBootstrapInputKind.Machine,
        cwd: 'src',
        environment: [
            { name: 'APP_MODE', value: 'test' },
            { name: 'LANG', value: 'C.UTF-8' },
        ],
        stdin: '',
    });
    expect(resolved.timeoutMs).toBe(1000);
});

it('Machine resolution rejects missing or extra arguments, noncanonical JSON, unknown aliases and disabled modes', (): void => {
    const rule: ExecutionMachineInvocationRule = Fixture.rule();
    const program: ExecutionProgramPolicy = Fixture.program(rule);
    const shell: string = Codec.encode(rule, Fixture.shell());
    const invalid: readonly (readonly string[])[] = [
        [],
        [shell, shell],
        ['not-json'],
        [' ' + shell],
        [shell.replace('"mode":"shell"', '"mode":"shell","mode":"shell"')],
        [JSON.stringify({ ...Fixture.argv(), command: 'ungranted' })],
        [JSON.stringify({ ...Fixture.argv(), command: '/usr/bin/node' })],
        [JSON.stringify({ ...Fixture.shell(), terminal: true })],
    ];
    for (const args of invalid) {
        expect(() => Resolution.capture(program, invocation(program, args), 5000)).toThrow();
    }
    const noShell: ExecutionProgramPolicy = Fixture.program(
        ExecutionMachineRuleCodec.read({ ...rule, shell: null }),
    );
    expect(() => Resolution.capture(noShell, invocation(noShell, [shell]), 5000)).toThrow();
    const noArgv: ExecutionProgramPolicy = Fixture.program(
        ExecutionMachineRuleCodec.read({ ...rule, commands: [] }),
    );
    expect(() =>
        Resolution.capture(noArgv, invocation(noArgv, [Codec.encode(rule, Fixture.argv())]), 5000),
    ).toThrow();
});

it('local binary-table and deadline ceilings are rechecked before an immutable native plan can be produced', (): void => {
    const rule: ExecutionMachineInvocationRule = Fixture.rule();
    const shell: string = Codec.encode(rule, Fixture.shell());
    const argv: string = Codec.encode(rule, Fixture.argv());
    const missingChild: ExecutionProgramPolicy = { ...Fixture.program(), children: [] };
    expect(() =>
        Resolution.capture(missingChild, invocation(missingChild, [argv]), 5000),
    ).toThrow();
    const wrongShell: ExecutionProgramPolicy = Fixture.program(
        ExecutionMachineRuleCodec.read({
            ...rule,
            shell: { executableIndex: 2, fixedArguments: ['-c'] },
        }),
    );
    expect(() => Resolution.capture(wrongShell, invocation(wrongShell, [shell]), 5000)).toThrow();
    const wrongAlias: ExecutionProgramPolicy = Fixture.program(
        ExecutionMachineRuleCodec.read({
            ...rule,
            commands: [{ alias: 'node', executableIndex: 8 }],
        }),
    );
    expect(() => Resolution.capture(wrongAlias, invocation(wrongAlias, [argv]), 5000)).toThrow();
    const program: ExecutionProgramPolicy = Fixture.program();
    expect(() => Resolution.capture(program, invocation(program, [shell]), 4999)).toThrow();
    const late: string = JSON.stringify({ ...Fixture.shell(), timeoutMs: 5001 });
    expect(() => Resolution.capture(program, invocation(program, [late]), 5000)).toThrow();
    const mixed: ExecutionProgramPolicy = {
        ...program,
        arguments: [{ kind: ExecutionArgumentKind.Literal, value: '-c' }, rule],
    };
    expect(() => Resolution.capture(mixed, invocation(mixed, [shell]), 5000)).toThrow();
});
