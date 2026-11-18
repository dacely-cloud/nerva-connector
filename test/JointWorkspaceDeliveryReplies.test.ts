// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { SigningKey } from '../src/identity/SigningKey.js';
import {
    IdentityLengths,
    SignaturePurpose,
} from 'nerva-connector-protocol/identity/IdentityFormat.js';
import { ConnectorFrameKind } from '../src/protocol/ConnectorTransport.js';
import { JointWorkspaceReceiptProof } from 'nerva-connector-protocol/workspace/JointWorkspaceReceiptProof.js';
import type {
    JointWorkspaceReceipt,
    JointWorkspaceReceiptBody,
} from 'nerva-connector-protocol/workspace/JointWorkspaceReceipt.js';
import { JointWorkspaceRetryProof } from 'nerva-connector-protocol/workspace/JointWorkspaceRetryProof.js';
import {
    JointWorkspaceRetryReason,
    JointWorkspaceRetryLimits,
    type JointWorkspaceRetry,
    type JointWorkspaceRetryBody,
} from 'nerva-connector-protocol/workspace/JointWorkspaceRetry.js';
import type { ExecutionDeliveryLink } from '../src/execution/ExecutionDeliveryLink.js';
import {
    JointWorkspaceDeliveryFixture,
    type JointWorkspaceDeliverySent,
} from './support/JointWorkspaceDeliveryFixture.js';

enum ReceiptFault {
    PostQuantum = 'post-quantum-component',
    Classical = 'classical-component',
    Purpose = 'wrong-purpose',
    Authority = 'foreign-authority-key',
    Lease = 'stale-lease',
    Publication = 'different-exact-publication',
}

/** Mutation keeps canonical component lengths so the actual cryptographic verification must reject it. */
class DeliverySignatureFault {
    public static mutate(signature: string, index: number): string {
        const bytes: Buffer = Buffer.from(signature, 'base64url');
        const byte: number | undefined = bytes[index];
        if (byte === undefined) {
            throw new Error('Both real signature components required');
        }
        bytes[index] = byte ^ 1;
        return bytes.toString('base64url');
    }
}

it.each(Object.values(ReceiptFault))(
    'an activation reply with %s closes its link without writing or fabricating acceptance',
    async (fault: ReceiptFault): Promise<void> => {
        await using fixture: JointWorkspaceDeliveryFixture =
            await JointWorkspaceDeliveryFixture.create();
        using foreign: SigningKey = SigningKey.generate();
        const link: ExecutionDeliveryLink = fixture.link();
        fixture.activate(link);
        const sent: JointWorkspaceDeliverySent = await fixture.sent();
        const before: Buffer = await readFile(join(fixture.source.directory, 'workspace-head'));
        const body: JointWorkspaceReceiptBody = fixture.receiptBody(sent);
        let receipt: JointWorkspaceReceipt = fixture.receipt(sent);
        if (fault === ReceiptFault.PostQuantum || fault === ReceiptFault.Classical) {
            receipt = {
                ...receipt,
                signature: DeliverySignatureFault.mutate(
                    receipt.signature,
                    fault === ReceiptFault.PostQuantum ? 0 : IdentityLengths.mlDsaSignature,
                ),
            };
        } else if (fault === ReceiptFault.Purpose) {
            receipt = {
                ...receipt,
                signature: fixture.source.authority.sign(
                    SignaturePurpose.JointWorkspaceRetry,
                    JointWorkspaceReceiptProof.transcript(body),
                ),
            };
        } else if (fault === ReceiptFault.Authority) {
            receipt = JointWorkspaceReceiptProof.sign(foreign, body);
        } else if (fault === ReceiptFault.Lease) {
            receipt = JointWorkspaceReceiptProof.sign(fixture.source.authority, {
                ...body,
                leaseId: randomBytes(32).toString('base64url'),
            });
        } else {
            receipt = JointWorkspaceReceiptProof.sign(fixture.source.authority, {
                ...body,
                publicationSha256: 'f'.repeat(64),
            });
        }
        fixture.delivery.receive(
            { kind: ConnectorFrameKind.JointWorkspaceActivated, receipt },
            link,
        );
        expect(await fixture.closed()).toBe(link);
        expect(fixture.delivery.ready).toBe(false);
        expect(fixture.readyCount).toBe(0);
        expect(fixture.journal.pending).toEqual(sent.publication);
        expect(fixture.journal.snapshot.accepted).toBeNull();
        expect(await readFile(join(fixture.source.directory, 'workspace-head'))).toEqual(before);
    },
);

it.each([
    ReceiptFault.PostQuantum,
    ReceiptFault.Classical,
    ReceiptFault.Purpose,
    ReceiptFault.Publication,
])(
    'a retry with %s cannot manufacture a wait or bypass current publication authentication',
    async (fault: ReceiptFault): Promise<void> => {
        await using fixture: JointWorkspaceDeliveryFixture =
            await JointWorkspaceDeliveryFixture.create();
        const link: ExecutionDeliveryLink = fixture.link();
        fixture.activate(link);
        const sent: JointWorkspaceDeliverySent = await fixture.sent();
        const before: Buffer = await readFile(join(fixture.source.directory, 'workspace-head'));
        const body: JointWorkspaceRetryBody = {
            ...fixture.receiptBody(sent),
            reason: JointWorkspaceRetryReason.OriginalPending,
            retryAfterMs: JointWorkspaceRetryLimits.retryAfterMs,
        };
        let retry: JointWorkspaceRetry = JointWorkspaceRetryProof.sign(
            fixture.source.authority,
            body,
        );
        if (fault === ReceiptFault.PostQuantum || fault === ReceiptFault.Classical) {
            retry = {
                ...retry,
                signature: DeliverySignatureFault.mutate(
                    retry.signature,
                    fault === ReceiptFault.PostQuantum ? 0 : IdentityLengths.mlDsaSignature,
                ),
            };
        } else if (fault === ReceiptFault.Purpose) {
            retry = {
                ...retry,
                signature: fixture.source.authority.sign(
                    SignaturePurpose.JointWorkspaceActivated,
                    JointWorkspaceRetryProof.transcript(body),
                ),
            };
        } else {
            retry = JointWorkspaceRetryProof.sign(fixture.source.authority, {
                ...body,
                publicationSha256: 'f'.repeat(64),
            });
        }
        fixture.delivery.receive({ kind: ConnectorFrameKind.JointWorkspaceRetry, retry }, link);
        expect(await fixture.closed()).toBe(link);
        expect(fixture.delivery.ready).toBe(false);
        expect(fixture.readyCount).toBe(0);
        expect(fixture.sentCount).toBe(1);
        expect(fixture.journal.pending).toEqual(sent.publication);
        expect(fixture.journal.snapshot.accepted).toBeNull();
        expect(await readFile(join(fixture.source.directory, 'workspace-head'))).toEqual(before);
    },
);

it('a reply from another real authenticated link cannot replace the one in-flight response or retire pending history', async (): Promise<void> => {
    await using fixture: JointWorkspaceDeliveryFixture =
        await JointWorkspaceDeliveryFixture.create();
    const link: ExecutionDeliveryLink = fixture.link();
    const foreign: ExecutionDeliveryLink = fixture.link();
    fixture.activate(link);
    const sent: JointWorkspaceDeliverySent = await fixture.sent();
    expect((): void =>
        fixture.delivery.receive(
            { kind: ConnectorFrameKind.JointWorkspaceActivated, receipt: fixture.receipt(sent) },
            foreign,
        ),
    ).toThrow('Unexpected');
    expect(fixture.journal.pending).toEqual(sent.publication);
    expect(fixture.journal.snapshot.accepted).toBeNull();
    fixture.accept(sent);
    expect(await fixture.ready()).toBe(link.leaseId);
    expect(fixture.delivery.ready).toBe(true);
});
