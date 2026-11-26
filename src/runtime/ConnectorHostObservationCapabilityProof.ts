// SPDX-FileCopyrightText: 2026 Dacely <business@dacely.com>
// SPDX-License-Identifier: LicenseRef-Proprietary

import { ConnectorClock } from '../protocol/ConnectorClock.js';
import { SigningKey } from '../identity/SigningKey.js';
import { SignaturePurpose } from 'nerva-connector-protocol/identity/IdentityFormat.js';
import type { ConnectorHostPublication } from 'nerva-connector-protocol/protocol/ConnectorHost.js';
import { ConnectorHostObservationCapabilityCodec as Codec } from '../protocol/ConnectorHostObservationCapabilityCodec.js';
import { ConnectorHostObservationCapabilityTranscript as Transcript } from 'nerva-connector-protocol/protocol/ConnectorHostObservationCapabilityTranscript.js';
import { ConnectorHostObservationTranscript } from 'nerva-connector-protocol/protocol/ConnectorHostObservationTranscript.js';
import { ConnectorHostObservedStart } from 'nerva-connector-protocol/protocol/ConnectorHostObservationProtocol.js';
import type {
    ConnectorHostObservationCapability as Capability,
    ConnectorHostObservationActivation as Activation,
} from 'nerva-connector-protocol/protocol/ConnectorHostObservationCapability.js';
import { ConnectorHostProof } from './ConnectorHostProof.js';

/** The current primary owner, installed authority and this socket's challenge supply all expected pins. */
export interface ConnectorHostObservationActivationExpected {
    readonly authorityId: string;
    readonly authorityPublicKey: string;
    readonly publication: ConnectorHostPublication;
    readonly companionNonce: string;
    readonly runtimeId: string;
    readonly leaseExpiresAtMs: bigint;
    readonly nowMs: bigint;
}

/** Capability proof creation and activation verification never allocate a device authentication slot or native process. */
export class ConnectorHostObservationCapabilityProof {
    /** Device proof commits the canonical publication body, excluding its independently verified randomized signature. */
    public static publicationSha256(publication: ConnectorHostPublication): string {
        return ConnectorHostProof.digest(ConnectorHostProof.publication(publication).toString());
    }
    /** Only the private device signer emits a capability after receiving the current server-owned side challenge. */
    public static capability(
        key: SigningKey,
        publication: ConnectorHostPublication,
        companionNonce: string,
        runtimeId: string,
    ): Capability {
        const canonical: Capability = Codec.capability(
            JSON.parse(
                ConnectorHostObservationTranscript.encode({
                    publication,
                    companionNonce,
                    runtimeId,
                    signature: publication.signature,
                }),
            ),
        );
        return {
            ...canonical,
            signature: key.sign(
                SignaturePurpose.HostObservationReady,
                Buffer.from(
                    Transcript.capability(
                        this.publicationSha256(canonical.publication),
                        canonical.companionNonce,
                        canonical.runtimeId,
                    ),
                ),
            ),
        };
    }
    /** An activation is usable only on this exact socket attempt, primary lease and currently approved explicit v1 publication. */
    public static activation(
        raw: unknown,
        expected: ConnectorHostObservationActivationExpected,
    ): Activation | null {
        try {
            const value: Activation = Codec.activation(raw);
            const publication: ConnectorHostPublication = expected.publication;
            if (
                publication.observationProtocol !== ConnectorHostObservedStart.Protocol ||
                !publication.profile.enabled ||
                value.authorityId !== expected.authorityId ||
                value.enrollmentId !== publication.enrollmentId ||
                value.leaseId !== publication.leaseId ||
                value.journalId !== publication.journalId ||
                value.companionNonce !== expected.companionNonce ||
                value.runtimeId !== expected.runtimeId ||
                value.publicationSha256 !== this.publicationSha256(publication) ||
                !ConnectorClock.issued(value.issuedAtMs, expected.nowMs) ||
                value.expiresAtMs <= expected.nowMs ||
                value.expiresAtMs > expected.leaseExpiresAtMs ||
                !SigningKey.verify(
                    SignaturePurpose.HostObservationPermit,
                    expected.authorityPublicKey,
                    Buffer.from(Transcript.activation(value)),
                    value.signature,
                )
            ) {
                return null;
            }
            return Object.freeze({ ...value });
        } catch {
            return null;
        }
    }
}
