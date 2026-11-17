// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

import { createHash } from 'node:crypto';
import { SigningKey } from '../identity/SigningKey.js';
import type { SignaturePurpose } from 'nerva-connector-protocol/identity/IdentityFormat.js';
import { ConnectorHostCodec } from '../protocol/ConnectorHostCodec.js';
import type {
    ConnectorHostPublication,
    ConnectorHostPermit,
    ConnectorHostCompletion,
    ConnectorHostAcknowledgment,
    ConnectorHostAcknowledged,
    ConnectorHostResponse,
} from '../protocol/ConnectorHost.js';

/** Purpose-separated host transcripts bind full data through their validated exact commitments. */
export class ConnectorHostProof {
    /** Byte-exact request and response commitments are never substituted with normalized JSON. */
    public static digest(value: string): string {
        return createHash('sha256').update(value).digest('hex');
    }
    /** Responses include the outcome as well as their exact result JSON. */
    public static responseHash(value: ConnectorHostResponse): string {
        return this.digest(
            ConnectorHostCodec.encode([value.outcome, value.errorCode, value.resultJson]),
        );
    }
    /** A profile has its full content inside the signed publication. */
    public static publication(value: Omit<ConnectorHostPublication, 'signature'>): Buffer {
        return Buffer.from(
            ConnectorHostCodec.encode([
                ...(value.observationProtocol === undefined
                    ? ['nerva-connector:host:profile']
                    : ['nerva-connector:host:profile:observation:v1']),
                value.enrollmentId,
                value.leaseId,
                value.journalId,
                value.profile,
                ...(value.observationProtocol === undefined ? [] : [value.observationProtocol]),
            ]),
        );
    }
    /** Large argument bodies are committed by requestHash, which the receiver independently recomputes. */
    public static permit(value: Omit<ConnectorHostPermit, 'signature'>): Buffer {
        return Buffer.from(
            ConnectorHostCodec.encode([
                'nerva-connector:host:permit',
                value.authorityId,
                ...this.#original(value),
                value.issuedAtMs,
                value.expiresAtMs,
                value.startByMs,
            ]),
        );
    }
    /** Output bytes are committed by responseHash without expanding the cryptographic payload bound. */
    public static completion(value: Omit<ConnectorHostCompletion, 'signature'>): Buffer {
        return Buffer.from(
            ConnectorHostCodec.encode([
                'nerva-connector:host:result',
                ...this.#original(value),
                value.responseHash,
            ]),
        );
    }
    /** Only the pinned private authority may instruct retained-result compaction. */
    public static acknowledgment(value: Omit<ConnectorHostAcknowledgment, 'signature'>): Buffer {
        return Buffer.from(
            ConnectorHostCodec.encode([
                'nerva-connector:host:acknowledgment',
                value.authorityId,
                ...this.#original(value),
                value.responseHash,
            ]),
        );
    }
    /** Device confirmation is a distinct proof from the backend's acknowledgment. */
    public static acknowledged(value: Omit<ConnectorHostAcknowledged, 'signature'>): Buffer {
        return Buffer.from(
            ConnectorHostCodec.encode([
                'nerva-connector:host:acknowledged',
                ...this.#original(value),
                value.responseHash,
            ]),
        );
    }
    /** The caller owns the enrolled or authority key and selects the expected purpose. */
    public static sign(key: SigningKey, purpose: SignaturePurpose, payload: Buffer): string {
        return key.sign(purpose, payload);
    }
    /** Composite verification retains both classical and post-quantum proofs. */
    public static verify(
        publicKey: string,
        purpose: SignaturePurpose,
        payload: Buffer,
        signature: string,
    ): boolean {
        return SigningKey.verify(purpose, publicKey, payload, signature);
    }
    static #original(
        value: Omit<
            | ConnectorHostPermit
            | ConnectorHostCompletion
            | ConnectorHostAcknowledgment
            | ConnectorHostAcknowledged,
            'signature'
        >,
    ): readonly (string | bigint)[] {
        return [
            value.enrollmentId,
            value.leaseId,
            value.journalId,
            value.jobId,
            value.sequence,
            value.dispatchId,
            value.requestHash,
        ];
    }
}
