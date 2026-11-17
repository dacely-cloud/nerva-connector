// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

import { ConnectorClock } from '../protocol/ConnectorClock.js';
import { HostOperationError } from '../host/HostOperationError.js';
import { ConnectorHostCodec } from '../protocol/ConnectorHostCodec.js';
import {
    ConnectorHostErrorCode,
    type ConnectorHostPermit,
    type ConnectorHostResponse,
    type ConnectorHostPublication,
} from '../protocol/ConnectorHost.js';
import { ConnectorHostObservationLimits } from 'nerva-connector-protocol/protocol/ConnectorHostObservation.js';
import type {
    ConnectorHostObservationCapability as Capability,
    ConnectorHostObservationActivation as Activation,
} from '../protocol/ConnectorHostObservationCapability.js';
import { ConnectorHostObservationCapabilityCodec } from '../protocol/ConnectorHostObservationCapabilityCodec.js';
import type { ConnectorClientIdentity } from './ConnectorClientConfiguration.js';
import { ConnectorHostGrant } from './ConnectorHostGrant.js';
import { type ConnectorHostLocalGrant } from './ConnectorHostGrantTypes.js';
import {
    ConnectorHostObservationOwners,
    type ConnectorHostObservationConnection as Connection,
    type ConnectorHostObservationOwned as Owned,
    type ConnectorHostObservationPrepared as Prepared,
} from './ConnectorHostObservationOwners.js';
import { ConnectorHostObservationCapabilityProof } from './ConnectorHostObservationCapabilityProof.js';

/** The enclosing host supplies actual workspace identity, active owner checks and its signed v1 publication. */
export interface ConnectorHostObservationAccessOptions {
    readonly runtime: () => string | null;
    readonly active: () => void;
    readonly publication: (leaseId: string) => ConnectorHostPublication;
}
/** One attempt cannot replace a later companion through an asynchronous old activation. */
interface ObservationAttempt {
    readonly companionNonce: string;
    readonly leaseId: string;
    readonly expiresAtMs: bigint;
}

/** Metadata authority and in-flight consent reads have a bounded lifetime independent from native effect execution. */
export class ConnectorHostObservationAccess implements Disposable {
    readonly #owners: ConnectorHostObservationOwners;
    readonly #checks: Set<Promise<undefined>> = new Set();
    #attempt: ObservationAttempt | null = null;
    #activation: Activation | null = null;
    #closed: boolean = false;
    /** These settings are trusted native composition, never account/model request parameters. */
    public constructor(
        public readonly identity: ConnectorClientIdentity,
        public readonly grant: ConnectorHostLocalGrant,
        public readonly options: ConnectorHostObservationAccessOptions,
    ) {
        this.#owners = new ConnectorHostObservationOwners(identity, grant);
    }

    /** Available protocol support is separate from an authenticated current companion. */
    public get enabled(): boolean {
        return !this.#closed && this.options.runtime() !== null;
    }
    /** The reservation is made only after current authenticated companion checks and before any native factory. */
    public prepare(permit: ConnectorHostPermit): Prepared {
        this.#active();
        this.#current({ leaseId: permit.leaseId, nowMs: BigInt(Date.now()) });
        return this.#owners.prepare(permit);
    }
    /** An already admitted effect may seal its receipt during shutdown, before the enclosing host joins and disposes this owner. */
    public complete(permit: ConnectorHostPermit, response: ConnectorHostResponse): void {
        this.#owners.complete(permit, response);
    }
    /** Only separately verified observation authority can borrow a retained native source. */
    public async observe(raw: unknown, connection: Connection): Promise<Owned> {
        await this.#consent(connection);
        const current: Connection = this.#at(connection);
        this.#connection(current);
        const owned: Owned = this.#owners.authorize(raw, current, this.grant.profile);
        this.#owned(owned, current);
        return owned;
    }
    /** Every metadata delivery checks current consent and exact generation after its asynchronous wait. */
    public async inspect(owned: Owned, connection: Connection): Promise<void> {
        await this.#consent(connection);
        const current: Connection = this.#at(connection);
        this.#connection(current);
        this.#owners.current(owned, current, this.grant.profile);
        this.#owned(owned, current);
    }

    /** A fresh server challenge starts one current attempt but does not itself authorize marked starts. */
    public capability(companionNonce: string, connection: Connection): Capability {
        this.#active();
        const nonce: string = ConnectorHostObservationCapabilityCodec.challenge({
            companionNonce,
        }).companionNonce;
        const runtimeId: string | null = this.options.runtime();
        if (runtimeId === null || nonce !== connection.companionNonce) {
            throw new Error('Host observation runtime or companion unavailable');
        }
        const publication: ConnectorHostPublication = this.options.publication(connection.leaseId);
        this.#attempt = Object.freeze({
            companionNonce: nonce,
            leaseId: connection.leaseId,
            expiresAtMs: connection.expiresAtMs,
        });
        this.#activation = null;
        return ConnectorHostObservationCapabilityProof.capability(
            this.identity.key,
            publication,
            nonce,
            runtimeId,
        );
    }
    /** Activation requires the exact current challenge, primary lease, actual runtime and installed private authority. */
    public activate(raw: unknown, companionNonce: string, connection: Connection): void {
        this.#active();
        const attempt: ObservationAttempt | null = this.#attempt;
        const runtimeId: string | null = this.options.runtime();
        if (runtimeId === null) {
            throw new Error('Host observation runtime unavailable');
        }
        const activation: Activation | null = ConnectorHostObservationCapabilityProof.activation(
            raw,
            {
                authorityId: this.identity.settings.authorityId,
                authorityPublicKey: this.identity.authority.publicKey,
                publication: this.options.publication(connection.leaseId),
                companionNonce,
                runtimeId,
                leaseExpiresAtMs: connection.expiresAtMs,
                nowMs: BigInt(Date.now()),
            },
        );
        if (
            attempt === null ||
            attempt.companionNonce !== companionNonce ||
            connection.companionNonce !== companionNonce ||
            attempt.leaseId !== connection.leaseId ||
            attempt.expiresAtMs !== connection.expiresAtMs ||
            activation === null
        ) {
            throw new Error('Host observation activation denied');
        }
        this.#activation = activation;
    }
    /** Closing an old side cannot erase a later attempt or stop any native process. */
    public deactivate(companionNonce: string): void {
        if (this.#attempt?.companionNonce === companionNonce) {
            this.#attempt = null;
            this.#activation = null;
        }
    }
    /** Stop immediately rejects new metadata authority while preserving already admitted native effect correlation. */
    public stop(): void {
        this.#closed = true;
        this.#attempt = null;
        this.#activation = null;
    }
    /** The enclosing host joins these bounded consent reads alongside its native effects, not before stopping those effects. */
    public async join(): Promise<void> {
        await Promise.all(this.#checks);
    }
    /** The enclosing host calls this only after admitted effects and consent reads settled; no native ownership is released here. */
    public [Symbol.dispose](): void {
        this.stop();
        this.#owners[Symbol.dispose]();
    }

    async #consent(connection: Connection): Promise<void> {
        this.#connection(connection);
        if (this.#checks.size >= ConnectorHostObservationLimits.Entries) {
            throw new Error('Host observation consent capacity reached');
        }
        const finished: PromiseWithResolvers<undefined> = Promise.withResolvers<undefined>();
        this.#checks.add(finished.promise);
        try {
            const current: ConnectorHostLocalGrant | null = await ConnectorHostGrant.read(
                this.identity,
            );
            this.#connection(connection);
            if (
                current === null ||
                !current.profile.enabled ||
                ConnectorHostCodec.encode(current) !== ConnectorHostCodec.encode(this.grant)
            ) {
                throw new Error('Native observation consent is unavailable or changed');
            }
        } finally {
            this.#checks.delete(finished.promise);
            finished.resolve(undefined);
        }
    }
    #owned(owned: Owned, connection: Connection): void {
        this.#connection(connection);
        if (
            owned.permit.companionNonce !== this.#activation?.companionNonce ||
            owned.source.state().runtimeId !== this.#activation.runtimeId
        ) {
            throw new Error('Host observation companion or runtime changed');
        }
    }
    #current(connection: Pick<Connection, 'leaseId' | 'nowMs'>): void {
        const activation: Activation | null = this.#activation;
        const nowMs: bigint = BigInt(Date.now());
        if (
            activation === null ||
            activation.leaseId !== connection.leaseId ||
            activation.expiresAtMs <= nowMs ||
            !ConnectorClock.issued(activation.issuedAtMs, nowMs)
        ) {
            throw new HostOperationError(
                ConnectorHostErrorCode.AdmissionDenied,
                'Host observation companion is not authenticated',
                true,
            );
        }
    }
    #connection(connection: Connection): void {
        this.#active();
        this.#current(connection);
        if (
            this.#activation?.companionNonce !== connection.companionNonce ||
            this.options.runtime() !== this.#activation.runtimeId
        ) {
            throw new Error('Host observation companion or runtime changed');
        }
    }
    #at(connection: Connection): Connection {
        return { ...connection, nowMs: BigInt(Date.now()) };
    }
    #active(): void {
        if (this.#closed) {
            throw new Error('Host observation access is closed');
        }
        this.options.active();
    }
}
