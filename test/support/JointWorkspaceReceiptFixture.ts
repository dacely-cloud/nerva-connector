// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

import { JointWorkspaceAssembly } from '../../src/workspace/JointWorkspaceAssembly.js';
import { JointWorkspaceProof } from '../../src/workspace/JointWorkspaceProof.js';
import { JointWorkspacePublicationProof } from '../../src/workspace/JointWorkspacePublicationProof.js';
import { JointWorkspaceReceiptProof } from '../../src/workspace/JointWorkspaceReceiptProof.js';
import type { JointWorkspacePublication } from 'nerva-connector-protocol/workspace/JointWorkspacePublication.js';
import type {
    JointWorkspaceReceiptBody,
    JointWorkspaceReceiptExpected,
} from 'nerva-connector-protocol/workspace/JointWorkspaceReceipt.js';
import { JointWorkspaceFixture } from './JointWorkspaceFixture.js';

/** Public synthetic lease data and fresh disposable keys qualify receipt protocol only, never backend commit or physical capture. */
export class JointWorkspaceReceiptFixture extends JointWorkspaceFixture {
    public readonly nowMs: bigint = 10000n;
    public readonly publication: JointWorkspacePublication = JointWorkspacePublicationProof.sign(
        this.device,
        {
            enrollmentId: this.expected.enrollmentId,
            slot: 0,
            leaseId: Buffer.alloc(32, 1).toString('base64url'),
            descriptor: JointWorkspaceAssembly.create(
                this.device,
                this.scope,
                9007199254740993n,
                this.sources(),
            ),
        },
    );

    /** The receiver already owns the actual authenticated lease interval and installed full authority pin. */
    public get current(): JointWorkspaceReceiptExpected {
        return {
            ...this.expected,
            slot: 0,
            leaseId: this.publication.leaseId,
            authorityPublicKey: this.authority.publicKey,
            leaseIssuedAtMs: 1000n,
            leaseExpiresAtMs: 31000n,
        };
    }

    /** Exact publication proof bytes are committed independently of stable binding identity. */
    public get receiptBody(): JointWorkspaceReceiptBody {
        return {
            authorityId: this.expected.authorityId,
            environmentId: this.expected.environmentId,
            enrollmentId: this.expected.enrollmentId,
            slot: 0,
            leaseId: this.publication.leaseId,
            bindingRevision: this.publication.descriptor.binding.revision,
            bindingSha256: JointWorkspaceProof.bindingSha256(this.publication.descriptor.binding),
            publicationSha256: JointWorkspaceReceiptProof.publicationSha256(this.publication),
            issuedAtMs: this.nowMs,
        };
    }
}
