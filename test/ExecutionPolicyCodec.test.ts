// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

import { ExecutionInputCodec } from '../src/execution/ExecutionInputCodec.js';
import { expect, it } from 'vitest';
import { ExecutionPolicyCodec } from '../src/execution/ExecutionPolicyCodec.js';
import {
    ExecutionAppArmorProfile,
    type ExecutionAppArmorDefinition,
} from '../src/execution/ExecutionAppArmorProfile.js';
import {
    type ExecutionProgramPolicy,
    type ExecutionPolicyDefinition,
} from '../src/execution/ExecutionPolicyTypes.js';
import { ExecutionArgumentKind } from 'nerva-connector-protocol/execution/ExecutionArgumentKind.js';
import { ExecutionWorkspaceAccess } from '../src/execution/ExecutionTypes.js';

/** Explicit position grants exercise arguments a program could otherwise interpret as options or code. */
const program: ExecutionProgramPolicy = {
    id: 'approved',
    rootIds: ['project'],
    path: '/usr/bin/approved',
    sha256: 'a'.repeat(64),
    children: [],
    arguments: [
        { kind: ExecutionArgumentKind.Literal, value: '--fixed' },
        { kind: ExecutionArgumentKind.Choice, values: ['read', 'inspect'] },
        { kind: ExecutionArgumentKind.RelativePath, maximumBytes: 64 },
        { kind: ExecutionArgumentKind.Text, maximumBytes: 4 },
    ],
};

it('variable positions cannot replace literals, introduce option/traversal paths or exceed UTF-8 byte bounds', (): void => {
    expect(ExecutionInputCodec.arguments(program, ['read', 'src/main.ts', '😀'])).toEqual([
        '--fixed',
        'read',
        'src/main.ts',
        '😀',
    ]);
    for (const args of [
        ['--fixed', 'read', 'src/main.ts', 'ok'],
        ['execute', 'src/main.ts', 'ok'],
        ['read', '--config=private', 'ok'],
        ['read', '../private', 'ok'],
        ['read', '/etc/private', 'ok'],
        ['read', 'a//b', 'ok'],
        ['read', 'a/./b', 'ok'],
        ['read', 'a\nb', 'ok'],
        ['read', 'src/main.ts', '😀a'],
        ['read', 'src/main.ts'],
    ]) {
        expect((): void => {
            ExecutionInputCodec.arguments(program, args);
        }).toThrow();
    }
});

/** No paths point to real credentials or resources; this fixture only validates policy authorization shape. */
const definition: ExecutionPolicyDefinition = {
    installationId: 'a'.repeat(32),
    revision: 1n,
    trampolineFile: '/opt/nerva/exec',
    trampolineSha256: 'a'.repeat(64),
    bubblewrapFile: '/usr/bin/bwrap',
    bubblewrapSha256: 'b'.repeat(64),
    runtimeDirectory: '/opt/nerva/runtime',
    cgroupRoot: '/sys/fs/cgroup/nerva',
    roots: [{ id: 'project', path: '/srv/project', access: ExecutionWorkspaceAccess.ReadOnly }],
    programs: [program],
    resources: { memoryBytes: 67108864n, maximumTasks: 8, cpuQuotaMicros: 50000 },
    timeoutMs: 5000,
    maximumAddressBytes: 1073741824n,
    maximumFileBytes: 4096n,
};

it('incomplete, unsupported or excessive local authority never acquires permissive defaults', (): void => {
    const raw: unknown = JSON.parse(
        JSON.stringify(definition, (_key: string, value: unknown): unknown =>
            typeof value === 'bigint' ? value.toString() : value,
        ),
    );
    const canonical: ExecutionPolicyDefinition = ExecutionPolicyCodec.policy(raw);
    expect(canonical).toEqual(definition);
    const encoded: Readonly<Record<string, unknown>> = {
        ...definition,
        revision: '1',
        resources: { ...definition.resources, memoryBytes: '67108864' },
        maximumAddressBytes: '1073741824',
        maximumFileBytes: '4096',
    };
    for (const changes of [
        { installationId: undefined },
        { revision: '0' },
        { timeoutMs: 30001 },
        { maximumAddressBytes: '9007199254740993' },
        { maximumFileBytes: '16777217' },
        { resources: { memoryBytes: '33554431', maximumTasks: 8, cpuQuotaMicros: 50000 } },
        { resources: { memoryBytes: '67108864', maximumTasks: 65, cpuQuotaMicros: 50000 } },
        { roots: [{ id: 'project', path: '/srv/project', access: 'automatic' }] },
        { programs: [{ ...program, rootIds: ['ungranted'] }] },
        { programs: [{ ...program, arguments: [{ kind: 'regex', pattern: '.*' }] }] },
        { environment: { PATH: '/host' } },
    ]) {
        expect((): void => {
            ExecutionPolicyCodec.policy({ ...encoded, ...changes });
        }).toThrow();
    }
});

it('profile identity binds literal executable and workspace grants and never interpolates policy syntax', (): void => {
    const readOnly: ExecutionAppArmorDefinition = ExecutionAppArmorProfile.generate(definition);
    const writable: ExecutionAppArmorDefinition = ExecutionAppArmorProfile.generate({
        ...definition,
        roots: [
            { id: 'project', path: '/srv/project', access: ExecutionWorkspaceAccess.ReadWrite },
        ],
    });
    expect(readOnly.name).not.toBe(writable.name);
    expect(readOnly.source).toContain('abi <abi/4.0>,');
    expect(readOnly.source).toContain('change_profile -> &' + readOnly.name + ',');
    expect(readOnly.source).not.toContain('/workspace/** rwk,');
    expect(writable.source).toContain('/workspace/** rwk,');
    for (const path of ['/usr/bin/*', '/usr/bin/x" ix,', '/usr/../tmp/x']) {
        expect((): void => {
            ExecutionAppArmorProfile.generate({ ...definition, programs: [{ ...program, path }] });
        }).toThrow();
    }
});
