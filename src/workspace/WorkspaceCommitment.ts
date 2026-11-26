// SPDX-FileCopyrightText: 2026 Dacely <business@dacely.com>
// SPDX-License-Identifier: LicenseRef-Proprietary

import { createHmac } from 'node:crypto';
import type { SigningKey } from '../identity/SigningKey.js';
import { IdentityCodec } from 'nerva-connector-protocol/identity/IdentityCodec.js';
import { KeyDerivationPurpose } from 'nerva-connector-protocol/identity/IdentityFormat.js';
import { Boundary } from 'nerva-connector-protocol/protocol/Boundary.js';
import { ConnectorEnrollmentCodec } from 'nerva-connector-protocol/protocol/ConnectorEnrollmentCodec.js';
import type { WorkspaceIdentity } from './WorkspaceIdentity.js';

/** The current device identity is partitioned by actual pinned authority, enrollment and environment. */
export interface WorkspaceIdentityBinding {
    readonly authorityId: string;
    readonly authorityPublicKey: string;
    readonly enrollmentId: string;
    readonly environmentId: string;
}

/** Owns a purpose-separated local HMAC key; aliases, lanes, policies and paths never influence root identity. */
export class WorkspaceCommitment implements Disposable {
    readonly #key: Buffer;
    #closed: boolean = false;

    /** Derivation uses both signing secrets without exposing or passing them to native code. */
    public constructor(key: SigningKey, binding: WorkspaceIdentityBinding) {
        IdentityCodec.publicKey(binding.authorityPublicKey);
        const salt: Buffer = Buffer.from(
            JSON.stringify([
                'nerva-connector:workspace-identity:salt:1',
                Boundary.id(binding.authorityId),
                binding.authorityPublicKey,
                ConnectorEnrollmentCodec.id(binding.enrollmentId),
                Boundary.id(binding.environmentId),
            ]),
        );
        try {
            this.#key = key.deriveKey(KeyDerivationPurpose.WorkspaceIdentity, salt);
        } finally {
            salt.fill(0);
        }
    }

    /** Caller owns and must erase the opaque result; it must never enter terminal or remote output. */
    public commitment(identity: WorkspaceIdentity): Buffer {
        if (this.#closed) {
            throw new Error('Workspace identity owner is closed');
        }
        const material: Buffer = Buffer.from(
            JSON.stringify([
                'nerva-connector:workspace-root:1',
                identity.filesystemUuid,
                identity.device.toString(),
                identity.inode.toString(),
                identity.handleType,
                identity.handle,
            ]),
        );
        try {
            return createHmac('sha256', this.#key).update(material).digest();
        } finally {
            material.fill(0);
        }
    }

    /** Disposed key material cannot be reused as an all-zero-key commitment. */
    public [Symbol.dispose](): void {
        this.#closed = true;
        this.#key.fill(0);
    }
}
