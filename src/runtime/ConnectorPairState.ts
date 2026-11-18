// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

import { IdentityLengths } from 'nerva-connector-protocol/identity/IdentityFormat.js';
import { ConnectorLogout } from './ConnectorLogout.js';
import { createHash, randomBytes } from 'node:crypto';
import { SigningKey } from '../identity/SigningKey.js';
import { SignaturePurpose } from 'nerva-connector-protocol/identity/IdentityFormat.js';
import { Boundary } from 'nerva-connector-protocol/protocol/Boundary.js';
import { ConnectorEnrollmentCodec } from 'nerva-connector-protocol/protocol/ConnectorEnrollmentCodec.js';
import { ConnectorLinkCodec } from 'nerva-connector-protocol/protocol/ConnectorLinkCodec.js';
import {
    ConnectorLinkPhase,
    type ConnectorLinkIssued,
    type ConnectorLinkStatus,
} from 'nerva-connector-protocol/protocol/ConnectorLink.js';
import type { ConnectorDeviceIdentity } from './ConnectorDeviceKey.js';
import {
    ConnectorPrivateDirectory,
    ConnectorDirectoryPurpose,
} from './ConnectorPrivateDirectory.js';

/** Only completed durable configuration can publish a normal enrolled transport configuration. */
export enum ConnectorPairPhase {
    Authorizing = 'authorizing',
    Registered = 'registered',
    Configured = 'configured',
    Expired = 'expired',
    Revoked = 'revoked',
    Denied = 'denied',
}
/** Constant-size signed commitment preserves the previous attempt without retaining duplicate state files. */
export interface ConnectorPairRenewal {
    readonly revision: bigint;
    readonly previousStateSha256: string;
}
/** Signed local history binds one device key, private request ID and reviewed deployment configuration. */
export interface ConnectorPairSnapshot {
    readonly requestId: string;
    readonly publicKey: string;
    readonly configurationSha256: string;
    readonly phase: ConnectorPairPhase;
    readonly issued: ConnectorLinkIssued | null;
    readonly enrollmentId: string | null;
    readonly environmentId: string | null;
    readonly renewal: ConnectorPairRenewal | null;
}

/** Exclusive signed state prevents a restart or malformed local file from silently creating another identity or resetting a file journal. */
export class ConnectorPairState implements AsyncDisposable {
    #snapshot: ConnectorPairSnapshot;
    private constructor(
        public readonly directory: ConnectorPrivateDirectory,
        public readonly identity: ConnectorDeviceIdentity,
        public readonly configurationSha256: string,
        snapshot: ConnectorPairSnapshot,
    ) {
        Object.freeze(snapshot.renewal);
        this.#snapshot = Object.freeze(snapshot);
    }
    /** Callers observe immutable captured state rather than changing binding fields in place. */
    public get snapshot(): ConnectorPairSnapshot {
        return this.#snapshot;
    }
    /** Only an absent first-install state is initialized; existing corrupt or differently bound state is rejected. */
    public static async open(
        path: string,
        identity: ConnectorDeviceIdentity,
        configurationSha256: string,
    ): Promise<ConnectorPairState> {
        const directory: ConnectorPrivateDirectory = await ConnectorPrivateDirectory.open(
            path,
            ConnectorDirectoryPurpose.Pairing,
        );
        try {
            await ConnectorLogout.requireActive(path);
            await directory.cleanPartial('pairing-state', 16384);
            await directory.cleanPartial('device.json', 16384);
            const initial: ConnectorPairSnapshot = {
                requestId: randomBytes(32).toString('base64url'),
                publicKey: identity.publicKey,
                configurationSha256,
                phase: ConnectorPairPhase.Authorizing,
                issued: null,
                enrollmentId: null,
                environmentId: null,
                renewal: null,
            };
            const owner: ConnectorPairState = new ConnectorPairState(
                directory,
                identity,
                configurationSha256,
                initial,
            );
            if (await directory.exists('pairing-state')) {
                const previous: ConnectorPairSnapshot = await owner.#read();
                Object.freeze(previous.issued);
                Object.freeze(previous.renewal);
                owner.#snapshot = Object.freeze(previous);
            } else {
                if (await directory.exists('device.json')) {
                    throw new Error(
                        'Published connector configuration has lost its pairing history',
                    );
                }
                await owner.write(initial, true);
            }
            return owner;
        } catch (caught: unknown) {
            await directory[Symbol.asyncDispose]();
            throw caught;
        }
    }
    /** Captured binding fields cannot change during a lifecycle transition. */
    public async write(
        snapshot: ConnectorPairSnapshot,
        initialize: boolean = false,
    ): Promise<void> {
        if (
            snapshot.requestId !== this.snapshot.requestId ||
            snapshot.publicKey !== this.identity.publicKey ||
            snapshot.configurationSha256 !== this.configurationSha256 ||
            snapshot.renewal?.revision !== this.snapshot.renewal?.revision ||
            snapshot.renewal?.previousStateSha256 !== this.snapshot.renewal?.previousStateSha256
        ) {
            throw new Error('Connector pairing identity changed');
        }
        if (
            !Object.values(ConnectorPairPhase).includes(snapshot.phase) ||
            (snapshot.phase === ConnectorPairPhase.Registered ||
                snapshot.phase === ConnectorPairPhase.Configured ||
                snapshot.phase === ConnectorPairPhase.Revoked) !==
                (snapshot.enrollmentId !== null) ||
            (snapshot.enrollmentId === null) !== (snapshot.environmentId === null) ||
            (snapshot.environmentId !== null &&
                Boundary.id(snapshot.environmentId) !== snapshot.environmentId) ||
            (snapshot.enrollmentId !== null &&
                ConnectorEnrollmentCodec.id(snapshot.enrollmentId) !== snapshot.enrollmentId) ||
            (snapshot.issued !== null &&
                snapshot.issued.linkId !==
                    createHash('sha256')
                        .update(Buffer.from(snapshot.requestId, 'base64url'))
                        .digest('hex'))
        ) {
            throw new Error('Inconsistent connector pairing state');
        }
        if (!initialize) {
            const previous: ConnectorPairPhase = this.snapshot.phase;
            const next: ConnectorPairPhase = snapshot.phase;
            if (
                (this.snapshot.enrollmentId !== null &&
                    snapshot.enrollmentId !== this.snapshot.enrollmentId) ||
                (this.snapshot.environmentId !== null &&
                    snapshot.environmentId !== this.snapshot.environmentId) ||
                (this.snapshot.issued !== null &&
                    JSON.stringify(this.snapshot.issued, (_key: string, value: unknown): unknown =>
                        typeof value === 'bigint' ? value.toString() : value,
                    ) !==
                        JSON.stringify(snapshot.issued, (_key: string, value: unknown): unknown =>
                            typeof value === 'bigint' ? value.toString() : value,
                        )) ||
                !(
                    next === previous ||
                    (previous === ConnectorPairPhase.Authorizing &&
                        (next === ConnectorPairPhase.Registered ||
                            next === ConnectorPairPhase.Expired ||
                            next === ConnectorPairPhase.Denied ||
                            next === ConnectorPairPhase.Revoked)) ||
                    (previous === ConnectorPairPhase.Registered &&
                        (next === ConnectorPairPhase.Configured ||
                            next === ConnectorPairPhase.Revoked)) ||
                    (previous === ConnectorPairPhase.Configured &&
                        next === ConnectorPairPhase.Revoked) ||
                    (previous === ConnectorPairPhase.Expired &&
                        (next === ConnectorPairPhase.Registered ||
                            next === ConnectorPairPhase.Denied ||
                            next === ConnectorPairPhase.Revoked))
                )
            ) {
                throw new Error('Connector pairing history cannot be rewound');
            }
        }
        await this.#commit(snapshot, initialize);
    }
    /** Only a fresh verified original poll may retire an expired unbound request; it cannot reset approved/revoked identity or native history. */
    public async renewExpired(status: ConnectorLinkStatus): Promise<void> {
        const previous: ConnectorPairSnapshot = this.snapshot;
        if (
            previous.phase !== ConnectorPairPhase.Expired ||
            previous.enrollmentId !== null ||
            previous.environmentId !== null ||
            status.enrollment !== null ||
            status.publicKey !== previous.publicKey ||
            status.linkId !==
                createHash('sha256')
                    .update(Buffer.from(previous.requestId, 'base64url'))
                    .digest('hex') ||
            !(
                status.phase === ConnectorLinkPhase.Expired ||
                (status.phase === ConnectorLinkPhase.Unregistered && previous.issued !== null)
            ) ||
            (await this.directory.exists('device.json'))
        ) {
            throw new Error('Only a confirmed expired unbound pairing can renew');
        }
        const revision: bigint = (previous.renewal?.revision ?? 0n) + 1n;
        if (revision > 18446744073709551615n) {
            throw new Error('Pairing renewal counter exhausted');
        }
        await this.#commit(
            {
                ...previous,
                requestId: randomBytes(32).toString('base64url'),
                phase: ConnectorPairPhase.Authorizing,
                issued: null,
                renewal: {
                    revision,
                    previousStateSha256: createHash('sha256')
                        .update(this.#encode(previous))
                        .digest('hex'),
                },
            },
            false,
        );
    }
    async #commit(snapshot: ConnectorPairSnapshot, initialize: boolean): Promise<void> {
        const state: string = this.#encode(snapshot);
        const signature: string = this.identity.key.sign(
            SignaturePurpose.PairingState,
            this.#payload(state),
        );
        const payload: Buffer = Buffer.from(
            '{"state":' + state + ',"signature":' + JSON.stringify(signature) + '}',
        );
        try {
            await this.directory.write('pairing-state', payload, 16384, initialize);
        } finally {
            payload.fill(0);
        }
        Object.freeze(snapshot.issued);
        Object.freeze(snapshot.renewal);
        this.#snapshot = Object.freeze(snapshot);
    }
    /** A normal runtime configuration is immutable and never becomes an implicit policy update on retry. */
    public async publishConfiguration(bytes: Buffer): Promise<void> {
        if (this.snapshot.phase !== ConnectorPairPhase.Configured) {
            throw new Error('Connector configuration is not durably ready');
        }
        if (await this.directory.exists('device.json')) {
            const previous: Buffer = await this.directory.read('device.json', 16384);
            if (!previous.equals(bytes)) {
                throw new Error(
                    'Existing connector configuration differs from the paired deployment',
                );
            }
        } else {
            await this.directory.write('device.json', bytes, 16384, true);
        }
    }
    /** Private request entropy never leaves the owned state except inside signed TLS requests. */
    public async [Symbol.asyncDispose](): Promise<void> {
        await this.directory[Symbol.asyncDispose]();
    }
    async #read(): Promise<ConnectorPairSnapshot> {
        const bytes: Buffer = await this.directory.read('pairing-state', 16384);
        let raw: unknown;
        try {
            raw = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
        } finally {
            bytes.fill(0);
        }
        const envelope: Readonly<Record<string, unknown>> = Boundary.record(raw, [
            'state',
            'signature',
        ]);
        const value: Readonly<Record<string, unknown>> = Boundary.record(envelope['state'], [
            'requestId',
            'publicKey',
            'configurationSha256',
            'phase',
            'issued',
            'enrollmentId',
            'environmentId',
            'renewal',
        ]);
        const phase: ConnectorPairPhase | undefined = Object.values(ConnectorPairPhase).find(
            (entry: ConnectorPairPhase): boolean => entry === value['phase'],
        );
        if (phase === undefined) {
            throw new Error('Invalid connector pairing phase');
        }
        const snapshot: ConnectorPairSnapshot = {
            requestId: ConnectorEnrollmentCodec.binary(value['requestId'], 32),
            publicKey: ConnectorEnrollmentCodec.binary(
                value['publicKey'],
                IdentityLengths.publicKey,
            ),
            configurationSha256: ConnectorEnrollmentCodec.digest(value['configurationSha256']),
            phase,
            issued: value['issued'] === null ? null : ConnectorLinkCodec.issued(value['issued']),
            environmentId:
                value['environmentId'] === null ? null : Boundary.id(value['environmentId']),
            enrollmentId:
                value['enrollmentId'] === null
                    ? null
                    : ConnectorEnrollmentCodec.id(value['enrollmentId']),
            renewal: this.#renewal(value['renewal']),
        };
        if (
            snapshot.publicKey !== this.identity.publicKey ||
            snapshot.configurationSha256 !== this.configurationSha256 ||
            (snapshot.issued !== null &&
                snapshot.issued.linkId !==
                    createHash('sha256')
                        .update(Buffer.from(snapshot.requestId, 'base64url'))
                        .digest('hex')) ||
            (snapshot.phase === ConnectorPairPhase.Registered ||
                snapshot.phase === ConnectorPairPhase.Configured ||
                snapshot.phase === ConnectorPairPhase.Revoked) !==
                (snapshot.enrollmentId !== null) ||
            (snapshot.enrollmentId === null) !== (snapshot.environmentId === null) ||
            (snapshot.environmentId !== null &&
                Boundary.id(snapshot.environmentId) !== snapshot.environmentId) ||
            !SigningKey.verify(
                SignaturePurpose.PairingState,
                this.identity.publicKey,
                this.#payload(this.#encode(snapshot)),
                ConnectorEnrollmentCodec.binary(envelope['signature'], IdentityLengths.signature),
            )
        ) {
            throw new Error('Connector pairing history does not match its device or deployment');
        }
        return snapshot;
    }
    #encode(snapshot: ConnectorPairSnapshot): string {
        return JSON.stringify(
            {
                requestId: snapshot.requestId,
                publicKey: snapshot.publicKey,
                configurationSha256: snapshot.configurationSha256,
                phase: snapshot.phase,
                issued: snapshot.issued,
                enrollmentId: snapshot.enrollmentId,
                environmentId: snapshot.environmentId,
                renewal: snapshot.renewal,
            },
            (_key: string, value: unknown): unknown =>
                typeof value === 'bigint' ? value.toString() : value,
        );
    }
    #payload(state: string): Buffer {
        return Buffer.from(
            JSON.stringify(['nerva-connector:pairing-state', this.directory.directory, state]),
        );
    }
    #renewal(raw: unknown): ConnectorPairRenewal | null {
        if (raw === null) {
            return null;
        }
        const value: Readonly<Record<string, unknown>> = Boundary.record(raw, [
            'revision',
            'previousStateSha256',
        ]);
        const revision: bigint = Boundary.integer(value['revision']);
        if (revision === 0n || revision > 18446744073709551615n) {
            throw new Error('Invalid pairing renewal counter');
        }
        return {
            revision,
            previousStateSha256: ConnectorEnrollmentCodec.digest(value['previousStateSha256']),
        };
    }
}
