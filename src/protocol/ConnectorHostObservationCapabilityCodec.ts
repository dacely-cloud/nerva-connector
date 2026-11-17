// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

import { IdentityLengths } from 'nerva-connector-protocol/identity/IdentityFormat.js';
import { Boundary } from 'nerva-connector-protocol/protocol/Boundary.js';
import { ConnectorHostObservationFields as Data } from './ConnectorHostObservationFields.js';
import { ConnectorDeviceCodec } from 'nerva-connector-protocol/protocol/ConnectorDeviceCodec.js';
import { ConnectorEnrollmentCodec as Identity } from 'nerva-connector-protocol/protocol/ConnectorEnrollmentCodec.js';
import { ConnectorHostCodec } from './ConnectorHostCodec.js';
import { ConnectorHostTool, type ConnectorHostPublication } from './ConnectorHost.js';
import { ConnectorHostObservedStart } from './ConnectorHostObservationProtocol.js';
import { ConnectorHostObservationLimits } from 'nerva-connector-protocol/protocol/ConnectorHostObservation.js';
import { ConnectorHostObservationTranscript as Transcript } from 'nerva-connector-protocol/protocol/ConnectorHostObservationTranscript.js';
import {
    ConnectorHostObservationCapabilityLimits as Limits,
    type ConnectorHostObservationChallenge as Challenge,
    type ConnectorHostObservationCapability as Capability,
    type ConnectorHostObservationActivation as Activation,
} from './ConnectorHostObservationCapability.js';

/** Untrusted companion handshakes have one closed canonical bounded representation before cryptographic verification. */
export class ConnectorHostObservationCapabilityCodec {
    /** A challenge is only a nonce, never a trusted lease or a promise of device support. */
    public static challenge(raw: unknown): Challenge {
        const value: Readonly<Record<string, unknown>> = Data.record(raw, ['companionNonce']);
        return { companionNonce: ConnectorDeviceCodec.nonce(value['companionNonce']) };
    }
    /** Present v1 and its own-data publication/profile are mandatory; ordinary absence never becomes support. */
    public static capability(raw: unknown): Capability {
        const value: Readonly<Record<string, unknown>> = Data.record(raw, [
            'publication',
            'companionNonce',
            'runtimeId',
            'signature',
        ]);
        const publication: Readonly<Record<string, unknown>> = Data.record(value['publication'], [
            'enrollmentId',
            'leaseId',
            'journalId',
            'profile',
            'observationProtocol',
            'signature',
        ]);
        const profile: Readonly<Record<string, unknown>> = Data.record(publication['profile'], [
            'grantId',
            'grantRevision',
            'enabled',
            'platform',
            'directory',
            'tools',
        ]);
        const validated: ConnectorHostPublication = ConnectorHostCodec.publication({
            ...publication,
            profile: {
                ...profile,
                tools: Data.array(profile['tools'], Object.values(ConnectorHostTool).length),
            },
        });
        if (validated.observationProtocol !== ConnectorHostObservedStart.Protocol) {
            throw new Error('Explicit current host observation capability required');
        }
        return this.#bounded(
            {
                publication: validated,
                companionNonce: ConnectorDeviceCodec.nonce(value['companionNonce']),
                runtimeId: ConnectorDeviceCodec.nonce(value['runtimeId']),
                signature: Identity.binary(value['signature'], IdentityLengths.signature),
            },
            Limits.capabilityBytes,
        );
    }
    /** A finite activation cannot outlive the primary lease; the verifier checks that trusted lease separately. */
    public static activation(raw: unknown): Activation {
        const value: Readonly<Record<string, unknown>> = Data.record(raw, [
            'authorityId',
            'enrollmentId',
            'leaseId',
            'journalId',
            'companionNonce',
            'runtimeId',
            'publicationSha256',
            'issuedAtMs',
            'expiresAtMs',
            'signature',
        ]);
        const issuedAtMs: bigint = Boundary.integer(value['issuedAtMs']);
        const expiresAtMs: bigint = Boundary.integer(value['expiresAtMs']);
        if (
            expiresAtMs <= issuedAtMs ||
            expiresAtMs - issuedAtMs > ConnectorHostObservationLimits.PermitMs
        ) {
            throw new Error('Invalid host observation activation lifetime');
        }
        return this.#bounded(
            {
                authorityId: Boundary.id(value['authorityId']),
                enrollmentId: Identity.id(value['enrollmentId']),
                leaseId: ConnectorDeviceCodec.nonce(value['leaseId']),
                journalId: Identity.digest(value['journalId']),
                companionNonce: ConnectorDeviceCodec.nonce(value['companionNonce']),
                runtimeId: ConnectorDeviceCodec.nonce(value['runtimeId']),
                publicationSha256: Identity.digest(value['publicationSha256']),
                issuedAtMs,
                expiresAtMs,
                signature: Identity.binary(value['signature'], IdentityLengths.signature),
            },
            Limits.activationBytes,
        );
    }
    static #bounded<T>(value: T, maximum: number): T {
        Data.data(Transcript.encode(value), maximum);
        return value;
    }
}
