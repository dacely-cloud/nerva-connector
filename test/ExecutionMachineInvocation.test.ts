// SPDX-FileCopyrightText: 2026 Dacely <business@dacely.com>
// SPDX-License-Identifier: LicenseRef-Proprietary

import { expect, it } from 'vitest';
import { ExecutionInputCodec } from 'nerva-connector-protocol/execution/ExecutionInputCodec.js';
import { ExecutionArgumentKind } from 'nerva-connector-protocol/execution/ExecutionArgumentKind.js';
import { ExecutionMachineInvocationCodec as Codec } from 'nerva-connector-protocol/execution/ExecutionMachineInvocationCodec.js';
import {
    ExecutionMachineMode,
    type ExecutionMachineInvocationRule,
    type ExecutionMachinePlan,
    type ExecutionMachineShellInvocation,
    type ExecutionMachineEnvironmentValue,
} from 'nerva-connector-protocol/execution/ExecutionMachineInvocation.js';
import { ExecutionMachineRuleCodec } from 'nerva-connector-protocol/execution/ExecutionMachineRuleCodec.js';
import { ExecutionMachineBoundary } from 'nerva-connector-protocol/execution/ExecutionMachineBoundary.js';
import { ExecutionMachineFixture as Fixture } from './support/ExecutionMachineFixture.js';

it('canonical shell and argv payloads resolve exact pinned indexes and immutable native plans without forwarding JSON literally', (): void => {
    const rule: ExecutionMachineInvocationRule = Fixture.rule();
    const shell: string = Codec.encode(rule, Fixture.shell());
    expect(Codec.decode(rule, shell)).toEqual(Fixture.shell());
    const plan: ExecutionMachinePlan = Codec.resolve(rule, shell);
    expect(plan).toEqual({
        executableIndex: 0,
        arguments: ['--noprofile', '--norc', '-c', 'printf hello'],
        cwd: '.',
        environment: [],
        stdin: '',
        timeoutMs: 1000,
    });
    expect(Object.isFrozen(plan)).toBe(true);
    expect(Object.isFrozen(plan.arguments)).toBe(true);
    expect(plan.arguments).not.toContain(shell);
    const argv: ExecutionMachinePlan = Codec.resolve(rule, Codec.encode(rule, Fixture.argv()));
    expect(argv.executableIndex).toBe(1);
    expect(argv.arguments).toEqual(['--version']);
    expect(Object.isFrozen(argv.environment)).toBe(true);
    expect(Object.isFrozen(argv.environment[0])).toBe(true);
});

it('structured-looking text keeps its positional semantics and the old argument resolver never guesses a Machine grant', (): void => {
    const rule: ExecutionMachineInvocationRule = Fixture.rule();
    const payload: string = Codec.encode(rule, Fixture.shell());
    expect(
        ExecutionInputCodec.arguments(
            { arguments: [{ kind: ExecutionArgumentKind.Text, maximumBytes: 4096 }] },
            [payload],
        ),
    ).toEqual([payload]);
    expect(() => ExecutionInputCodec.arguments({ arguments: [rule] }, [payload])).toThrow(
        'typed native plan resolver',
    );
    expect(() =>
        ExecutionInputCodec.arguments(
            { arguments: [{ kind: ExecutionArgumentKind.Literal, value: '--fixed' }, rule] },
            [payload],
        ),
    ).toThrow();
});

it('closed variants reject extra capabilities, incomplete inputs and guessed execution modes', (): void => {
    const rule: ExecutionMachineInvocationRule = Fixture.rule();
    const invalid: readonly unknown[] = [
        { ...Fixture.shell(), terminal: { columns: 80, rows: 24 } },
        { ...Fixture.shell(), ports: [80] },
        { ...Fixture.shell(), network: true },
        { ...Fixture.shell(), argv: [] },
        { ...Fixture.argv(), script: 'id' },
        { ...Fixture.shell(), mode: 'automatic' },
        { ...Fixture.shell(), timeoutMs: undefined },
        { ...Fixture.shell(), stdin: undefined },
        { ...Fixture.argv(), command: '/usr/bin/node' },
        { ...Fixture.argv(), command: 'unknown' },
    ];
    for (const input of invalid) {
        expect(() => Codec.encode(rule, input)).toThrow();
    }
    const noShell: ExecutionMachineInvocationRule = ExecutionMachineRuleCodec.read({
        ...rule,
        shell: null,
    });
    expect(() => Codec.encode(noShell, Fixture.shell())).toThrow();
    const noArgv: ExecutionMachineInvocationRule = ExecutionMachineRuleCodec.read({
        ...rule,
        commands: [],
    });
    expect(() => Codec.encode(noArgv, Fixture.argv())).toThrow();
});

it('canonical JSON forbids alternate key order, duplicate keys and equivalent escaping in the exact signed argument', (): void => {
    const rule: ExecutionMachineInvocationRule = Fixture.rule();
    const input: ExecutionMachineShellInvocation = Fixture.shell();
    const canonical: string = Codec.encode(rule, input);
    const alternatives: readonly string[] = [
        ' ' + canonical,
        JSON.stringify({
            script: input.script,
            mode: input.mode,
            cwd: input.cwd,
            environment: input.environment,
            stdin: input.stdin,
            timeoutMs: input.timeoutMs,
        }),
        canonical.replace('"mode":"shell"', '"mode":"shell","mode":"shell"'),
        canonical.replace('printf', '\\u0070rintf'),
        canonical.replace('"cwd":"."', '"cwd":".","cwd":"."'),
    ];
    for (const json of alternatives) {
        expect(() => Codec.decode(rule, json)).toThrow();
    }
});

it('cwd is a canonical relative path beneath the captured root without reinterpreting it as an option or host path', (): void => {
    const rule: ExecutionMachineInvocationRule = Fixture.rule();
    for (const cwd of [
        '',
        '/',
        '/workspace/src',
        './src',
        '../src',
        'src/..',
        'a//b',
        'a/./b',
        'a/',
        'a\\b',
        'C:host',
        'a\nb',
        'a\0b',
        '\ud800',
        'a'.repeat(513),
    ]) {
        expect(() => Codec.encode(rule, { ...Fixture.shell(), cwd })).toThrow();
    }
    for (const cwd of ['.', 'src/test', '-named-directory', '日本語']) {
        expect(Codec.resolve(rule, Codec.encode(rule, { ...Fixture.shell(), cwd })).cwd).toBe(cwd);
    }
});

it('environment keys and aggregate UTF-8 names plus values are explicitly granted and never inherited or normalized', (): void => {
    const rule: ExecutionMachineInvocationRule = Fixture.rule();
    const invalid: readonly unknown[] = [
        [{ name: 'PATH', value: '/host' }],
        [{ name: 'APP_MODE', value: 'x\0y' }],
        [{ name: 'APP_MODE', value: '\ud800' }],
        [{ name: 'APP_MODE', value: 'x'.repeat(513) }],
        [{ name: 'NERVA_CONNECTOR_PARENT_PID', value: '1' }],
        [
            { name: 'LANG', value: 'C' },
            { name: 'APP_MODE', value: 'test' },
        ],
        [
            { name: 'APP_MODE', value: 'one' },
            { name: 'APP_MODE', value: 'two' },
        ],
        [
            { name: 'APP_MODE', value: 'x'.repeat(512) },
            { name: 'LANG', value: 'x'.repeat(512) },
        ],
    ];
    for (const environment of invalid) {
        expect(() => Codec.encode(rule, { ...Fixture.shell(), environment })).toThrow();
    }
    const input: ExecutionMachineEnvironmentValue[] = [{ name: 'APP_MODE', value: '😀' }];
    const plan: ExecutionMachinePlan = Codec.resolve(
        rule,
        Codec.encode(rule, { ...Fixture.shell(), environment: input }),
    );
    input.splice(0, 1);
    expect(plan.environment).toEqual([{ name: 'APP_MODE', value: '😀' }]);
});

it('finite stdin preserves NUL and Unicode exactly while C-string argv, scripts and environment reject NUL', (): void => {
    const rule: ExecutionMachineInvocationRule = Fixture.rule();
    const stdin: string = 'before\0😀\nafter';
    expect(Codec.resolve(rule, Codec.encode(rule, { ...Fixture.shell(), stdin })).stdin).toBe(
        stdin,
    );
    expect(
        Codec.resolve(rule, Codec.encode(rule, { ...Fixture.shell(), stdin: '😀'.repeat(256) }))
            .stdin,
    ).toBe('😀'.repeat(256));
    expect(() => Codec.encode(rule, { ...Fixture.shell(), stdin: '😀'.repeat(257) })).toThrow();
    expect(() => Codec.encode(rule, { ...Fixture.shell(), stdin: '\ud800' })).toThrow();
    expect(() => Codec.encode(rule, { ...Fixture.shell(), script: 'x\0y' })).toThrow();
    expect(() => Codec.encode(rule, { ...Fixture.argv(), argv: ['x\0y'] })).toThrow();
});

it('the complete 4096-byte escaped payload ceiling applies independently of every valid sublimit', (): void => {
    const rule: ExecutionMachineInvocationRule = Fixture.rule();
    expect(() => Codec.encode(rule, { ...Fixture.shell(), script: '"'.repeat(2048) })).toThrow();
    expect(() => Codec.encode(rule, { ...Fixture.shell(), stdin: '\0'.repeat(700) })).toThrow();
    expect(() =>
        Codec.encode(rule, {
            ...Fixture.shell(),
            script: 'x'.repeat(2048),
            stdin: 'x'.repeat(1024),
            cwd: 'x'.repeat(512),
            environment: [{ name: 'APP_MODE', value: 'x'.repeat(512) }],
        }),
    ).toThrow();
    expect(() => Codec.decode(rule, 'x'.repeat(4097))).toThrow();
});

it('argv and timeout limits remain finite without truncating values, changing counters or joining arguments into shell text', (): void => {
    const rule: ExecutionMachineInvocationRule = Fixture.rule();
    for (const argv of [
        Array.from({ length: 33 }, (): string => ''),
        ['x'.repeat(1025)],
        ['x'.repeat(1024), 'x'.repeat(1024), 'x'],
        ['\ud800'],
    ]) {
        expect(() => Codec.encode(rule, { ...Fixture.argv(), argv })).toThrow();
    }
    for (const timeoutMs of [0, 99, 5001, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1]) {
        expect(() => Codec.encode(rule, { ...Fixture.shell(), timeoutMs })).toThrow();
    }
    expect(
        Codec.resolve(
            rule,
            Codec.encode(rule, {
                ...Fixture.argv(),
                argv: ['; echo unjoined', '$(id)'],
                timeoutMs: 100,
            }),
        ).arguments,
    ).toEqual(['; echo unjoined', '$(id)']);
});

it('input getters, hidden fields, symbols, sparse arrays and array properties cannot smuggle executable behavior', (): void => {
    const rule: ExecutionMachineInvocationRule = Fixture.rule();
    let reads: number = 0;
    const input: ExecutionMachineShellInvocation = { ...Fixture.shell() };
    Object.defineProperty(input, 'cwd', {
        enumerable: true,
        get: (): string => {
            reads++;
            return '.';
        },
    });
    expect(() => Codec.encode(rule, input)).toThrow();
    expect(reads).toBe(0);
    const hidden: ExecutionMachineShellInvocation = { ...Fixture.shell() };
    Object.defineProperty(hidden, 'ungranted', { value: true });
    expect(() => Codec.encode(rule, hidden)).toThrow();
    const symbol: ExecutionMachineShellInvocation = { ...Fixture.shell() };
    Reflect.set(symbol, Symbol('grant'), true);
    expect(() => Codec.encode(rule, symbol)).toThrow();
    const sparse: string[] = new Array<string>(1);
    expect(() => Codec.encode(rule, { ...Fixture.argv(), argv: sparse })).toThrow();
    const extra: string[] = [];
    Reflect.set(extra, 'program', 'host');
    expect(() => Codec.encode(rule, { ...Fixture.argv(), argv: extra })).toThrow();
    const fake: unknown = Object.create(null);
    expect(() => Codec.encode(rule, fake)).toThrow();
    expect(
        Codec.decode(
            rule,
            Codec.encode(rule, { ...Fixture.shell(), mode: ExecutionMachineMode.Shell }),
        ),
    ).toEqual(Fixture.shell());
});

it('Machine array boundaries reject custom prototypes and accessors without reading iterators or element getters', (): void => {
    const rule: ExecutionMachineInvocationRule = Fixture.rule();
    let reads: number = 0;
    const custom: string[] = ['--version'];
    Object.setPrototypeOf(custom, {
        get [Symbol.iterator](): never {
            reads++;
            throw new Error('Untrusted iterator invoked');
        },
    });
    expect(() => Codec.encode(rule, { ...Fixture.argv(), argv: custom })).toThrow();
    expect(() => ExecutionMachineBoundary.array(custom, 32)).toThrow();
    expect(reads).toBe(0);
    const accessor: string[] = ['--version'];
    Object.defineProperty(accessor, '0', {
        enumerable: true,
        get: (): string => {
            reads++;
            return '--host';
        },
    });
    expect(() => Codec.encode(rule, { ...Fixture.argv(), argv: accessor })).toThrow();
    expect(reads).toBe(0);
    const hidden: string[] = ['--version'];
    Object.defineProperty(hidden, '0', { enumerable: false });
    expect(() => ExecutionMachineBoundary.array(hidden, 32)).toThrow();
    const symbol: string[] = ['--version'];
    Reflect.set(symbol, Symbol('input'), true);
    expect(() => ExecutionMachineBoundary.array(symbol, 32)).toThrow();
    expect(ExecutionMachineBoundary.array(Object.freeze(['--version']), 32)).toEqual(['--version']);
    expect(
        Codec.resolve(
            rule,
            Codec.encode(rule, { ...Fixture.argv(), argv: Object.freeze(['--version']) }),
        ).arguments,
    ).toEqual(['--version']);
});
