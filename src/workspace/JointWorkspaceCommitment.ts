// SPDX-FileCopyrightText: 2026 Dacely <business@dacely.com>
// SPDX-License-Identifier: LicenseRef-Proprietary

import { createHmac } from 'node:crypto';
import type { SigningKey } from '../identity/SigningKey.js';
import { KeyDerivationPurpose } from 'nerva-connector-protocol/identity/IdentityFormat.js';
import { JointWorkspaceCodec } from 'nerva-connector-protocol/workspace/JointWorkspaceCodec.js';
import { WorkspaceIdentityCodec } from './WorkspaceIdentityCodec.js';
import type { WorkspaceIdentity } from './WorkspaceIdentity.js';
import type { JointWorkspacePhysicalScope } from 'nerva-connector-protocol/workspace/JointWorkspaceBinding.js';

/** Owns a new purpose-separated secret; the diagnostic's private commitment is never imported or republished. */
export class JointWorkspaceCommitment implements Disposable {
    readonly #key: Buffer;
    #closed: boolean = false;

    /** Deployment and enrollment scope partition a device's opaque public root identity without including mutable aliases or policies. */
    public constructor(key: SigningKey, input: JointWorkspacePhysicalScope) {
        const scope: JointWorkspacePhysicalScope = JointWorkspaceCodec.physicalScope(input);
        if (scope.devicePublicKey !== key.publicKey) {
            throw new Error('Joint workspace signer does not match the expected device');
        }
        const salt: Buffer = Buffer.from(
            JSON.stringify([
                'nerva-connector:joint-workspace-root:salt:1',
                scope.authorityId,
                scope.authorityPublicKey,
                scope.enrollmentId,
                scope.environmentId,
            ]),
        );
        try {
            this.#key = key.deriveKey(KeyDerivationPurpose.JointWorkspaceRoot, salt);
        } finally {
            salt.fill(0);
        }
    }

    /** Only this newly derived HMAC is public; raw identities and all derivation inputs remain private to the device. */
    public commitment(input: WorkspaceIdentity): string {
        if (this.#closed) {
            throw new Error('Joint workspace commitment owner is closed');
        }
        const identity: WorkspaceIdentity = WorkspaceIdentityCodec.value(input);
        const material: Buffer = Buffer.from(
            JSON.stringify([
                'nerva-connector:joint-workspace-root:1',
                identity.filesystemUuid,
                identity.device.toString(),
                identity.inode.toString(),
                identity.handleType,
                identity.handle,
            ]),
        );
        try {
            return createHmac('sha256', this.#key).update(material).digest('hex');
        } finally {
            material.fill(0);
        }
    }

    /** Disposal erases this owner's HKDF output and forbids reuse as an all-zero-key commitment. */
    public [Symbol.dispose](): void {
        this.#closed = true;
        this.#key.fill(0);
    }
}
