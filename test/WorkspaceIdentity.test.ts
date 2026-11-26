// SPDX-FileCopyrightText: 2026 Dacely <business@dacely.com>
// SPDX-License-Identifier: LicenseRef-Proprietary

import { expect, it } from 'vitest';
import { SigningKey } from '../src/identity/SigningKey.js';
import { WorkspaceIdentityCodec } from '../src/workspace/WorkspaceIdentityCodec.js';
import {
    WorkspaceIdentityFailure,
    type WorkspaceIdentityResult,
    type WorkspaceIdentity,
} from '../src/workspace/WorkspaceIdentity.js';
import {
    WorkspaceCommitment,
    type WorkspaceIdentityBinding,
} from '../src/workspace/WorkspaceCommitment.js';

/** Native wire integers are decimal strings, including values above JavaScript's safe integer range. */
interface WireIdentity {
    readonly filesystemUuid: string;
    readonly device: string;
    readonly inode: string;
    readonly handleType: number;
    readonly handle: string;
}

const wire: WireIdentity = {
    filesystemUuid: 'a'.repeat(32),
    device: '9007199254740993',
    inode: '18446744073709551615',
    handleType: 1,
    handle: '1234567800000000',
};

/** Synthetic native identities never use real host metadata in assertion output. */
function identity(value: WireIdentity = wire): WorkspaceIdentity {
    const result: WorkspaceIdentityResult = WorkspaceIdentityCodec.result({
        ok: true,
        identity: value,
    });
    if (!result.ok) {
        throw new Error('Synthetic identity fixture required');
    }
    return result.identity;
}

/** Only public scope identifiers enter the derivation salt. */
function binding(authority: SigningKey): WorkspaceIdentityBinding {
    return {
        authorityId: 'authority',
        authorityPublicKey: authority.publicKey,
        enrollmentId: 'conn_' + 'a'.repeat(64),
        environmentId: 'environment',
    };
}

it('decodes exact uint64 identity and permits a zero generation without rounding or mutable records', (): void => {
    const result: WorkspaceIdentity = identity();
    expect(result.device).toBe(9007199254740993n);
    expect(result.inode).toBe(18446744073709551615n);
    expect(result.handle).toBe('1234567800000000');
    expect(Object.isFrozen(result)).toBe(true);
});

it('rejects incomplete, noncanonical, zero, overflowing and extra native identity fields', (): void => {
    const invalid: readonly unknown[] = [
        null,
        [],
        {},
        { ok: true },
        { ok: 1, identity: wire },
        { ok: true, identity: wire, path: '/host-private' },
        ...[
            { ...wire, filesystemUuid: '0'.repeat(32) },
            { ...wire, filesystemUuid: 'A'.repeat(32) },
            { ...wire, inode: '0' },
            { ...wire, inode: '01' },
            { ...wire, inode: '-1' },
            { ...wire, device: '18446744073709551616' },
            { ...wire, device: 9007199254740992 },
            { ...wire, device: '1\n' },
            { ...wire, handle: 'a'.repeat(15) },
            { ...wire, handleType: 2 },
            { ...wire, handle: 'A'.repeat(16) },
            { ...wire, root: 4 },
            {
                filesystemUuid: wire.filesystemUuid,
                device: wire.device,
                inode: wire.inode,
                handleType: 1,
            },
        ].map((value: Readonly<Record<string, string | number>>): unknown => ({
            ok: true,
            identity: value,
        })),
    ];
    for (const value of invalid) {
        expect((): WorkspaceIdentityResult => WorkspaceIdentityCodec.result(value)).toThrow();
    }
});

it('keeps unsupported separate from changed, invalid and unavailable and rejects mixed envelopes', (): void => {
    for (const error of Object.values(WorkspaceIdentityFailure)) {
        expect(WorkspaceIdentityCodec.result({ ok: false, error })).toEqual({ ok: false, error });
    }
    for (const value of [
        { ok: false },
        { ok: false, error: 'compatible' },
        { ok: false, error: 'unsupported', identity: wire },
        { ok: true, error: 'unsupported', identity: wire },
    ]) {
        expect((): WorkspaceIdentityResult => WorkspaceIdentityCodec.result(value)).toThrow();
    }
});

it('partitions opaque commitments by both device secrets and every actual authority/enrollment/environment binding', (): void => {
    using key: SigningKey = SigningKey.generate();
    using otherKey: SigningKey = SigningKey.generate();
    using authority: SigningKey = SigningKey.generate();
    using otherAuthority: SigningKey = SigningKey.generate();
    const scope: WorkspaceIdentityBinding = binding(authority);
    using original: WorkspaceCommitment = new WorkspaceCommitment(key, scope);
    const expected: Buffer = original.commitment(identity());
    try {
        using same: WorkspaceCommitment = new WorkspaceCommitment(key, scope);
        const repeated: Buffer = same.commitment(identity());
        try {
            expect(repeated.equals(expected)).toBe(true);
        } finally {
            repeated.fill(0);
        }
        const scopes: readonly WorkspaceIdentityBinding[] = [
            { ...scope, authorityId: 'other-authority' },
            { ...scope, authorityPublicKey: otherAuthority.publicKey },
            { ...scope, enrollmentId: 'conn_' + 'b'.repeat(64) },
            { ...scope, environmentId: 'other-environment' },
        ];
        for (const value of scopes) {
            using owner: WorkspaceCommitment = new WorkspaceCommitment(key, value);
            const changed: Buffer = owner.commitment(identity());
            try {
                expect(changed.equals(expected)).toBe(false);
            } finally {
                changed.fill(0);
            }
        }
        using other: WorkspaceCommitment = new WorkspaceCommitment(otherKey, scope);
        const changed: Buffer = other.commitment(identity());
        try {
            expect(changed.equals(expected)).toBe(false);
        } finally {
            changed.fill(0);
        }
    } finally {
        expected.fill(0);
    }
});

it('changes commitments for changed filesystem, mount device, inode or generation while refusing use after disposal', (): void => {
    using key: SigningKey = SigningKey.generate();
    using authority: SigningKey = SigningKey.generate();
    const owner: WorkspaceCommitment = new WorkspaceCommitment(key, binding(authority));
    const expected: Buffer = owner.commitment(identity());
    try {
        for (const value of [
            { ...wire, filesystemUuid: 'b'.repeat(32) },
            { ...wire, device: '9007199254740994' },
            { ...wire, inode: '18446744073709551614' },
            { ...wire, handle: '1234567800000001' },
        ]) {
            const changed: Buffer = owner.commitment(identity(value));
            try {
                expect(changed.equals(expected)).toBe(false);
            } finally {
                changed.fill(0);
            }
        }
    } finally {
        expected.fill(0);
        owner[Symbol.dispose]();
    }
    expect((): Buffer => owner.commitment(identity())).toThrow('closed');
});
