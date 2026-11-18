// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

import { createHash } from 'node:crypto';
import { expect, it } from 'vitest';
import {
    IdentityLengths,
    SignaturePurpose,
} from 'nerva-connector-protocol/identity/IdentityFormat.js';
import { ConnectorDeviceLimits } from 'nerva-connector-protocol/protocol/ConnectorDevice.js';
import { JointWorkspaceProof } from 'nerva-connector-protocol/workspace/JointWorkspaceProof.js';
import { JointWorkspacePublicationCodec } from 'nerva-connector-protocol/workspace/JointWorkspacePublicationCodec.js';
import { JointWorkspacePublicationProof } from 'nerva-connector-protocol/workspace/JointWorkspacePublicationProof.js';
import type { JointWorkspacePublication } from 'nerva-connector-protocol/workspace/JointWorkspacePublication.js';
import type {
    JointWorkspaceReceipt,
    JointWorkspaceReceiptBody,
    JointWorkspaceReceiptExpected,
} from 'nerva-connector-protocol/workspace/JointWorkspaceReceipt.js';
import { JointWorkspaceReceiptCodec } from 'nerva-connector-protocol/workspace/JointWorkspaceReceiptCodec.js';
import { JointWorkspaceReceiptProof } from 'nerva-connector-protocol/workspace/JointWorkspaceReceiptProof.js';
import { JointWorkspaceReceiptFixture } from './support/JointWorkspaceReceiptFixture.js';
import { SigningKey } from '../src/identity/SigningKey.js';

it('accepts only an authority-signed exact original publication receipt within the actual current lease', (): void => {
    using fixture: JointWorkspaceReceiptFixture = new JointWorkspaceReceiptFixture();
    const receipt: JointWorkspaceReceipt = JointWorkspaceReceiptProof.sign(
        fixture.authority,
        fixture.receiptBody,
    );
    expect(
        JointWorkspaceReceiptProof.verify(
            SigningKey,
            fixture.current,
            fixture.publication,
            receipt,
            fixture.nowMs,
        ),
    ).toBe(true);
    expect(Object.isFrozen(receipt)).toBe(true);
    expect(receipt.bindingRevision).toBe(9007199254740993n);
    expect(JointWorkspaceReceiptCodec.decode(JointWorkspaceReceiptCodec.encode(receipt))).toEqual(
        receipt,
    );
    expect(receipt.publicationSha256).toBe(
        createHash('sha256')
            .update(JointWorkspacePublicationCodec.encode(fixture.publication))
            .digest('hex'),
    );
    expect(
        JointWorkspaceReceiptProof.verify(
            SigningKey,
            fixture.current,
            fixture.publication,
            receipt,
            fixture.current.leaseExpiresAtMs - 1n,
        ),
    ).toBe(true);
});

it('requires both authority signature components, the pinned authority identity and the activation purpose', (): void => {
    using fixture: JointWorkspaceReceiptFixture = new JointWorkspaceReceiptFixture();
    using other: JointWorkspaceReceiptFixture = new JointWorkspaceReceiptFixture();
    const receipt: JointWorkspaceReceipt = JointWorkspaceReceiptProof.sign(
        fixture.authority,
        fixture.receiptBody,
    );
    for (const index of [0, IdentityLengths.mlDsaSignature]) {
        const signature: Buffer = Buffer.from(receipt.signature, 'base64url');
        const byte: number | undefined = signature[index];
        if (byte === undefined) {
            throw new Error('Composite authority proof requires both components');
        }
        signature[index] = byte ^ 1;
        expect(
            JointWorkspaceReceiptProof.verify(
                SigningKey,
                fixture.current,
                fixture.publication,
                { ...receipt, signature: signature.toString('base64url') },
                fixture.nowMs,
            ),
        ).toBe(false);
    }
    expect(
        JointWorkspaceReceiptProof.verify(
            SigningKey,
            fixture.current,
            fixture.publication,
            JointWorkspaceReceiptProof.sign(other.authority, fixture.receiptBody),
            fixture.nowMs,
        ),
    ).toBe(false);
    expect(
        JointWorkspaceReceiptProof.verify(
            SigningKey,
            { ...fixture.current, authorityPublicKey: other.authority.publicKey },
            fixture.publication,
            receipt,
            fixture.nowMs,
        ),
    ).toBe(false);
    expect(
        JointWorkspaceReceiptProof.verify(
            SigningKey,
            fixture.current,
            fixture.publication,
            {
                ...receipt,
                signature: fixture.authority.sign(
                    SignaturePurpose.JointWorkspacePublication,
                    JointWorkspaceReceiptProof.transcript(fixture.receiptBody),
                ),
            },
            fixture.nowMs,
        ),
    ).toBe(false);
});

it('rejects every foreign correlation even when a genuine authority signs the altered receipt', (): void => {
    using fixture: JointWorkspaceReceiptFixture = new JointWorkspaceReceiptFixture();
    const body: JointWorkspaceReceiptBody = fixture.receiptBody;
    const invalid: readonly JointWorkspaceReceiptBody[] = [
        { ...body, authorityId: 'foreign-authority' },
        { ...body, environmentId: 'foreign-environment' },
        { ...body, enrollmentId: 'conn_' + 'b'.repeat(64) },
        { ...body, leaseId: Buffer.alloc(32, 2).toString('base64url') },
        { ...body, bindingRevision: body.bindingRevision + 1n },
        { ...body, bindingSha256: 'f'.repeat(64) },
        { ...body, publicationSha256: 'f'.repeat(64) },
    ];
    for (const candidate of invalid) {
        const receipt: JointWorkspaceReceipt = JointWorkspaceReceiptProof.sign(
            fixture.authority,
            candidate,
        );
        expect(
            JointWorkspaceReceiptProof.verify(
                SigningKey,
                fixture.current,
                fixture.publication,
                receipt,
                fixture.nowMs,
            ),
        ).toBe(false);
    }
    const receipt: JointWorkspaceReceipt = JointWorkspaceReceiptProof.sign(fixture.authority, body);
    const invalidScope: readonly JointWorkspaceReceiptExpected[] = [
        { ...fixture.current, authorityId: 'foreign-authority' },
        { ...fixture.current, environmentId: 'foreign-environment' },
        { ...fixture.current, enrollmentId: 'conn_' + 'b'.repeat(64) },
        { ...fixture.current, leaseId: Buffer.alloc(32, 2).toString('base64url') },
        { ...fixture.current, slot: 1 },
    ];
    for (const expected of invalidScope) {
        expect(
            JointWorkspaceReceiptProof.verify(
                SigningKey,
                expected,
                fixture.publication,
                receipt,
                fixture.nowMs,
            ),
        ).toBe(false);
    }
});

it('commits both exact randomized device signatures while preserving the stable descriptor-body hash', (): void => {
    using fixture: JointWorkspaceReceiptFixture = new JointWorkspaceReceiptFixture();
    const receipt: JointWorkspaceReceipt = JointWorkspaceReceiptProof.sign(
        fixture.authority,
        fixture.receiptBody,
    );
    const resigned: JointWorkspacePublication = JointWorkspacePublicationProof.sign(
        SigningKey,
        fixture.device,
        {
            enrollmentId: fixture.publication.enrollmentId,
            slot: 0,
            leaseId: fixture.publication.leaseId,
            descriptor: fixture.publication.descriptor,
        },
    );
    const descriptorResigned: JointWorkspacePublication = {
        ...fixture.publication,
        descriptor: JointWorkspaceProof.sign(
            fixture.device,
            fixture.publication.descriptor.binding,
        ),
    };
    for (const candidate of [resigned, descriptorResigned]) {
        expect(JointWorkspaceProof.bindingSha256(candidate.descriptor.binding)).toBe(
            receipt.bindingSha256,
        );
        expect(JointWorkspaceReceiptProof.publicationSha256(candidate)).not.toBe(
            receipt.publicationSha256,
        );
        expect(
            JointWorkspaceReceiptProof.verify(
                SigningKey,
                fixture.current,
                candidate,
                receipt,
                fixture.nowMs,
            ),
        ).toBe(false);
        const nextReceipt: JointWorkspaceReceipt = JointWorkspaceReceiptProof.sign(
            fixture.authority,
            {
                ...fixture.receiptBody,
                publicationSha256: JointWorkspaceReceiptProof.publicationSha256(candidate),
            },
        );
        expect(
            JointWorkspaceReceiptProof.verify(
                SigningKey,
                fixture.current,
                candidate,
                nextReceipt,
                fixture.nowMs,
            ),
        ).toBe(true);
    }
});

it('never accepts unsigned or invalid device publication merely because an authority receipt names its bytes', (): void => {
    using fixture: JointWorkspaceReceiptFixture = new JointWorkspaceReceiptFixture();
    using other: JointWorkspaceReceiptFixture = new JointWorkspaceReceiptFixture();
    const candidate: JointWorkspacePublication = {
        ...fixture.publication,
        signature: other.publication.signature,
    };
    const receipt: JointWorkspaceReceipt = JointWorkspaceReceiptProof.sign(fixture.authority, {
        ...fixture.receiptBody,
        publicationSha256: JointWorkspaceReceiptProof.publicationSha256(candidate),
    });
    expect(
        JointWorkspaceReceiptProof.verify(
            SigningKey,
            fixture.current,
            candidate,
            receipt,
            fixture.nowMs,
        ),
    ).toBe(false);
    expect(
        JointWorkspaceReceiptProof.verify(
            SigningKey,
            { ...fixture.current, devicePublicKey: other.device.publicKey },
            fixture.publication,
            receipt,
            fixture.nowMs,
        ),
    ).toBe(false);
});

it('enforces finite clock lead, actual lease issuance and expiration without fabricated ready fallbacks', (): void => {
    using fixture: JointWorkspaceReceiptFixture = new JointWorkspaceReceiptFixture();
    const valid: JointWorkspaceReceipt = JointWorkspaceReceiptProof.sign(
        fixture.authority,
        fixture.receiptBody,
    );
    for (const issuedAtMs of [
        fixture.current.leaseIssuedAtMs - 1n,
        fixture.current.leaseExpiresAtMs,
        fixture.nowMs + ConnectorDeviceLimits.clockLeadMs + 1n,
    ]) {
        const receipt: JointWorkspaceReceipt = JointWorkspaceReceiptProof.sign(fixture.authority, {
            ...fixture.receiptBody,
            issuedAtMs,
        });
        expect(
            JointWorkspaceReceiptProof.verify(
                SigningKey,
                fixture.current,
                fixture.publication,
                receipt,
                fixture.nowMs,
            ),
        ).toBe(false);
    }
    const lead: JointWorkspaceReceipt = JointWorkspaceReceiptProof.sign(fixture.authority, {
        ...fixture.receiptBody,
        issuedAtMs: fixture.nowMs + ConnectorDeviceLimits.clockLeadMs,
    });
    expect(
        JointWorkspaceReceiptProof.verify(
            SigningKey,
            fixture.current,
            fixture.publication,
            lead,
            fixture.nowMs,
        ),
    ).toBe(true);
    expect(
        JointWorkspaceReceiptProof.verify(
            SigningKey,
            fixture.current,
            fixture.publication,
            valid,
            fixture.current.leaseExpiresAtMs,
        ),
    ).toBe(false);
    expect(
        JointWorkspaceReceiptProof.verify(
            SigningKey,
            fixture.current,
            fixture.publication,
            valid,
            -1n,
        ),
    ).toBe(false);
    expect(
        JointWorkspaceReceiptProof.verify(
            SigningKey,
            { ...fixture.current, leaseExpiresAtMs: fixture.current.leaseIssuedAtMs },
            fixture.publication,
            valid,
            fixture.nowMs,
        ),
    ).toBe(false);
});

it('strictly rejects unsigned, malformed, imprecise and oversized receipt envelopes', (): void => {
    using fixture: JointWorkspaceReceiptFixture = new JointWorkspaceReceiptFixture();
    const receipt: JointWorkspaceReceipt = JointWorkspaceReceiptProof.sign(
        fixture.authority,
        fixture.receiptBody,
    );
    const raw: unknown = JSON.parse(JointWorkspaceReceiptCodec.encode(receipt));
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
        throw new Error('Receipt fixture must serialize as a record');
    }
    for (const candidate of [
        { ...raw, signature: undefined },
        { ...raw, ready: true },
        { ...raw, slot: 1 },
        { ...raw, bindingRevision: '0' },
        { ...raw, bindingRevision: 9007199254740992 },
        { ...raw, issuedAtMs: '01' },
        { ...raw, issuedAtMs: '9223372036854775808' },
    ]) {
        expect((): JointWorkspaceReceipt =>
            JointWorkspaceReceiptCodec.receipt(candidate),
        ).toThrow();
    }
    expect((): JointWorkspaceReceipt =>
        JointWorkspaceReceiptCodec.decode(' '.repeat(8193)),
    ).toThrow('bound');
    expect((): string =>
        JointWorkspaceReceiptCodec.encode({ ...receipt, signature: 'a'.repeat(100000) }),
    ).toThrow();
});

it('bundles receipt decoding and exact encoding in a browser with no Node globals', async (): Promise<void> => {
    const bundler: typeof import('rolldown') = await import('rolldown');
    const vm: typeof import('node:vm') = await import('node:vm');
    using fixture: JointWorkspaceReceiptFixture = new JointWorkspaceReceiptFixture();
    const input: string = JointWorkspaceReceiptCodec.encode(
        JointWorkspaceReceiptProof.sign(fixture.authority, fixture.receiptBody),
    );
    const bundle: import('rolldown').RolldownBuild = await bundler.rolldown({
        input: 'node_modules/nerva-connector-protocol/dist/workspace/JointWorkspaceReceiptCodec.js',
        platform: 'browser',
    });
    try {
        const result: Awaited<ReturnType<import('rolldown').RolldownBuild['generate']>> =
            await bundle.generate({
                format: 'iife',
                name: 'BrowserReceipt',
                codeSplitting: false,
                minify: true,
                sourcemap: false,
            });
        const chunk: import('rolldown').OutputChunk | import('rolldown').OutputAsset | undefined =
            result.output[0];
        if (result.output.length !== 1 || chunk === undefined || chunk.type !== 'chunk') {
            throw new Error('One bounded browser receipt codec bundle required');
        }
        expect(chunk.imports).toEqual([]);
        expect(Buffer.byteLength(chunk.code)).toBeLessThan(32768);
        const context: import('node:vm').Context = vm.createContext({
            TextEncoder,
            atob,
            btoa,
            input,
        });
        const resultText: unknown = vm.runInContext(
            chunk.code +
                '; if(typeof Buffer!=="undefined"||typeof process!=="undefined"){throw new Error("Unexpected Node globals");} BrowserReceipt.JointWorkspaceReceiptCodec.encode(BrowserReceipt.JointWorkspaceReceiptCodec.decode(input));',
            context,
            { timeout: 1000 },
        );
        expect(resultText).toBe(input);
    } finally {
        await bundle.close();
    }
});
