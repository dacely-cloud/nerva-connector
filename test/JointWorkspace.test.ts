// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

import { expect, it } from 'vitest';
import { JointWorkspaceFixture } from './support/JointWorkspaceFixture.js';
import {
    JointWorkspaceAssembly,
    type JointWorkspaceSources,
} from '../src/workspace/JointWorkspaceAssembly.js';
import { JointWorkspaceCodec } from 'nerva-connector-protocol/workspace/JointWorkspaceCodec.js';
import { Boundary } from 'nerva-connector-protocol/protocol/Boundary.js';
import { JointWorkspaceProof } from 'nerva-connector-protocol/workspace/JointWorkspaceProof.js';
import { JointWorkspaceCommitment } from '../src/workspace/JointWorkspaceCommitment.js';
import type {
    JointWorkspaceBinding,
    JointWorkspaceDescriptor,
    JointWorkspaceScope,
    JointWorkspacePhysicalScope,
} from 'nerva-connector-protocol/workspace/JointWorkspaceBinding.js';
import { WorkspaceCommitment } from '../src/workspace/WorkspaceCommitment.js';
import { ConnectorFileMode } from 'nerva-connector-protocol/protocol/ConnectorFiles.js';
import {
    IdentityLengths,
    SignaturePurpose,
} from 'nerva-connector-protocol/identity/IdentityFormat.js';
import type { WorkspaceIdentity } from '../src/workspace/WorkspaceIdentity.js';
import { SigningKey } from '../src/identity/SigningKey.js';

it.each([ConnectorFileMode.ReadOnly, ConnectorFileMode.ReadWrite])(
    'assembles a complete immutable %s descriptor from equal captured roots with different aliases',
    (access: ConnectorFileMode): void => {
        using fixture: JointWorkspaceFixture = new JointWorkspaceFixture();
        const sources: JointWorkspaceSources = fixture.sources(access);
        const descriptor: JointWorkspaceDescriptor = JointWorkspaceAssembly.create(
            fixture.device,
            fixture.scope,
            9007199254740993n,
            sources,
        );
        expect(descriptor.binding.revision).toBe(9007199254740993n);
        expect(descriptor.binding.fileRootId).not.toBe(descriptor.binding.executionRootId);
        expect(descriptor.binding.access).toBe(access);
        expect(JointWorkspaceProof.verify(SigningKey, fixture.expected, descriptor)).toBe(true);
        expect(JointWorkspaceCodec.decode(JointWorkspaceCodec.encode(descriptor))).toEqual(
            descriptor,
        );
        expect(Object.isFrozen(descriptor)).toBe(true);
        expect(Object.isFrozen(descriptor.binding)).toBe(true);
        expect(Object.isFrozen(descriptor.binding.executionJournals)).toBe(true);
        Reflect.set(sources.executionJournals, 'first', 'f'.repeat(64));
        expect(descriptor.binding.executionJournals.first).toBe('d'.repeat(64));
        for (const key of [
            'filesystemUuid',
            'inode',
            'device',
            'handle',
            'staging',
            'cgroupRoot',
            'authorityPublicKey',
        ]) {
            expect(JointWorkspaceCodec.encode(descriptor).includes('"' + key + '"')).toBe(false);
        }
    },
);

it('refuses mismatched physical identity, aliases, captured modes and source profile access instead of inferring a joint grant', (): void => {
    using fixture: JointWorkspaceFixture = new JointWorkspaceFixture();
    const sources: JointWorkspaceSources = fixture.sources();
    const invalid: readonly JointWorkspaceSources[] = [
        { ...sources, file: { ...sources.file, rootId: 'not-granted' } },
        { ...sources, execution: { ...sources.execution, rootId: 'not-granted' } },
        { ...sources, file: { ...sources.file, access: ConnectorFileMode.ReadOnly } },
        { ...sources, execution: { ...sources.execution, access: ConnectorFileMode.ReadOnly } },
        ...[
            { ...fixture.identity, filesystemUuid: '3'.repeat(32) },
            { ...fixture.identity, device: fixture.identity.device + 1n },
            { ...fixture.identity, inode: fixture.identity.inode + 1n },
            { ...fixture.identity, handle: '4'.repeat(16) },
        ].map((identity: WorkspaceIdentity): JointWorkspaceSources => ({
            ...sources,
            execution: { ...sources.execution, identity },
        })),
    ];
    for (const source of invalid) {
        expect((): JointWorkspaceDescriptor =>
            JointWorkspaceAssembly.create(fixture.device, fixture.scope, 1n, source),
        ).toThrow();
    }
    using other: JointWorkspaceFixture = new JointWorkspaceFixture();
    expect((): JointWorkspaceDescriptor =>
        JointWorkspaceAssembly.create(other.device, fixture.scope, 1n, sources),
    ).toThrow('device');
});

it('uses a new public physical HMAC, partitioned by both device secrets and exact deployment/enrollment scope, distinct from the private diagnostic', (): void => {
    using fixture: JointWorkspaceFixture = new JointWorkspaceFixture();
    using other: JointWorkspaceFixture = new JointWorkspaceFixture();
    const scope: JointWorkspacePhysicalScope = fixture.scope;
    using owner: JointWorkspaceCommitment = new JointWorkspaceCommitment(fixture.device, scope);
    const commitment: string = owner.commitment(fixture.identity);
    using diagnostic: WorkspaceCommitment = new WorkspaceCommitment(fixture.device, {
        authorityId: scope.authorityId,
        authorityPublicKey: scope.authorityPublicKey,
        enrollmentId: scope.enrollmentId,
        environmentId: scope.environmentId,
    });
    const old: Buffer = diagnostic.commitment(fixture.identity);
    try {
        expect(commitment === old.toString('hex')).toBe(false);
    } finally {
        old.fill(0);
    }
    for (const changed of [
        { ...scope, authorityId: 'different-authority' },
        { ...scope, authorityPublicKey: other.authority.publicKey },
        { ...scope, environmentId: 'different-environment' },
        { ...scope, enrollmentId: 'conn_' + 'b'.repeat(64) },
    ]) {
        using separate: JointWorkspaceCommitment = new JointWorkspaceCommitment(
            fixture.device,
            changed,
        );
        expect(separate.commitment(fixture.identity) === commitment).toBe(false);
    }
    using device: JointWorkspaceCommitment = new JointWorkspaceCommitment(other.device, {
        ...scope,
        devicePublicKey: other.device.publicKey,
    });
    expect(device.commitment(fixture.identity) === commitment).toBe(false);
    expect(owner.commitment({ ...fixture.identity, handle: 'f'.repeat(16) }) === commitment).toBe(
        false,
    );
    owner[Symbol.dispose]();
    expect((): string => owner.commitment(fixture.identity)).toThrow('closed');
});

it('binds every immutable field and fixed lane position while keeping randomized signature bytes outside binding identity', (): void => {
    using fixture: JointWorkspaceFixture = new JointWorkspaceFixture();
    const descriptor: JointWorkspaceDescriptor = JointWorkspaceAssembly.create(
        fixture.device,
        fixture.scope,
        1n,
        fixture.sources(),
    );
    const original: JointWorkspaceBinding = descriptor.binding;
    const hash: string = JointWorkspaceProof.bindingSha256(original);
    const changed: readonly JointWorkspaceBinding[] = [
        { ...original, authorityId: 'other-authority' },
        { ...original, environmentId: 'other-environment' },
        { ...original, enrollmentId: 'conn_' + 'b'.repeat(64) },
        { ...original, revision: 2n },
        { ...original, filePolicySha256: 'f'.repeat(64) },
        { ...original, executionPolicySha256: 'f'.repeat(64) },
        { ...original, fileRootId: 'other-file-root' },
        { ...original, executionRootId: 'other-execution-root' },
        { ...original, access: ConnectorFileMode.ReadOnly },
        { ...original, physicalRootCommitment: 'f'.repeat(64) },
        { ...original, fileJournalId: 'f'.repeat(64) },
        {
            ...original,
            executionJournals: { ...original.executionJournals, first: 'f'.repeat(64) },
        },
        {
            ...original,
            executionJournals: { ...original.executionJournals, second: 'f'.repeat(64) },
        },
        {
            ...original,
            executionJournals: {
                first: original.executionJournals.second,
                second: original.executionJournals.first,
            },
        },
    ];
    for (const binding of changed) {
        expect(
            JointWorkspaceProof.verify(SigningKey, fixture.expected, { ...descriptor, binding }),
        ).toBe(false);
        expect(JointWorkspaceProof.bindingSha256(binding) === hash).toBe(false);
    }
    const resigned: JointWorkspaceDescriptor = JointWorkspaceProof.sign(fixture.device, original);
    expect(JointWorkspaceProof.verify(SigningKey, fixture.expected, resigned)).toBe(true);
    expect(JointWorkspaceProof.bindingSha256(resigned.binding)).toBe(hash);
});

it('requires both signature components, a distinct purpose and the receiver-selected complete scope', (): void => {
    using fixture: JointWorkspaceFixture = new JointWorkspaceFixture();
    using other: JointWorkspaceFixture = new JointWorkspaceFixture();
    const descriptor: JointWorkspaceDescriptor = JointWorkspaceAssembly.create(
        fixture.device,
        fixture.scope,
        1n,
        fixture.sources(),
    );
    for (const index of [0, IdentityLengths.mlDsaSignature]) {
        const signature: Buffer = Buffer.from(descriptor.signature, 'base64url');
        const previous: number | undefined = signature[index];
        if (previous === undefined) {
            throw new Error('Composite test signature required');
        }
        signature[index] = previous ^ 1;
        expect(
            JointWorkspaceProof.verify(SigningKey, fixture.expected, {
                ...descriptor,
                signature: signature.toString('base64url'),
            }),
        ).toBe(false);
    }
    const signature: string = fixture.device.sign(
        SignaturePurpose.Inventory,
        JointWorkspaceProof.transcript(descriptor.binding),
    );
    expect(
        JointWorkspaceProof.verify(SigningKey, fixture.expected, { ...descriptor, signature }),
    ).toBe(false);
    const scopes: readonly JointWorkspaceScope[] = [
        { ...fixture.expected, authorityId: 'other-authority' },
        { ...fixture.expected, environmentId: 'other-environment' },
        { ...fixture.expected, enrollmentId: 'conn_' + 'b'.repeat(64) },
        { ...fixture.expected, devicePublicKey: other.device.publicKey },
    ];
    for (const scope of scopes) {
        expect(JointWorkspaceProof.verify(SigningKey, scope, descriptor)).toBe(false);
    }
});

it('requires an authenticated strictly newer revision within the expected scope, without pretending to persist a distributed watermark', (): void => {
    using fixture: JointWorkspaceFixture = new JointWorkspaceFixture();
    const first: JointWorkspaceDescriptor = JointWorkspaceAssembly.create(
        fixture.device,
        fixture.scope,
        9007199254740993n,
        fixture.sources(),
    );
    const next: JointWorkspaceDescriptor = JointWorkspaceProof.sign(fixture.device, {
        ...first.binding,
        revision: first.binding.revision + 1n,
    });
    expect(JointWorkspaceProof.supersedes(SigningKey, fixture.expected, first, next)).toBe(true);
    expect(JointWorkspaceProof.supersedes(SigningKey, fixture.expected, next, first)).toBe(false);
    expect(JointWorkspaceProof.supersedes(SigningKey, fixture.expected, first, first)).toBe(false);
    expect(
        JointWorkspaceProof.supersedes(SigningKey, fixture.expected, first, {
            ...next,
            signature: first.signature,
        }),
    ).toBe(false);
});

it('rejects ambiguous wire revisions, unknown fields and missing or aliased permanent lanes', (): void => {
    using fixture: JointWorkspaceFixture = new JointWorkspaceFixture();
    const descriptor: JointWorkspaceDescriptor = JointWorkspaceAssembly.create(
        fixture.device,
        fixture.scope,
        1n,
        fixture.sources(),
    );
    const parsed: unknown = JSON.parse(JointWorkspaceCodec.encode(descriptor.binding));
    const wire: Readonly<Record<string, unknown>> = Boundary.record(
        parsed,
        Object.keys(descriptor.binding),
    );
    const invalid: readonly Readonly<Record<string, unknown>>[] = [
        ...[0, 1, '0', '-1', '01', '1e1', '9223372036854775808'].map(
            (revision: string | number): Readonly<Record<string, unknown>> => ({
                ...wire,
                revision,
            }),
        ),
        { ...wire, extra: true },
        { ...wire, physicalRootCommitment: 'A'.repeat(64) },
        { ...wire, executionJournals: { first: 'd'.repeat(64) } },
        { ...wire, executionJournals: { first: 'd'.repeat(64), second: 'd'.repeat(64) } },
        { ...wire, executionJournals: { first: 'c'.repeat(64), second: 'e'.repeat(64) } },
        {
            ...wire,
            executionJournals: {
                first: 'd'.repeat(64),
                second: 'e'.repeat(64),
                third: 'f'.repeat(64),
            },
        },
    ];
    for (const value of invalid) {
        expect((): JointWorkspaceBinding => JointWorkspaceCodec.binding(value)).toThrow();
    }
    expect(JointWorkspaceCodec.binding({ ...wire, revision: '9223372036854775807' }).revision).toBe(
        9223372036854775807n,
    );
    expect((): JointWorkspaceDescriptor =>
        JointWorkspaceCodec.descriptor({
            binding: wire,
            signature: descriptor.signature,
            extra: true,
        }),
    ).toThrow();
});

it('bounds decoding and typed encoding before serializing unvalidated signature or body fields', (): void => {
    using fixture: JointWorkspaceFixture = new JointWorkspaceFixture();
    const descriptor: JointWorkspaceDescriptor = JointWorkspaceAssembly.create(
        fixture.device,
        fixture.scope,
        1n,
        fixture.sources(),
    );
    expect((): JointWorkspaceDescriptor => JointWorkspaceCodec.decode(' '.repeat(8193))).toThrow(
        'bound',
    );
    expect((): string =>
        JointWorkspaceCodec.encode({ ...descriptor, signature: 'a'.repeat(100000) }),
    ).toThrow();
    expect((): string =>
        JointWorkspaceCodec.encode({ ...descriptor.binding, fileRootId: 'a'.repeat(100000) }),
    ).toThrow();
    expect((): string =>
        JointWorkspaceCodec.encode({ ...descriptor.binding, revision: 0n }),
    ).toThrow();
    expect((): JointWorkspaceScope =>
        JointWorkspaceCodec.scope({
            ...fixture.expected,
            authorityPublicKey: fixture.authority.publicKey,
        }),
    ).toThrow();
});
