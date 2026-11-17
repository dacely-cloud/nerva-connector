// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

import { expect, it } from 'vitest';
import { JointWorkspaceFixture } from './support/JointWorkspaceFixture.js';
import { JointWorkspaceAssembly } from '../src/workspace/JointWorkspaceAssembly.js';
import { JointWorkspaceProof } from '../src/workspace/JointWorkspaceProof.js';
import { JointWorkspacePublicationCodec } from 'nerva-connector-protocol/workspace/JointWorkspacePublicationCodec.js';
import { JointWorkspacePublicationProof } from '../src/workspace/JointWorkspacePublicationProof.js';
import type { JointWorkspaceDescriptor } from 'nerva-connector-protocol/workspace/JointWorkspaceBinding.js';
import type {
    JointWorkspacePublication,
    JointWorkspacePublicationBody,
    JointWorkspacePublicationExpected,
} from 'nerva-connector-protocol/workspace/JointWorkspacePublication.js';
import {
    IdentityLengths,
    SignaturePurpose,
} from 'nerva-connector-protocol/identity/IdentityFormat.js';

/** Canonical generated-lease test data is public and never used for device authentication. */
class PublicationFixture extends JointWorkspaceFixture {
    public readonly leaseId: string = Buffer.alloc(32, 1).toString('base64url');
    public readonly replacementLeaseId: string = Buffer.alloc(32, 2).toString('base64url');
    public readonly descriptor: JointWorkspaceDescriptor = JointWorkspaceAssembly.create(
        this.device,
        this.scope,
        9007199254740993n,
        this.sources(),
    );

    public get body(): JointWorkspacePublicationBody {
        return {
            enrollmentId: this.expected.enrollmentId,
            slot: 0,
            leaseId: this.leaseId,
            descriptor: this.descriptor,
        };
    }

    public get current(): JointWorkspacePublicationExpected {
        return { ...this.expected, slot: 0, leaseId: this.leaseId };
    }
}

it('publishes both proofs on the current primary lease while retaining an immutable lease-independent binding', (): void => {
    using fixture: PublicationFixture = new PublicationFixture();
    const publication: JointWorkspacePublication = JointWorkspacePublicationProof.sign(
        fixture.device,
        fixture.body,
    );
    expect(JointWorkspacePublicationProof.verify(fixture.current, publication)).toBe(true);
    expect(
        JointWorkspacePublicationCodec.decode(JointWorkspacePublicationCodec.encode(publication)),
    ).toEqual(publication);
    expect(publication.descriptor.binding.revision).toBe(9007199254740993n);
    expect(Object.isFrozen(publication)).toBe(true);
    expect(Object.isFrozen(publication.descriptor.binding.executionJournals)).toBe(true);
    const replacement: JointWorkspacePublication = JointWorkspacePublicationProof.sign(
        fixture.device,
        { ...fixture.body, leaseId: fixture.replacementLeaseId },
    );
    expect(
        JointWorkspacePublicationProof.verify(
            { ...fixture.current, leaseId: fixture.replacementLeaseId },
            replacement,
        ),
    ).toBe(true);
    expect(JointWorkspaceProof.bindingSha256(replacement.descriptor.binding)).toBe(
        JointWorkspaceProof.bindingSha256(publication.descriptor.binding),
    );
    expect(replacement.descriptor).toEqual(publication.descriptor);
    expect(
        JointWorkspacePublicationProof.transcript(fixture.body).equals(
            JointWorkspacePublicationProof.transcript({
                ...fixture.body,
                leaseId: fixture.replacementLeaseId,
            }),
        ),
    ).toBe(false);
});

it('rejects replay into replacement lease, another connection slot or foreign deployment/enrollment/device scope', (): void => {
    using fixture: PublicationFixture = new PublicationFixture();
    using other: JointWorkspaceFixture = new JointWorkspaceFixture();
    const publication: JointWorkspacePublication = JointWorkspacePublicationProof.sign(
        fixture.device,
        fixture.body,
    );
    const invalid: readonly JointWorkspacePublicationExpected[] = [
        { ...fixture.current, leaseId: fixture.replacementLeaseId },
        { ...fixture.current, slot: 1 },
        { ...fixture.current, authorityId: 'foreign-authority' },
        { ...fixture.current, environmentId: 'foreign-environment' },
        { ...fixture.current, enrollmentId: 'conn_' + 'b'.repeat(64) },
        { ...fixture.current, devicePublicKey: other.device.publicKey },
    ];
    for (const current of invalid) {
        expect(JointWorkspacePublicationProof.verify(current, publication)).toBe(false);
    }
    expect(
        JointWorkspacePublicationProof.verify(fixture.current, {
            ...publication,
            leaseId: fixture.replacementLeaseId,
        }),
    ).toBe(false);
    expect(
        JointWorkspacePublicationProof.verify(fixture.current, {
            ...publication,
            enrollmentId: 'conn_' + 'b'.repeat(64),
        }),
    ).toBe(false);
});

it('requires both composite proof components on both the descriptor and its distinct-purpose publication', (): void => {
    using fixture: PublicationFixture = new PublicationFixture();
    const publication: JointWorkspacePublication = JointWorkspacePublicationProof.sign(
        fixture.device,
        fixture.body,
    );
    for (const index of [0, IdentityLengths.mlDsaSignature]) {
        for (const envelope of [false, true]) {
            const signature: Buffer = Buffer.from(
                envelope ? publication.signature : publication.descriptor.signature,
                'base64url',
            );
            const byte: number | undefined = signature[index];
            if (byte === undefined) {
                throw new Error('Composite proof test requires both signature components');
            }
            signature[index] = byte ^ 1;
            const changed: JointWorkspacePublication = envelope
                ? { ...publication, signature: signature.toString('base64url') }
                : {
                      ...publication,
                      descriptor: {
                          ...publication.descriptor,
                          signature: signature.toString('base64url'),
                      },
                  };
            expect(JointWorkspacePublicationProof.verify(fixture.current, changed)).toBe(false);
        }
    }
    expect(
        JointWorkspacePublicationProof.verify(fixture.current, {
            ...publication,
            signature: fixture.device.sign(
                SignaturePurpose.JointWorkspaceBinding,
                JointWorkspacePublicationProof.transcript(fixture.body),
            ),
        }),
    ).toBe(false);
    expect(
        JointWorkspacePublicationProof.verify(fixture.current, {
            ...publication,
            descriptor: {
                ...publication.descriptor,
                signature: fixture.device.sign(
                    SignaturePurpose.JointWorkspacePublication,
                    JointWorkspaceProof.transcript(publication.descriptor.binding),
                ),
            },
        }),
    ).toBe(false);
});

it('rejects descriptor substitution even when the substituted descriptor has a valid device signature', (): void => {
    using fixture: PublicationFixture = new PublicationFixture();
    using other: JointWorkspaceFixture = new JointWorkspaceFixture();
    const publication: JointWorkspacePublication = JointWorkspacePublicationProof.sign(
        fixture.device,
        fixture.body,
    );
    const replacement: JointWorkspaceDescriptor = JointWorkspaceProof.sign(fixture.device, {
        ...fixture.descriptor.binding,
        revision: fixture.descriptor.binding.revision + 1n,
    });
    expect(JointWorkspaceProof.verify(fixture.expected, replacement)).toBe(true);
    expect(
        JointWorkspacePublicationProof.verify(fixture.current, {
            ...publication,
            descriptor: replacement,
        }),
    ).toBe(false);
    expect((): JointWorkspacePublication =>
        JointWorkspacePublicationProof.sign(other.device, fixture.body),
    ).toThrow('device');
    expect((): JointWorkspacePublication =>
        JointWorkspacePublicationProof.sign(fixture.device, {
            ...fixture.body,
            descriptor: { ...replacement, signature: fixture.descriptor.signature },
        }),
    ).toThrow('device');
    const resigned: JointWorkspaceDescriptor = JointWorkspaceProof.sign(
        fixture.device,
        fixture.descriptor.binding,
    );
    expect(
        JointWorkspacePublicationProof.verify(fixture.current, {
            ...publication,
            descriptor: resigned,
        }),
    ).toBe(true);
});

it('refuses malformed, extra, unsupported and oversized envelopes before proof verification', (): void => {
    using fixture: PublicationFixture = new PublicationFixture();
    const publication: JointWorkspacePublication = JointWorkspacePublicationProof.sign(
        fixture.device,
        fixture.body,
    );
    const parsed: unknown = JSON.parse(JointWorkspacePublicationCodec.encode(publication));
    expect((): JointWorkspacePublication =>
        JointWorkspacePublicationCodec.publication({ ...publication }),
    ).toThrow();
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        throw new Error('Serialized fixture must be a record');
    }
    const invalid: readonly Readonly<Record<string, unknown>>[] = [
        { ...parsed, extra: true },
        { ...parsed, slot: 1 },
        { ...parsed, slot: '0' },
        { ...parsed, leaseId: '' },
        { ...parsed, leaseId: fixture.leaseId + '=' },
        { ...parsed, enrollmentId: 'conn_' + 'b'.repeat(64) },
        { ...parsed, descriptor: null },
        { ...parsed, signature: publication.signature.slice(1) },
    ];
    for (const value of invalid) {
        expect((): JointWorkspacePublication =>
            JointWorkspacePublicationCodec.publication(value),
        ).toThrow();
    }
    expect((): JointWorkspacePublication =>
        JointWorkspacePublicationCodec.decode(' '.repeat(16385)),
    ).toThrow('bound');
    expect((): string =>
        JointWorkspacePublicationCodec.encode({ ...publication, signature: 'a'.repeat(100000) }),
    ).toThrow();
    expect((): JointWorkspacePublicationExpected =>
        JointWorkspacePublicationCodec.expected({
            ...fixture.current,
            authorityPublicKey: fixture.authority.publicKey,
        }),
    ).toThrow();
});

it('bundles and round-trips the publication codec without Node or Buffer globals', async (): Promise<void> => {
    const bundler: typeof import('rolldown') = await import('rolldown');
    const vm: typeof import('node:vm') = await import('node:vm');
    using fixture: PublicationFixture = new PublicationFixture();
    const input: string = JointWorkspacePublicationCodec.encode(
        JointWorkspacePublicationProof.sign(fixture.device, fixture.body),
    );
    const bundle: import('rolldown').RolldownBuild = await bundler.rolldown({
        input: 'node_modules/nerva-connector-protocol/dist/workspace/JointWorkspacePublicationCodec.js',
        platform: 'browser',
    });
    try {
        const result: Awaited<ReturnType<import('rolldown').RolldownBuild['generate']>> =
            await bundle.generate({
                format: 'iife',
                name: 'BrowserPublication',
                codeSplitting: false,
                minify: true,
                sourcemap: false,
            });
        const chunk: import('rolldown').OutputChunk | import('rolldown').OutputAsset | undefined =
            result.output[0];
        if (result.output.length !== 1 || chunk === undefined || chunk.type !== 'chunk') {
            throw new Error('One bounded browser publication codec bundle required');
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
                '; if(typeof Buffer!=="undefined"||typeof process!=="undefined"){throw new Error("Unexpected Node globals");} BrowserPublication.JointWorkspacePublicationCodec.encode(BrowserPublication.JointWorkspacePublicationCodec.decode(input));',
            context,
            { timeout: 1000 },
        );
        expect(output).toBe(input);
    } finally {
        await bundle.close();
    }
});
