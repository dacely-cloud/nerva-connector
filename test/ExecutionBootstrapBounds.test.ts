// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

import { expect, it } from 'vitest';
import { ExecutionBootstrapLimits as Limits } from '../src/execution/ExecutionBootstrapLimits.js';
import { ExecutionInputCodec } from '../src/execution/ExecutionInputCodec.js';
import { ExecutionPolicyCodec } from '../src/execution/ExecutionPolicyCodec.js';
import { ExecutionInvocationResolution } from '../src/execution/ExecutionResolvedInvocation.js';
import { ExecutionBootstrapInputKind } from '../src/execution/ExecutionBootstrapInput.js';
import type { ExecutionBootstrapInput } from '../src/execution/ExecutionBootstrapInput.js';
import {
    type ExecutionPolicyDefinition,
    type ExecutionProgramPolicy,
    type ExecutionTextArgument,
} from '../src/execution/ExecutionPolicyTypes.js';
import { ExecutionArgumentKind } from 'nerva-connector-protocol/execution/ExecutionArgumentKind.js';
import type { ExecutionMachineEnvironmentValue } from 'nerva-connector-protocol/execution/ExecutionMachineInvocation.js';
import { ExecutionMachineFixture } from './support/ExecutionMachineFixture.js';
import { ExecutionWorkspaceAccess } from '../src/execution/ExecutionTypes.js';
import type { ExecutionBootstrap } from '../src/execution/ExecutionTypes.js';
import type { WorkspaceIdentity } from '../src/workspace/WorkspaceIdentity.js';
import type { ExecutionCgroupIdentity } from '../src/execution/ExecutionCgroupIdentity.js';

/** Descriptor duplication is part of the private native encoding and not the public grant. */
interface NativeDescriptor {
    readonly path: string;
    readonly descriptor: number;
}

/** This pure corpus never opens or claims a filesystem object at a validation-only path. */
interface NativeConfiguration extends ExecutionBootstrap {
    readonly executableDescriptors: readonly NativeDescriptor[];
}

/** Physical identity strings have their complete maximum-width native grammar. */
interface LaunchEnvelope {
    readonly configuration: NativeConfiguration;
    readonly workspaceIdentity: WorkspaceIdentity;
    readonly cgroupIdentity: ExecutionCgroupIdentity;
}

/** Uses the same exact integer encoding as the native sandbox boundary. */
function json(value: ExecutionPolicyDefinition | NativeConfiguration | LaunchEnvelope): string {
    return JSON.stringify(value, (_key: string, entry: unknown): unknown =>
        typeof entry === 'bigint' ? entry.toString() : entry,
    );
}

/** All thirty-two positions and all nine existing private binaries remain legal. */
function policy(pathBytes: number, character: string): ExecutionPolicyDefinition {
    const text: ExecutionTextArgument = { kind: ExecutionArgumentKind.Text, maximumBytes: 4096 };
    const paths: readonly string[] = Array.from(
        { length: 9 },
        (_unused: unknown, index: number): string =>
            '/opt/' + character.repeat(pathBytes - 6) + index.toString(),
    );
    const primary: string | undefined = paths[0];
    if (primary === undefined) {
        throw new Error('Primary path required');
    }
    const program: ExecutionProgramPolicy = {
        ...ExecutionMachineFixture.program(),
        id: 'p'.repeat(128),
        rootIds: ['r'.repeat(128)],
        path: primary,
        children: paths
            .slice(1)
            .map((path: string): ExecutionProgramPolicy['children'][number] => ({
                path,
                sha256: 'b'.repeat(64),
            })),
        arguments: Array.from({ length: 32 }, (): ExecutionTextArgument => text),
    };
    const candidate: ExecutionPolicyDefinition = {
        ...ExecutionMachineFixture.policy(),
        revision: 9223372036854775807n,
        timeoutMs: 30000,
        maximumAddressBytes: 17592186044416n,
        maximumFileBytes: 16777216n,
        roots: [
            {
                id: 'r'.repeat(128),
                path: '/srv/project',
                access: ExecutionWorkspaceAccess.ReadWrite,
            },
        ],
        programs: [program],
    };
    const raw: unknown = JSON.parse(json(candidate));
    return ExecutionPolicyCodec.policy(raw);
}

/** Finds the largest legal equal-length path table within the actual 64KiB policy file budget. */
function maximumPolicy(character: string): ExecutionPolicyDefinition {
    let low: number = 6;
    let high: number = 4096;
    while (low < high) {
        const middle: number = Math.ceil((low + high) / 2);
        if (Buffer.byteLength(json(policy(middle, character))) <= 65536) {
            low = middle;
        } else {
            high = middle - 1;
        }
    }
    return policy(low, character);
}

/** Deliberately fills every independently bounded native input field without claiming a signed Pipe launch. */
function configuration(
    definition: ExecutionPolicyDefinition,
    input: ExecutionBootstrapInput,
): NativeConfiguration {
    const program: ExecutionProgramPolicy | undefined = definition.programs[0];
    const root: ExecutionPolicyDefinition['roots'][number] | undefined = definition.roots[0];
    if (program === undefined || root === undefined) {
        throw new Error('Complete pure policy corpus required');
    }
    const args: readonly string[] = Array.from(
        { length: 32 },
        (_unused: unknown, index: number): string => '\u0001'.repeat(index < 2 ? 4081 : 1),
    );
    const invocation: ReturnType<typeof ExecutionInputCodec.invocation> =
        ExecutionInputCodec.invocation({
            policySha256: 'a'.repeat(64),
            programId: program.id,
            rootId: root.id,
            arguments: args,
        });
    const resolved: ReturnType<typeof ExecutionInvocationResolution.capture> =
        ExecutionInvocationResolution.capture(program, invocation, 30000);
    const paths: readonly string[] = [
        program.path,
        ...program.children.map(
            (child: ExecutionProgramPolicy['children'][number]): string => child.path,
        ),
    ];
    const namespace: string = ':[18446744073709551615]';
    return {
        admissionExpiresAtMs: 9223372036854775807n,
        apparmorProfile: 'nerva-connector-exec-' + 'a'.repeat(32) + '-' + 'b'.repeat(64),
        program: resolved.program.path,
        arguments: resolved.arguments,
        input,
        allowedExecutables: paths,
        executableDescriptors: paths.map((path: string, index: number): NativeDescriptor => ({
            path,
            descriptor: (input.kind === ExecutionBootstrapInputKind.Pipe ? 9 : 8) + index,
        })),
        workspaceAccess: ExecutionWorkspaceAccess.ReadWrite,
        parentNamespaces: {
            mnt: 'mnt' + namespace,
            user: 'user' + namespace,
            pid: 'pid' + namespace,
            net: 'net' + namespace,
            ipc: 'ipc' + namespace,
            uts: 'uts' + namespace,
            cgroup: 'cgroup' + namespace,
        },
        maximumCpuSeconds: 30,
        maximumAddressBytes: 17592186044416n,
        maximumFileBytes: 16777216n,
    };
}

/** This is a parser-bound corpus: application grants independently constrain simultaneous field combinations. */
function envelope(value: NativeConfiguration): LaunchEnvelope {
    return {
        configuration: value,
        workspaceIdentity: {
            filesystemUuid: 'f'.repeat(32),
            device: 18446744073709551615n,
            inode: 18446744073709551615n,
            handleType: 1,
            handle: 'f'.repeat(16),
        },
        cgroupIdentity: {
            bootId: 'ffffffff-ffff-ffff-ffff-ffffffffffff',
            device: 18446744073709551615n,
            filesystemId: 'f'.repeat(16),
            handleType: 254,
            handle: 'f'.repeat(16),
        },
    };
}

it('maximum legal policy paths, C0 argv, all positions and physical metadata fit the finite native parser budgets', (): void => {
    for (const character of ['x', '\\', '"']) {
        const definition: ExecutionPolicyDefinition = maximumPolicy(character);
        expect(Buffer.byteLength(json(definition))).toBeLessThanOrEqual(65536);
        const pipe: ExecutionBootstrapInput = {
            kind: ExecutionBootstrapInputKind.Pipe,
            executionDeadlineMs: 9223372036854775807n,
            cwd: '"'.repeat(512),
            environment: Array.from(
                { length: 16 },
                (_unused: unknown, index: number): ExecutionMachineEnvironmentValue => ({
                    name: 'APP_' + index.toString().padStart(2, '0'),
                    value: '\u0001'.repeat(58),
                }),
            ),
            stdin: '\u0000'.repeat(1024),
            incarnation: 'f'.repeat(64),
            guardianProfile: 'nerva-connector-guard-' + 'a'.repeat(32) + '-' + 'b'.repeat(64),
            maximumInputBytes: 65536n,
            maximumControls: 256,
        };
        const native: NativeConfiguration = configuration(definition, pipe);
        const inner: string = json(native);
        const outer: string = json(envelope(native));
        console.info(
            JSON.stringify({
                maximumBootstrapPathCharacter: character,
                innerBytes: Buffer.byteLength(inner),
                outerBytes: Buffer.byteLength(outer),
            }),
        );
        expect(Buffer.byteLength(inner)).toBeGreaterThan(131072);
        expect(Buffer.byteLength(inner)).toBeLessThanOrEqual(211456);
        expect(Buffer.byteLength(outer) - Buffer.byteLength(inner)).toBe(376);
        expect(() => Limits.configuration(inner)).not.toThrow();
        expect(() => Limits.launch(outer)).not.toThrow();
    }
});

it('inner and outer UTF-8 budgets accept the exact byte ceiling and reject one byte more', (): void => {
    expect(() => Limits.configuration('x'.repeat(Limits.configurationBytes))).not.toThrow();
    expect(() => Limits.configuration('x'.repeat(Limits.configurationBytes + 1))).toThrow(/limit/u);
    expect(() => Limits.launch('x'.repeat(Limits.launchBytes))).not.toThrow();
    expect(() => Limits.launch('x'.repeat(Limits.launchBytes + 1))).toThrow(/bound/u);
    expect(() => Limits.configuration('é'.repeat(Limits.configurationBytes / 2) + 'x')).toThrow(
        /limit/u,
    );
});
