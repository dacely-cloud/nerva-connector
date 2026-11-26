// SPDX-FileCopyrightText: 2026 Dacely <business@dacely.com>
// SPDX-License-Identifier: LicenseRef-Proprietary

import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { ConnectorSocket } from '../networking/ConnectorSocket.js';
import type { ConnectorDeviceLease } from 'nerva-connector-protocol/protocol/ConnectorDevice.js';
import { ConnectorHostObservationCapabilityLimits as Limits } from 'nerva-connector-protocol/protocol/ConnectorHostObservationCapability.js';
import { ConnectorHostObservationTransportCodec as Codec } from '../protocol/ConnectorHostObservationTransportCodec.js';
import { ConnectorHostObservationTranscript as Transcript } from 'nerva-connector-protocol/protocol/ConnectorHostObservationTranscript.js';
import {
    ConnectorHostObservationFrameKind as Kind,
    type ConnectorHostObservationClientFrame as ClientFrame,
    type ConnectorHostObservationServerFrame as ServerFrame,
} from 'nerva-connector-protocol/protocol/ConnectorHostObservationTransport.js';
import type { ConnectorClientIdentity } from './ConnectorClientConfiguration.js';
import type { ConnectorClientHost } from './ConnectorClientHost.js';
import { ConnectorHostObservationDelivery } from './ConnectorHostObservationDelivery.js';
import type { ConnectorHostObservationConnection as Connection } from './ConnectorHostObservationOwners.js';

/** Side handshake stages never alter primary authentication or select an effectful tool. */
const ObservationClientStage = {
    Opening: 'opening',
    Challenge: 'challenge',
    Activation: 'activation',
    Active: 'active',
    Closed: 'closed',
} as const;
/** Stage values derive from their finite runtime map. */
type ObservationClientStage = (typeof ObservationClientStage)[keyof typeof ObservationClientStage];

/** Mutable callback state keeps the exact attempt visible to final cleanup after native socket events. */
interface ObservationClientAttempt {
    stage: ObservationClientStage;
    connection: Connection | null;
    delivery: ConnectorHostObservationDelivery | null;
    frames: number;
    window: number;
}

/** An optional bounded companion borrows an already authenticated primary lease without owning or closing that lease. */
export class ConnectorHostObservationClient {
    /** Trusted native configuration supplies the same pinned TLS settings and exact local host owner as the primary connection. */
    public constructor(
        public readonly identity: ConnectorClientIdentity,
        public readonly host: ConnectorClientHost,
    ) {}

    /** At most three metadata-only attempts fit one primary lifetime; an unsupported peer leaves all ordinary host behavior unchanged. */
    public async run(
        endpoint: string,
        lease: ConnectorDeviceLease,
        signal: AbortSignal,
    ): Promise<void> {
        if (!this.host.observationEnabled) {
            return;
        }
        if (
            !this.identity.settings.endpoints.includes(endpoint) ||
            lease.slot !== 0 ||
            lease.enrollmentId !== this.identity.settings.enrollmentId ||
            lease.environmentId !== this.identity.settings.environmentId ||
            lease.publicKey !== this.identity.publicKey ||
            lease.authorityId !== this.identity.settings.authorityId
        ) {
            throw new Error('Host observation primary binding denied');
        }
        for (let attempt: number = 0; attempt < 3; attempt++) {
            if (signal.aborted || BigInt(Date.now()) >= lease.expiresAtMs) {
                return;
            }
            await this.#attempt(endpoint, lease, signal);
            if (signal.aborted || BigInt(Date.now()) >= lease.expiresAtMs || attempt === 2) {
                return;
            }
            try {
                await delay(attempt === 0 ? 250 : 1000, undefined, { signal });
            } catch {
                return;
            }
        }
    }

    async #attempt(
        endpoint: string,
        lease: ConnectorDeviceLease,
        signal: AbortSignal,
    ): Promise<void> {
        try {
            await this.#once(endpoint, lease, signal);
        } catch {
            return;
        }
    }

    async #once(endpoint: string, lease: ConnectorDeviceLease, signal: AbortSignal): Promise<void> {
        const remaining: bigint = lease.expiresAtMs - BigInt(Date.now());
        if (remaining <= 0n || remaining > 30000n) {
            return;
        }
        const socket: ConnectorSocket = new ConnectorSocket(endpoint, Limits.protocol, {
            ca: this.identity.ca,
            maximumPayload: Limits.frameBytes,
            handshakeMs: Limits.handshakeMs,
        });
        const done: PromiseWithResolvers<undefined> = Promise.withResolvers<undefined>();
        const attempt: ObservationClientAttempt = {
            stage: ObservationClientStage.Opening,
            connection: null,
            delivery: null,
            frames: 0,
            window: performance.now(),
        };
        const stop: () => void = (): void => socket.terminate();
        const handshake: NodeJS.Timeout = setTimeout(
            stop,
            Math.min(Limits.handshakeMs, Number(remaining)),
        );
        const expiry: NodeJS.Timeout = setTimeout(stop, Number(remaining));
        const send: (frame: ClientFrame) => void = (frame: ClientFrame): void => {
            const json: string = Codec.encode(frame);
            if (
                attempt.stage === ObservationClientStage.Closed ||
                signal.aborted ||
                !socket.isOpen ||
                socket.bufferedAmount + Buffer.byteLength(json) > Limits.frameBytes
            ) {
                throw new Error('Host observation side send budget exceeded');
            }
            socket.send(json);
        };
        signal.addEventListener('abort', stop, { once: true });
        socket.on('error', stop);
        socket.once('close', (): void => {
            attempt.stage = ObservationClientStage.Closed;
            done.resolve(undefined);
        });
        socket.once('open', (): void => {
            try {
                if (signal.aborted || BigInt(Date.now()) >= lease.expiresAtMs) {
                    stop();
                    return;
                }
                attempt.stage = ObservationClientStage.Challenge;
                send({
                    kind: Kind.Hello,
                    target: { enrollmentId: lease.enrollmentId, slot: 0, leaseId: lease.leaseId },
                });
            } catch {
                stop();
            }
        });
        socket.on('message', (data: Buffer, binary: boolean): void => {
            try {
                const now: number = performance.now();
                if (now - attempt.window >= 1000) {
                    attempt.window = now;
                    attempt.frames = 0;
                }
                if (
                    binary ||
                    !Buffer.isBuffer(data) ||
                    data.byteLength > Limits.frameBytes ||
                    ++attempt.frames > 64 ||
                    signal.aborted ||
                    BigInt(Date.now()) >= lease.expiresAtMs
                ) {
                    throw new Error('Invalid host observation side frame');
                }
                const frame: ServerFrame = Codec.server(
                    new TextDecoder('utf-8', { fatal: true }).decode(data),
                );
                if (
                    frame.kind === Kind.Challenge &&
                    attempt.stage === ObservationClientStage.Challenge
                ) {
                    const current: Connection = {
                        leaseId: lease.leaseId,
                        companionNonce: frame.challenge.companionNonce,
                        expiresAtMs: lease.expiresAtMs,
                        nowMs: BigInt(Date.now()),
                    };
                    attempt.connection = current;
                    attempt.stage = ObservationClientStage.Activation;
                    send({
                        kind: Kind.Capability,
                        capability: this.host.observationCapability(
                            current.companionNonce,
                            current,
                        ),
                    });
                } else if (
                    frame.kind === Kind.Activation &&
                    attempt.stage === ObservationClientStage.Activation &&
                    attempt.connection !== null
                ) {
                    this.host.activateObservation(
                        JSON.parse(Transcript.encode(frame.activation)),
                        attempt.connection.companionNonce,
                        { ...attempt.connection, nowMs: BigInt(Date.now()) },
                    );
                    const current: Connection = {
                        ...attempt.connection,
                        expiresAtMs: frame.activation.expiresAtMs,
                        nowMs: BigInt(Date.now()),
                    };
                    attempt.delivery = new ConnectorHostObservationDelivery(this.host, current, {
                        ready: (ready): void => send({ kind: Kind.Ready, ready }),
                        changed: (changed): void => send({ kind: Kind.Changed, changed }),
                        failed: stop,
                    });
                    attempt.stage = ObservationClientStage.Active;
                    clearTimeout(handshake);
                } else if (
                    frame.kind === Kind.Permit &&
                    attempt.stage === ObservationClientStage.Active &&
                    attempt.delivery !== null
                ) {
                    attempt.delivery.permit(JSON.parse(Transcript.encode(frame.permit)));
                } else if (
                    frame.kind === Kind.Acknowledgment &&
                    attempt.stage === ObservationClientStage.Active &&
                    attempt.delivery !== null
                ) {
                    attempt.delivery.acknowledge(
                        JSON.parse(Transcript.encode(frame.acknowledgment)),
                    );
                } else {
                    throw new Error('Unexpected host observation side handshake stage');
                }
            } catch {
                stop();
            }
        });
        try {
            if (signal.aborted) {
                stop();
            }
            await done.promise;
        } finally {
            attempt.stage = ObservationClientStage.Closed;
            clearTimeout(handshake);
            clearTimeout(expiry);
            signal.removeEventListener('abort', stop);
            socket.terminate();
            if (attempt.connection !== null) {
                this.host.deactivateObservation(attempt.connection.companionNonce);
            }
            await attempt.delivery?.[Symbol.asyncDispose]();
        }
    }
}
