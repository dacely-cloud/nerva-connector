// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

import { ExecutionMachineBoundary as Data } from 'nerva-connector-protocol/execution/ExecutionMachineBoundary.js';
import { ConnectorDeviceCodec } from 'nerva-connector-protocol/protocol/ConnectorDeviceCodec.js';
import type { ConnectorDeviceLeaseTarget } from 'nerva-connector-protocol/protocol/ConnectorDevice.js';
import { ConnectorEnrollmentCodec } from 'nerva-connector-protocol/protocol/ConnectorEnrollmentCodec.js';
import { ConnectorHostObservationCodec as Observation } from 'nerva-connector-protocol/protocol/ConnectorHostObservationCodec.js';
import { ConnectorHostObservationCapabilityCodec as Capability } from './ConnectorHostObservationCapabilityCodec.js';
import { ConnectorHostObservationCapabilityLimits as Limits } from 'nerva-connector-protocol/protocol/ConnectorHostObservationCapability.js';
import { ConnectorHostObservationTranscript } from 'nerva-connector-protocol/protocol/ConnectorHostObservationTranscript.js';
import {
    ConnectorHostObservationFrameKind as Kind,
    type ConnectorHostObservationClientFrame as ClientFrame,
    type ConnectorHostObservationServerFrame as ServerFrame,
} from 'nerva-connector-protocol/protocol/ConnectorHostObservationTransport.js';

/** Strict direction-specific decoding bounds JSON before parsing and admits no additional payload fields. */
export class ConnectorHostObservationTransportCodec {
    /** A primary lease selector is correlation only; the private authority checks its current ownership. */
    public static target(raw: unknown): ConnectorDeviceLeaseTarget {
        const value: Readonly<Record<string, unknown>> = Data.record(raw, [
            'enrollmentId',
            'slot',
            'leaseId',
        ]);
        if (value['slot'] !== 0) {
            throw new Error('Host observations require the exact primary lease');
        }
        return {
            enrollmentId: ConnectorEnrollmentCodec.id(value['enrollmentId']),
            slot: 0,
            leaseId: ConnectorDeviceCodec.nonce(value['leaseId']),
        };
    }

    /** Only hello, capability, readiness and revision hints can originate on the device. */
    public static client(text: string): ClientFrame {
        const raw: unknown = Observation.json(text);
        const kind: Kind = this.#kind(raw);
        Data.data(text, this.maximumBytes(kind));
        switch (kind) {
            case Kind.Hello: {
                const value: Readonly<Record<string, unknown>> = Data.record(raw, [
                    'kind',
                    'target',
                ]);
                return { kind, target: this.target(value['target']) };
            }
            case Kind.Capability: {
                const value: Readonly<Record<string, unknown>> = Data.record(raw, [
                    'kind',
                    'capability',
                ]);
                return { kind, capability: Capability.capability(value['capability']) };
            }
            case Kind.Ready: {
                const value: Readonly<Record<string, unknown>> = Data.record(raw, [
                    'kind',
                    'ready',
                ]);
                return { kind, ready: Observation.ready(value['ready']) };
            }
            case Kind.Changed: {
                const value: Readonly<Record<string, unknown>> = Data.record(raw, [
                    'kind',
                    'changed',
                ]);
                return { kind, changed: Observation.changed(value['changed']) };
            }
            default:
                throw new Error('Invalid device host observation frame direction');
        }
    }

    /** No authentication, command or byte frame is accepted from the metadata server. */
    public static server(text: string): ServerFrame {
        const raw: unknown = Observation.json(text);
        const kind: Kind = this.#kind(raw);
        Data.data(text, this.maximumBytes(kind));
        switch (kind) {
            case Kind.Challenge: {
                const value: Readonly<Record<string, unknown>> = Data.record(raw, [
                    'kind',
                    'challenge',
                ]);
                return { kind, challenge: Capability.challenge(value['challenge']) };
            }
            case Kind.Activation: {
                const value: Readonly<Record<string, unknown>> = Data.record(raw, [
                    'kind',
                    'activation',
                ]);
                return { kind, activation: Capability.activation(value['activation']) };
            }
            case Kind.Permit: {
                const value: Readonly<Record<string, unknown>> = Data.record(raw, [
                    'kind',
                    'permit',
                ]);
                return { kind, permit: Observation.permit(value['permit']) };
            }
            case Kind.Acknowledgment: {
                const value: Readonly<Record<string, unknown>> = Data.record(raw, [
                    'kind',
                    'acknowledgment',
                ]);
                return {
                    kind,
                    acknowledgment: Observation.acknowledgment(value['acknowledgment']),
                };
            }
            default:
                throw new Error('Invalid server host observation frame direction');
        }
    }

    /** Only the pre-authentication selectors use the smaller 1KiB limit. */
    public static maximumBytes(kind: Kind): number {
        return kind === Kind.Hello || kind === Kind.Challenge ? 1024 : Limits.frameBytes;
    }

    /** Integer fields remain decimal strings and the complete outer frame is bounded before sending. */
    public static encode(frame: ClientFrame | ServerFrame): string {
        const text: string = ConnectorHostObservationTranscript.encode(frame);
        Data.data(text, this.maximumBytes(frame.kind));
        return text;
    }

    static #kind(raw: unknown): Kind {
        if (typeof raw !== 'object' || raw === null) {
            throw new Error('Invalid host observation frame');
        }
        const descriptor: PropertyDescriptor | undefined = Object.getOwnPropertyDescriptor(
            raw,
            'kind',
        );
        const candidate: unknown =
            descriptor !== undefined && Object.hasOwn(descriptor, 'value')
                ? descriptor.value
                : undefined;
        const kind: Kind | undefined = Object.values(Kind).find(
            (value: Kind): boolean => value === candidate,
        );
        if (kind === undefined) {
            throw new Error('Unsupported host observation frame');
        }
        return kind;
    }
}
