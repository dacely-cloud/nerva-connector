// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

import { createHash } from 'node:crypto';
import { expect, it } from 'vitest';
import { ExecutionInputCodec } from 'nerva-connector-protocol/execution/ExecutionInputCodec.js';
import {
    type ExecutionPolicyDefinition,
    type ExecutionProgramPolicy,
} from 'nerva-connector-protocol/execution/ExecutionPolicyTypes.js';
import { ExecutionArgumentKind } from 'nerva-connector-protocol/execution/ExecutionArgumentKind.js';
import { ExecutionMachineRuleCodec as Codec } from 'nerva-connector-protocol/execution/ExecutionMachineRuleCodec.js';
import { ExecutionMachineInvocationCodec } from 'nerva-connector-protocol/execution/ExecutionMachineInvocationCodec.js';
import type { ExecutionMachineInvocationRule } from 'nerva-connector-protocol/execution/ExecutionMachineInvocation.js';
import { ExecutionPolicyCodec } from '../src/execution/ExecutionPolicyCodec.js';
import { ExecutionJobsCodec } from '../src/execution/ExecutionJobsCodec.js';
import {
    type ExecutionProfile,
    type ExecutionPublication,
    type ExecutionRequest,
} from 'nerva-connector-protocol/execution/ExecutionJobs.js';
import { ExecutionLane } from 'nerva-connector-protocol/execution/ExecutionLane.js';
import { ExecutionProof } from 'nerva-connector-protocol/execution/ExecutionProof.js';
import { executionPublicProfile } from '../src/execution/ExecutionPublicProfile.js';
import { ConnectorAuthorizationKind } from 'nerva-connector-protocol/protocol/ConnectorAuthorization.js';
import { ConnectorAuthorizationProof } from 'nerva-connector-protocol/protocol/ConnectorAuthorizationProof.js';
import { SigningKey } from '../src/identity/SigningKey.js';
import { SignaturePurpose } from 'nerva-connector-protocol/identity/IdentityFormat.js';
import { ExecutionMachineFixture as Fixture } from './support/ExecutionMachineFixture.js';

/** Local policy JSON preserves exact integer quantities without opening the paths contained in it. */
function policyJson(policy: ExecutionPolicyDefinition = Fixture.policy()): unknown {
    const encoded: string = JSON.stringify(policy, (_key: string, value: unknown): unknown =>
        typeof value === 'bigint' ? value.toString() : value,
    );
    const raw: unknown = JSON.parse(encoded);
    return raw;
}

/** The signed public profile uses its production exact JSON representation before boundary validation. */
function profileJson(profile: ExecutionProfile): unknown {
    const raw: unknown = JSON.parse(ExecutionJobsCodec.encode(profile));
    return raw;
}

it('Machine grants require every explicit bound and reject unknown, duplicated or reserved authority', (): void => {
    const rule: ExecutionMachineInvocationRule = Fixture.rule();
    expect(ExecutionInputCodec.argumentRule(rule)).toEqual(rule);
    for (const field of Object.keys(rule)) {
        const missing: Readonly<Record<string, unknown>> = { ...rule };
        Reflect.deleteProperty(missing, field);
        expect(() => Codec.read(missing)).toThrow();
    }
    const changes: readonly Readonly<Record<string, unknown>>[] = [
        { kind: 'text' },
        { shell: null, commands: [] },
        { shell: { executableIndex: 9, fixedArguments: ['-c'] } },
        { shell: { executableIndex: 0, fixedArguments: ['-c\0'] } },
        {
            shell: {
                executableIndex: 0,
                fixedArguments: Array.from({ length: 17 }, (): string => '-x'),
            },
        },
        {
            commands: [
                { alias: 'same', executableIndex: 0 },
                { alias: 'same', executableIndex: 1 },
            ],
        },
        { commands: [{ alias: '/host/program', executableIndex: 0 }] },
        { commands: [{ alias: 'host', executableIndex: -1 }] },
        {
            environment: [
                { name: 'APP_MODE', maximumBytes: 1 },
                { name: 'APP_MODE', maximumBytes: 2 },
            ],
        },
        { environment: [{ name: 'NERVA_CONNECTOR_PARENT_PID', maximumBytes: 10 }] },
        { environment: [{ name: 'NERVA_EXEC_CHANNEL', maximumBytes: 10 }] },
        { environment: [{ name: 'LD_PRELOAD\0', maximumBytes: 10 }] },
        { maximumCwdBytes: 513 },
        { maximumCwdBytes: 0 },
        { maximumEnvironmentBytes: 1025 },
        { maximumStdinBytes: 1025 },
        { maximumTimeoutMs: 30001 },
        { maximumTimeoutMs: 99 },
        { maximumArguments: 33 },
        { maximumArgumentBytes: 1025 },
        { maximumArgumentsBytes: 2049 },
        { maximumScriptBytes: 2049 },
        { maximumTimeoutMs: Number.NaN },
        { network: 'host' },
    ];
    for (const change of changes) {
        expect(() => Codec.read({ ...rule, ...change })).toThrow();
    }
    expect(Object.isFrozen(rule)).toBe(true);
    expect(Object.isFrozen(rule.shell?.fixedArguments)).toBe(true);
    expect(Object.isFrozen(rule.commands[0])).toBe(true);
    expect(Object.isFrozen(rule.environment[0])).toBe(true);
});

it('sole-rule placement and local pinned-table index checks prevent a structured argument from widening narrow positional grants', (): void => {
    const rule: ExecutionMachineInvocationRule = Fixture.rule();
    expect(ExecutionPolicyCodec.policy(policyJson())).toEqual(Fixture.policy());
    expect(Codec.placement([{ kind: ExecutionArgumentKind.Text, maximumBytes: 32 }])).toBeNull();
    expect(Codec.placement([rule])).toBe(rule);
    const invalid: readonly ExecutionProgramPolicy[] = [
        { ...Fixture.program(), children: [] },
        {
            ...Fixture.program(),
            arguments: [{ kind: ExecutionArgumentKind.Literal, value: '--fixed' }, rule],
        },
        { ...Fixture.program(), arguments: [rule, rule] },
        Fixture.program(
            Codec.read({ ...rule, shell: { executableIndex: 2, fixedArguments: ['-c'] } }),
        ),
        Fixture.program(Codec.read({ ...rule, maximumTimeoutMs: 5001 })),
    ];
    for (const program of invalid) {
        expect(() =>
            ExecutionPolicyCodec.policy(policyJson({ ...Fixture.policy(), programs: [program] })),
        ).toThrow();
    }
});

it('public projection publishes the entire detached Machine rule while private executable paths and digests stay private', (): void => {
    const profile: ExecutionProfile = executionPublicProfile({
        definition: Fixture.policy(),
        policySha256: 'f'.repeat(64),
    });
    expect(profile.programs[0]?.arguments).toEqual([Fixture.rule()]);
    const published: ExecutionProfile = ExecutionJobsCodec.profile(profileJson(profile));
    expect(published).toEqual(profile);
    const encoded: string = ExecutionJobsCodec.encode(profile);
    expect(encoded).not.toContain('/usr/bin/bash');
    expect(encoded).not.toContain('/usr/bin/node');
    expect(encoded).not.toContain('sha256');
    expect(encoded).toContain('"fixedArguments":["--noprofile","--norc","-c"]');
    expect(Object.isFrozen(profile.programs[0]?.arguments[0])).toBe(true);
    const changes: readonly ExecutionMachineInvocationRule[] = [
        Codec.read({ ...Fixture.rule(), maximumTimeoutMs: 5001 }),
    ];
    for (const rule of changes) {
        const changed: ExecutionProfile = {
            ...profile,
            programs: [{ id: 'machine', rootIds: ['project'], arguments: [rule] }],
        };
        expect(() => ExecutionJobsCodec.profile(profileJson(changed))).toThrow();
    }
    const mixed: ExecutionProfile = {
        ...profile,
        programs: [
            {
                id: 'machine',
                rootIds: ['project'],
                arguments: [Fixture.rule(), { kind: ExecutionArgumentKind.Text, maximumBytes: 32 }],
            },
        ],
    };
    expect(() => ExecutionJobsCodec.profile(profileJson(mixed))).toThrow();
});

it('genuine composite device publication signatures cover every new rule field without adding a second unsigned capability channel', (): void => {
    using key: SigningKey = SigningKey.generate();
    const rule: ExecutionMachineInvocationRule = Fixture.rule();
    const profile: ExecutionProfile = executionPublicProfile({
        definition: Fixture.policy(),
        policySha256: 'f'.repeat(64),
    });
    const publication: Omit<ExecutionPublication, 'signature'> = {
        lane: ExecutionLane.First,
        environmentId: 'env-one',
        enrollmentId: 'conn_' + 'e'.repeat(64),
        leaseId: 'lease',
        profile,
        journalId: 'a'.repeat(64),
    };
    const proof: Buffer = ExecutionProof.publication(publication);
    const signature: string = key.sign(SignaturePurpose.ExecutionProfile, proof);
    expect(
        SigningKey.verify(SignaturePurpose.ExecutionProfile, key.publicKey, proof, signature),
    ).toBe(true);
    const changed: readonly ExecutionMachineInvocationRule[] = [
        Codec.read({ ...rule, shell: null }),
        Codec.read({ ...rule, shell: { executableIndex: 1, fixedArguments: ['-c'] } }),
        Codec.read({ ...rule, commands: [{ alias: 'other', executableIndex: 1 }] }),
        Codec.read({ ...rule, maximumCwdBytes: 511 }),
        Codec.read({ ...rule, environment: [] }),
        Codec.read({ ...rule, maximumEnvironmentBytes: 1023 }),
        Codec.read({ ...rule, maximumStdinBytes: 1023 }),
        Codec.read({ ...rule, maximumTimeoutMs: 4999 }),
        Codec.read({ ...rule, maximumArguments: 31 }),
        Codec.read({ ...rule, maximumArgumentBytes: 1023 }),
        Codec.read({ ...rule, maximumArgumentsBytes: 2047 }),
        Codec.read({ ...rule, maximumScriptBytes: 2047 }),
    ];
    for (const altered of changed) {
        const candidate: Omit<ExecutionPublication, 'signature'> = {
            ...publication,
            profile: {
                ...profile,
                programs: [{ id: 'machine', rootIds: ['project'], arguments: [altered] }],
            },
        };
        expect(
            SigningKey.verify(
                SignaturePurpose.ExecutionProfile,
                key.publicKey,
                ExecutionProof.publication(candidate),
                signature,
            ),
        ).toBe(false);
    }
});

it('the unchanged request and admission hashes commit the complete canonical payload including stdin, cwd, environment, mode and timeout', (): void => {
    const rule: ExecutionMachineInvocationRule = Fixture.rule();
    const payload: string = ExecutionMachineInvocationCodec.encode(rule, Fixture.shell());
    const request: ExecutionRequest = ExecutionJobsCodec.request({
        requestId: 'original',
        policySha256: 'a'.repeat(64),
        programId: 'machine',
        rootId: 'project',
        arguments: [payload],
    });
    const hash: string = ExecutionProof.requestHash(request);
    expect(hash).toBe(
        createHash('sha256')
            .update(
                JSON.stringify({
                    requestId: 'original',
                    policySha256: 'a'.repeat(64),
                    programId: 'machine',
                    rootId: 'project',
                    arguments: [payload],
                }),
            )
            .digest('hex'),
    );
    const admission: string = ConnectorAuthorizationProof.execution(hash, ExecutionLane.First, {
        kind: ConnectorAuthorizationKind.Independent,
    });
    const changed: readonly unknown[] = [
        { ...Fixture.shell(), script: 'printf changed' },
        { ...Fixture.shell(), cwd: 'src' },
        { ...Fixture.shell(), environment: [{ name: 'APP_MODE', value: 'test' }] },
        { ...Fixture.shell(), stdin: '\0' },
        { ...Fixture.shell(), timeoutMs: 1001 },
        Fixture.argv(),
    ];
    for (const input of changed) {
        const candidate: ExecutionRequest = {
            ...request,
            arguments: [ExecutionMachineInvocationCodec.encode(rule, input)],
        };
        const candidateHash: string = ExecutionProof.requestHash(candidate);
        expect(candidateHash).not.toBe(hash);
        expect(
            ConnectorAuthorizationProof.execution(candidateHash, ExecutionLane.First, {
                kind: ConnectorAuthorizationKind.Independent,
            }),
        ).not.toBe(admission);
    }
    expect(Object.keys(request)).toEqual([
        'requestId',
        'policySha256',
        'programId',
        'rootId',
        'arguments',
    ]);
});

it('argument-rule dispatch and positional fields reject accessors without invoking them', (): void => {
    let reads: number = 0;
    const getter: () => never = (): never => {
        reads++;
        throw new Error('Untrusted getter');
    };
    for (const field of ['kind', 'maximumBytes']) {
        const rule: Record<string, string | number> = {
            kind: ExecutionArgumentKind.Text,
            maximumBytes: 32,
        };
        Object.defineProperty(rule, field, { enumerable: true, get: getter });
        expect(() => ExecutionInputCodec.argumentRule(rule)).toThrow();
    }
    expect(reads).toBe(0);
});
