// SPDX-FileCopyrightText: 2026 Dacely <business@dacely.com>
// SPDX-License-Identifier: LicenseRef-Proprietary

import { expect, it } from 'vitest';
import {
    IdentityLengths,
    SignaturePurpose,
} from 'nerva-connector-protocol/identity/IdentityFormat.js';
import { JointWorkspaceRetryCodec } from 'nerva-connector-protocol/workspace/JointWorkspaceRetryCodec.js';
import { JointWorkspaceRetryProof } from 'nerva-connector-protocol/workspace/JointWorkspaceRetryProof.js';
import {
    JointWorkspaceRetryReason,
    JointWorkspaceRetryLimits,
    type JointWorkspaceRetry,
    type JointWorkspaceRetryBody,
} from 'nerva-connector-protocol/workspace/JointWorkspaceRetry.js';
import { JointWorkspaceReceiptProof } from 'nerva-connector-protocol/workspace/JointWorkspaceReceiptProof.js';
import { JointWorkspacePublicationProof } from 'nerva-connector-protocol/workspace/JointWorkspacePublicationProof.js';
import type { JointWorkspacePublication } from 'nerva-connector-protocol/workspace/JointWorkspacePublication.js';
import { ConnectorTransportCodec, ConnectorFrameKind } from '../src/protocol/ConnectorTransport.js';
import { JointWorkspaceReceiptFixture } from './support/JointWorkspaceReceiptFixture.js';
import { SigningKey } from '../src/identity/SigningKey.js';

/** Synthetic public lease data tests proofs and codecs only, not device physical-root evidence. */
function body(fixture: JointWorkspaceReceiptFixture): JointWorkspaceRetryBody {
    return {
        ...fixture.receiptBody,
        reason: JointWorkspaceRetryReason.ProfilesPending,
        retryAfterMs: JointWorkspaceRetryLimits.retryAfterMs,
    };
}

it('verifies a fixed signed delay for one exact publication without producing activation', (): void => {
    using fixture: JointWorkspaceReceiptFixture = new JointWorkspaceReceiptFixture();
    const retry: JointWorkspaceRetry = JointWorkspaceRetryProof.sign(
        fixture.authority,
        body(fixture),
    );
    expect(
        JointWorkspaceRetryProof.verify(
            SigningKey,
            fixture.current,
            fixture.publication,
            retry,
            fixture.nowMs,
        ),
    ).toBe(true);
    expect(retry.bindingRevision).toBe(9007199254740993n);
    expect(JointWorkspaceRetryCodec.decode(JointWorkspaceRetryCodec.encode(retry))).toEqual(retry);
    expect(
        ConnectorTransportCodec.server(
            ConnectorTransportCodec.encode({ kind: ConnectorFrameKind.JointWorkspaceRetry, retry }),
        ),
    ).toEqual({ kind: ConnectorFrameKind.JointWorkspaceRetry, retry });
});

it('requires both components and a retry purpose distinct from activation', (): void => {
    using fixture: JointWorkspaceReceiptFixture = new JointWorkspaceReceiptFixture();
    const retry: JointWorkspaceRetry = JointWorkspaceRetryProof.sign(
        fixture.authority,
        body(fixture),
    );
    for (const offset of [0, IdentityLengths.mlDsaSignature]) {
        const signature: Buffer = Buffer.from(retry.signature, 'base64url');
        signature[offset] = (signature[offset] ?? 0) ^ 1;
        expect(
            JointWorkspaceRetryProof.verify(
                SigningKey,
                fixture.current,
                fixture.publication,
                { ...retry, signature: signature.toString('base64url') },
                fixture.nowMs,
            ),
        ).toBe(false);
    }
    expect(
        JointWorkspaceRetryProof.verify(
            SigningKey,
            fixture.current,
            fixture.publication,
            {
                ...retry,
                signature: fixture.authority.sign(
                    SignaturePurpose.JointWorkspaceActivated,
                    JointWorkspaceRetryProof.transcript(body(fixture)),
                ),
            },
            fixture.nowMs,
        ),
    ).toBe(false);
    expect(
        JointWorkspaceReceiptProof.verify(
            SigningKey,
            fixture.current,
            fixture.publication,
            { ...fixture.receiptBody, signature: retry.signature },
            fixture.nowMs,
        ),
    ).toBe(false);
});

it('rejects changed full publication signatures, stale leases, delay tampering and scope substitution', (): void => {
    using fixture: JointWorkspaceReceiptFixture = new JointWorkspaceReceiptFixture();
    const retry: JointWorkspaceRetry = JointWorkspaceRetryProof.sign(
        fixture.authority,
        body(fixture),
    );
    const replacement: JointWorkspacePublication = JointWorkspacePublicationProof.sign(
        SigningKey,
        fixture.device,
        {
            enrollmentId: fixture.publication.enrollmentId,
            slot: 0,
            leaseId: fixture.publication.leaseId,
            descriptor: fixture.publication.descriptor,
        },
    );
    expect(replacement.signature).not.toBe(fixture.publication.signature);
    expect(
        JointWorkspaceRetryProof.verify(
            SigningKey,
            fixture.current,
            replacement,
            retry,
            fixture.nowMs,
        ),
    ).toBe(false);
    expect(
        JointWorkspaceRetryProof.verify(
            SigningKey,
            fixture.current,
            fixture.publication,
            retry,
            fixture.current.leaseExpiresAtMs,
        ),
    ).toBe(false);
    expect(
        JointWorkspaceRetryProof.verify(
            SigningKey,
            { ...fixture.current, leaseId: Buffer.alloc(32, 9).toString('base64url') },
            fixture.publication,
            retry,
            fixture.nowMs,
        ),
    ).toBe(false);
    expect(
        JointWorkspaceRetryProof.verify(
            SigningKey,
            { ...fixture.current, environmentId: 'different-environment' },
            fixture.publication,
            retry,
            fixture.nowMs,
        ),
    ).toBe(false);
    expect(
        JointWorkspaceRetryProof.verify(
            SigningKey,
            fixture.current,
            fixture.publication,
            { ...retry, retryAfterMs: 0 },
            fixture.nowMs,
        ),
    ).toBe(false);
    expect(
        JointWorkspaceRetryProof.verify(
            SigningKey,
            fixture.current,
            fixture.publication,
            { ...retry, reason: JointWorkspaceRetryReason.OriginalPending },
            fixture.nowMs,
        ),
    ).toBe(false);
});

it('rejects oversized, unknown, mixed and incomplete outcomes before proof work', (): void => {
    expect(() =>
        JointWorkspaceRetryCodec.decode(' '.repeat(JointWorkspaceRetryLimits.envelopeBytes + 1)),
    ).toThrow();
    expect(() => JointWorkspaceRetryCodec.retry({})).toThrow();
});
