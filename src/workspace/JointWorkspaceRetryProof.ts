// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

import { SigningKey } from '../identity/SigningKey.js';
import { SignaturePurpose } from 'nerva-connector-protocol/identity/IdentityFormat.js';
import { JointWorkspaceRetryCodec } from 'nerva-connector-protocol/workspace/JointWorkspaceRetryCodec.js';
import type {
    JointWorkspaceRetry,
    JointWorkspaceRetryBody,
} from 'nerva-connector-protocol/workspace/JointWorkspaceRetry.js';
import type { JointWorkspacePublication } from 'nerva-connector-protocol/workspace/JointWorkspacePublication.js';
import type { JointWorkspaceReceiptExpected } from 'nerva-connector-protocol/workspace/JointWorkspaceReceipt.js';
import { JointWorkspaceReplyProof } from './JointWorkspaceReplyProof.js';
import { JointWorkspaceReceiptProof } from './JointWorkspaceReceiptProof.js';
/** A verified publication delay grants no active workspace and changes no operation history. */
export class JointWorkspaceRetryProof {
    /** Both delay fields are covered under a purpose distinct from activation. */
    public static transcript(value: JointWorkspaceRetryBody): Buffer {
        const body: JointWorkspaceRetryBody = JointWorkspaceRetryCodec.body(value);
        return Buffer.from(
            JSON.stringify([
                'nerva-connector:joint-workspace-retry:1',
                body.authorityId,
                body.environmentId,
                body.enrollmentId,
                body.slot,
                body.leaseId,
                body.bindingRevision.toString(),
                body.bindingSha256,
                body.publicationSha256,
                body.issuedAtMs.toString(),
                body.reason,
                body.retryAfterMs,
            ]),
        );
    }
    /** The caller transmits only after its current verified lease fence commits. */
    public static sign(key: SigningKey, value: JointWorkspaceRetryBody): JointWorkspaceRetry {
        const body: JointWorkspaceRetryBody = JointWorkspaceRetryCodec.body(value);
        return JointWorkspaceRetryCodec.value({
            ...body,
            signature: key.sign(SignaturePurpose.JointWorkspaceRetry, this.transcript(body)),
        });
    }
    /** Both authority components, complete original publication and actual lease are receiver-selected. */
    public static verify(
        expected: JointWorkspaceReceiptExpected,
        original: JointWorkspacePublication,
        value: JointWorkspaceRetry,
        nowMs: bigint,
    ): boolean {
        try {
            const retry: JointWorkspaceRetry = JointWorkspaceRetryCodec.value(value);
            const body: JointWorkspaceRetryBody = {
                ...JointWorkspaceRetryCodec.receipt(retry),
                reason: retry.reason,
                retryAfterMs: retry.retryAfterMs,
            };
            return JointWorkspaceReplyProof.verify(
                expected,
                original,
                JointWorkspaceRetryCodec.receipt(body),
                JointWorkspaceReceiptProof.publicationSha256(original),
                retry.signature,
                SignaturePurpose.JointWorkspaceRetry,
                this.transcript(body),
                nowMs,
            );
        } catch {
            return false;
        }
    }
}
