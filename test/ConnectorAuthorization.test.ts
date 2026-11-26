// SPDX-FileCopyrightText: 2026 Dacely <business@dacely.com>
// SPDX-License-Identifier: LicenseRef-Proprietary

import { expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { SigningKey } from '../src/identity/SigningKey.js';
import { JointWorkspaceProof } from 'nerva-connector-protocol/workspace/JointWorkspaceProof.js';
import { JointWorkspaceCodec } from 'nerva-connector-protocol/workspace/JointWorkspaceCodec.js';
import type {
    JointWorkspaceBinding,
    JointWorkspaceDescriptor,
    JointWorkspaceScope,
} from 'nerva-connector-protocol/workspace/JointWorkspaceBinding.js';
import { ConnectorFileMode } from 'nerva-connector-protocol/protocol/ConnectorFiles.js';
import {
    ConnectorAuthorizationKind,
    type ConnectorAuthorization,
} from 'nerva-connector-protocol/protocol/ConnectorAuthorization.js';
import { ConnectorAuthorizationCodec } from 'nerva-connector-protocol/protocol/ConnectorAuthorizationCodec.js';
import { ConnectorAuthorizationProof } from 'nerva-connector-protocol/protocol/ConnectorAuthorizationProof.js';
import { type ExecutionRequest } from 'nerva-connector-protocol/execution/ExecutionJobs.js';
import { ExecutionLane } from 'nerva-connector-protocol/execution/ExecutionLane.js';
import { ExecutionProof } from 'nerva-connector-protocol/execution/ExecutionProof.js';
import { ExecutionJobsCodec } from '../src/execution/ExecutionJobsCodec.js';

/** This finite body intentionally uses a revision above number precision; every field remains public scope metadata. */
const body: JointWorkspaceBinding = {
    authorityId: 'cloud',
    environmentId: 'environment-owned',
    enrollmentId: 'conn_' + 'a'.repeat(64),
    revision: 9007199254740993n,
    filePolicySha256: '1'.repeat(64),
    executionPolicySha256: '2'.repeat(64),
    fileRootId: 'files-root',
    executionRootId: 'commands-root',
    access: ConnectorFileMode.ReadWrite,
    physicalRootCommitment: '3'.repeat(64),
    fileJournalId: '4'.repeat(64),
    executionJournals: { first: '5'.repeat(64), second: '6'.repeat(64) },
};
/** Existing command payload identity remains entirely unchanged by the separate envelope. */
const request: ExecutionRequest = {
    requestId: 'original-request',
    policySha256: body.executionPolicySha256,
    programId: 'compile',
    rootId: body.executionRootId,
    arguments: ['input.bin'],
};
/** Explicit independent use never claims a shared physical workspace. */
const independent: ConnectorAuthorization = { kind: ConnectorAuthorizationKind.Independent };

it('receiver-selected channel, exact command lane and authorization kind partition the unchanged original request hash', (): void => {
    using key: SigningKey = SigningKey.generate();
    const authorization: ConnectorAuthorization = {
        kind: ConnectorAuthorizationKind.Joint,
        binding: JointWorkspaceProof.sign(key, body),
    };
    const original: string = ExecutionJobsCodec.encode(request);
    const hash: string = ExecutionProof.requestHash(request);
    const hashes: readonly string[] = [
        ConnectorAuthorizationProof.file(hash, independent),
        ConnectorAuthorizationProof.execution(hash, ExecutionLane.First, independent),
        ConnectorAuthorizationProof.execution(hash, ExecutionLane.Second, independent),
        ConnectorAuthorizationProof.file(hash, authorization),
        ConnectorAuthorizationProof.execution(hash, ExecutionLane.First, authorization),
        ConnectorAuthorizationProof.execution(hash, ExecutionLane.Second, authorization),
    ];
    expect(new Set(hashes).size).toBe(hashes.length);
    expect(ExecutionJobsCodec.encode(request)).toBe(original);
    expect(ExecutionProof.requestHash(request)).toBe(hash);
    expect(ConnectorAuthorizationProof.file(hash, authorization)).toBe(
        createHash('sha256')
            .update(
                JSON.stringify([
                    'nerva-connector:operation-admission:1',
                    'files',
                    null,
                    hash,
                    [ConnectorAuthorizationKind.Joint, JointWorkspaceProof.bindingSha256(body)],
                ]),
            )
            .digest('hex'),
    );
    expect(ConnectorAuthorizationProof.file('b'.repeat(64), authorization)).not.toBe(hashes[3]);
    for (const changed of ['', hash.toUpperCase(), '0'.repeat(63), '0'.repeat(65)]) {
        expect((): string => ConnectorAuthorizationProof.file(changed, authorization)).toThrow();
    }
});

it('every immutable body field including both journal lanes affects admission, while invalidating the old signature', (): void => {
    using key: SigningKey = SigningKey.generate();
    const descriptor: JointWorkspaceDescriptor = JointWorkspaceProof.sign(key, body);
    const authorization: ConnectorAuthorization = {
        kind: ConnectorAuthorizationKind.Joint,
        binding: descriptor,
    };
    const hash: string = ExecutionProof.requestHash(request);
    const expected: string = ConnectorAuthorizationProof.execution(
        hash,
        ExecutionLane.First,
        authorization,
    );
    const scope: JointWorkspaceScope = {
        authorityId: body.authorityId,
        environmentId: body.environmentId,
        enrollmentId: body.enrollmentId,
        devicePublicKey: key.publicKey,
    };
    const mutations: readonly JointWorkspaceBinding[] = [
        { ...body, authorityId: 'other-authority' },
        { ...body, environmentId: 'other-environment' },
        { ...body, enrollmentId: 'conn_' + 'b'.repeat(64) },
        { ...body, revision: body.revision + 1n },
        { ...body, filePolicySha256: '7'.repeat(64) },
        { ...body, executionPolicySha256: '7'.repeat(64) },
        { ...body, fileRootId: 'other-files' },
        { ...body, executionRootId: 'other-commands' },
        { ...body, access: ConnectorFileMode.ReadOnly },
        { ...body, physicalRootCommitment: '7'.repeat(64) },
        { ...body, fileJournalId: '7'.repeat(64) },
        { ...body, executionJournals: { ...body.executionJournals, first: '7'.repeat(64) } },
        { ...body, executionJournals: { ...body.executionJournals, second: '7'.repeat(64) } },
    ];
    for (const changed of mutations) {
        const mutated: JointWorkspaceDescriptor = {
            binding: changed,
            signature: descriptor.signature,
        };
        expect(
            ConnectorAuthorizationProof.execution(hash, ExecutionLane.First, {
                kind: ConnectorAuthorizationKind.Joint,
                binding: mutated,
            }),
        ).not.toBe(expected);
        expect(JointWorkspaceProof.verify(SigningKey, scope, mutated)).toBe(false);
    }
});

it('randomized signatures retain one logical admission identity and require separate full-scope verification', (): void => {
    using key: SigningKey = SigningKey.generate();
    using foreign: SigningKey = SigningKey.generate();
    const first: JointWorkspaceDescriptor = JointWorkspaceProof.sign(key, body);
    const second: JointWorkspaceDescriptor = JointWorkspaceProof.sign(key, body);
    const forged: JointWorkspaceDescriptor = JointWorkspaceProof.sign(foreign, body);
    expect(first.signature).not.toBe(second.signature);
    const hash: string = ExecutionProof.requestHash(request);
    const expected: string = ConnectorAuthorizationProof.file(hash, {
        kind: ConnectorAuthorizationKind.Joint,
        binding: first,
    });
    const scope: JointWorkspaceScope = {
        authorityId: body.authorityId,
        environmentId: body.environmentId,
        enrollmentId: body.enrollmentId,
        devicePublicKey: key.publicKey,
    };
    for (const descriptor of [first, second, forged]) {
        expect(
            ConnectorAuthorizationProof.file(hash, {
                kind: ConnectorAuthorizationKind.Joint,
                binding: descriptor,
            }),
        ).toBe(expected);
    }
    expect(JointWorkspaceProof.verify(SigningKey, scope, first)).toBe(true);
    expect(JointWorkspaceProof.verify(SigningKey, scope, second)).toBe(true);
    expect(JointWorkspaceProof.verify(SigningKey, scope, forged)).toBe(false);
    for (const changed of [
        { ...scope, authorityId: 'other' },
        { ...scope, environmentId: 'other' },
        { ...scope, enrollmentId: 'conn_' + 'b'.repeat(64) },
        { ...scope, devicePublicKey: foreign.publicKey },
    ]) {
        expect(JointWorkspaceProof.verify(SigningKey, changed, first)).toBe(false);
    }
    const parsed: ConnectorAuthorization = ConnectorAuthorizationCodec.decode(
        ConnectorAuthorizationCodec.encode({
            kind: ConnectorAuthorizationKind.Joint,
            binding: first,
        }),
    );
    expect(parsed).toEqual({ kind: ConnectorAuthorizationKind.Joint, binding: first });
    if (parsed.kind !== ConnectorAuthorizationKind.Joint) {
        throw new Error('Joint envelope was not retained');
    }
    expect(parsed.binding.binding.revision).toBe(9007199254740993n);
    expect(parsed.binding.signature).toBe(first.signature);
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(Object.isFrozen(parsed.binding.binding.executionJournals)).toBe(true);
});

it('missing, extra, partial, malformed and downgrade envelopes are rejected instead of inferring authority', (): void => {
    using key: SigningKey = SigningKey.generate();
    const descriptor: JointWorkspaceDescriptor = JointWorkspaceProof.sign(key, body);
    const raw: unknown = JSON.parse(JointWorkspaceCodec.encode(descriptor));
    for (const invalid of [
        null,
        [],
        {},
        { kind: 'unknown' },
        { kind: ConnectorAuthorizationKind.Independent, binding: raw },
        { kind: ConnectorAuthorizationKind.Independent, lane: ExecutionLane.First },
        { kind: ConnectorAuthorizationKind.Joint },
        { kind: ConnectorAuthorizationKind.Joint, binding: null },
        { kind: ConnectorAuthorizationKind.Joint, binding: raw, accountId: 'other' },
        {
            kind: ConnectorAuthorizationKind.Joint,
            binding: { binding: {}, signature: descriptor.signature },
        },
        {
            kind: ConnectorAuthorizationKind.Joint,
            binding: {
                binding: { ...body, revision: '1', access: undefined },
                signature: descriptor.signature,
            },
        },
        {
            kind: ConnectorAuthorizationKind.Joint,
            binding: {
                binding: { ...body, revision: '1', extra: 'authority' },
                signature: descriptor.signature,
            },
        },
    ]) {
        expect((): ConnectorAuthorization => ConnectorAuthorizationCodec.read(invalid)).toThrow();
    }
    expect(
        ConnectorAuthorizationCodec.read({ kind: ConnectorAuthorizationKind.Independent }),
    ).toEqual(independent);
    expect((): ConnectorAuthorization =>
        ConnectorAuthorizationCodec.decode(' '.repeat(9000)),
    ).toThrow();
    const wrongLane: unknown = 'third';
    expect((): ConnectorAuthorization =>
        ConnectorAuthorizationCodec.read({
            kind: ConnectorAuthorizationKind.Independent,
            lane: wrongLane,
        }),
    ).toThrow();
});

it('the authorization codec bundles and executes in a browser context with no Buffer or Node globals', async (): Promise<void> => {
    const bundler: typeof import('rolldown') = await import('rolldown');
    const vm: typeof import('node:vm') = await import('node:vm');
    using key: SigningKey = SigningKey.generate();
    const descriptor: JointWorkspaceDescriptor = JointWorkspaceProof.sign(key, body);
    const input: string = ConnectorAuthorizationCodec.encode({
        kind: ConnectorAuthorizationKind.Joint,
        binding: descriptor,
    });
    const bundle: import('rolldown').RolldownBuild = await bundler.rolldown({
        input: 'node_modules/nerva-connector-protocol/dist/protocol/ConnectorAuthorizationCodec.js',
        platform: 'browser',
    });
    try {
        const result: Awaited<ReturnType<import('rolldown').RolldownBuild['generate']>> =
            await bundle.generate({
                format: 'iife',
                name: 'BrowserAuthorization',
                codeSplitting: false,
                minify: true,
                sourcemap: false,
            });
        const chunk: import('rolldown').OutputChunk | import('rolldown').OutputAsset | undefined =
            result.output[0];
        if (result.output.length !== 1 || chunk === undefined || chunk.type !== 'chunk') {
            throw new Error('One bounded browser codec bundle required');
        }
        expect(chunk.imports).toEqual([]);
        expect(Buffer.byteLength(chunk.code)).toBeLessThan(32768);
        const context: import('node:vm').Context = vm.createContext({
            TextEncoder,
            atob,
            btoa,
            input,
        });
        const output: unknown = vm.runInContext(
            chunk.code +
                '; if(typeof Buffer!=="undefined"||typeof process!=="undefined"){throw new Error("Unexpected Node globals");} BrowserAuthorization.ConnectorAuthorizationCodec.encode(BrowserAuthorization.ConnectorAuthorizationCodec.decode(input));',
            context,
            { timeout: 1000 },
        );
        expect(output).toBe(input);
    } finally {
        await bundle.close();
    }
});

it('untyped callers cannot omit, invent or substitute the receiver-selected command lane', async (): Promise<void> => {
    const vm: typeof import('node:vm') = await import('node:vm');
    const context: import('node:vm').Context = vm.createContext({
        commit: (lane: ExecutionLane): string =>
            ConnectorAuthorizationProof.execution('a'.repeat(64), lane, independent),
    });
    for (const expression of [
        'commit()',
        'commit(null)',
        'commit("third")',
        'commit({lane:"first"})',
    ]) {
        expect((): void => {
            vm.runInContext(expression, context, { timeout: 1000 });
        }).toThrow('lane');
    }
    const valid: unknown = vm.runInContext('commit("first")', context, { timeout: 1000 });
    expect(valid).toBe(
        ConnectorAuthorizationProof.execution('a'.repeat(64), ExecutionLane.First, independent),
    );
});

it('typed envelopes are bounded and normalized before serialization rather than silently dropping fields', (): void => {
    using key: SigningKey = SigningKey.generate();
    const descriptor: JointWorkspaceDescriptor = JointWorkspaceProof.sign(key, body);
    const extra: ConnectorAuthorization &
        Readonly<Record<string, string | ConnectorAuthorizationKind | JointWorkspaceDescriptor>> = {
        kind: ConnectorAuthorizationKind.Joint,
        binding: descriptor,
        override: 'independent',
    };
    expect((): string => ConnectorAuthorizationCodec.encode(extra)).toThrow();
    for (const binding of [
        { ...body, revision: 1n << 1024n },
        { ...body, fileRootId: 'x'.repeat(4096) },
    ]) {
        expect((): string =>
            ConnectorAuthorizationCodec.encode({
                kind: ConnectorAuthorizationKind.Joint,
                binding: { binding, signature: descriptor.signature },
            }),
        ).toThrow();
    }
});
