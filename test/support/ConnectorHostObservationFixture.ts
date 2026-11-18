// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

import { randomBytes } from 'node:crypto';
import { ConnectorHostFixture } from './ConnectorHostFixture.js';
import { ConnectorClientHost } from '../../src/runtime/ConnectorClientHost.js';
import { ConnectorHostProof as Proof } from '../../src/runtime/ConnectorHostProof.js';
import { ConnectorHostObservationCapabilityProof } from '../../src/runtime/ConnectorHostObservationCapabilityProof.js';
import { ConnectorHostObservationCapabilityTranscript } from 'nerva-connector-protocol/protocol/ConnectorHostObservationCapabilityTranscript.js';
import { type ConnectorHostObservationCapture } from 'nerva-connector-protocol/protocol/ConnectorHostObservedStart.js';
import { ConnectorHostObservedStart as Start } from 'nerva-connector-protocol/protocol/ConnectorHostObservationProtocol.js';
import {
    ConnectorHostObservationKind,
    type ConnectorHostObservationOrigin,
    type ConnectorHostObservationPermit as Permit,
    type ConnectorHostObservationChanged as Changed,
    type ConnectorHostObservationAcknowledgment as Ack,
} from 'nerva-connector-protocol/protocol/ConnectorHostObservation.js';
import { ConnectorHostObservationTranscript as Transcript } from 'nerva-connector-protocol/protocol/ConnectorHostObservationTranscript.js';
import type { ConnectorHostObservationActivation } from 'nerva-connector-protocol/protocol/ConnectorHostObservationCapability.js';
import type { ConnectorHostObservationConnection } from '../../src/runtime/ConnectorHostObservationOwners.js';
import {
    ConnectorHostTool,
    ConnectorHostOutcome,
    type ConnectorHostPermit,
    type ConnectorHostCompletion,
} from 'nerva-connector-protocol/protocol/ConnectorHost.js';
import type { ConnectorHostLocalGrant } from '../../src/runtime/ConnectorHostGrantTypes.js';
import { SignaturePurpose } from 'nerva-connector-protocol/identity/IdentityFormat.js';
import { Boundary } from 'nerva-connector-protocol/protocol/Boundary.js';

/** A real local process and hybrid proofs exercise metadata ownership without account APIs, sockets, production grants or live user devices. */
export class ConnectorHostObservationFixture implements AsyncDisposable {
    #sequence: bigint = 1n;
    private constructor(
        public readonly base: ConnectorHostFixture,
        public readonly host: ConnectorClientHost,
        public readonly grant: ConnectorHostLocalGrant,
        public readonly capture: ConnectorHostObservationCapture,
        public readonly connection: ConnectorHostObservationConnection,
        public readonly original: ConnectorHostPermit,
        public readonly completion: ConnectorHostCompletion,
        public readonly processId: string,
    ) {}
    /** The fixture explicitly installs only an isolated local grant and signs the private activation before its single native start. */
    public static async create(
        program: string = "process.stdin.on('data', b => process.stdout.write(b));",
    ): Promise<ConnectorHostObservationFixture> {
        const base: ConnectorHostFixture = await ConnectorHostFixture.create();
        let host: ConnectorClientHost | null = null;
        try {
            const grant: ConnectorHostLocalGrant = await base.grant();
            host = await ConnectorClientHost.load(base.identity, Start.Protocol);
            if (host === null) {
                throw new Error('Fixture grant required');
            }
            const connection: ConnectorHostObservationConnection = {
                leaseId: randomBytes(32).toString('base64url'),
                companionNonce: randomBytes(32).toString('base64url'),
                nowMs: BigInt(Date.now()),
                expiresAtMs: BigInt(Date.now()) + 20000n,
            };
            this.#activate(base, host, grant, connection);
            const capture: ConnectorHostObservationCapture = {
                protocol: Start.Protocol,
                observationId: randomBytes(32).toString('base64url'),
                ownerSha256: '1'.repeat(64),
                providerSha256: '2'.repeat(64),
                originalId: '3'.repeat(64),
            };
            const original: ConnectorHostPermit = base.permit(
                grant,
                1n,
                ConnectorHostTool.ProcessStart,
                JSON.stringify({
                    executable: process.execPath,
                    arguments: ['-e', program],
                    timeoutMs: 20000,
                    [Start.Field]: capture,
                }),
                connection.leaseId,
            );
            const completion: ConnectorHostCompletion = await host.execute(
                original,
                connection.leaseId,
                connection.expiresAtMs,
            );
            if (completion.response.outcome !== ConnectorHostOutcome.Succeeded) {
                throw new Error('Observed fixture start failed');
            }
            await host.acknowledge(base.acknowledgment(completion), connection.leaseId);
            const raw: unknown = JSON.parse(completion.response.resultJson ?? 'null');
            if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
                throw new Error('Fixture native snapshot required');
            }
            const processId: unknown = Reflect.get(raw, 'processId');
            return new ConnectorHostObservationFixture(
                base,
                host,
                grant,
                capture,
                connection,
                original,
                completion,
                Boundary.id(processId),
            );
        } catch (error: unknown) {
            try {
                await host?.[Symbol.asyncDispose]();
            } finally {
                await base[Symbol.asyncDispose]();
            }
            throw error;
        }
    }
    /** A replacement metadata attempt authenticates the same native owner without launching or reattaching a process. */
    public activate(connection: ConnectorHostObservationConnection): void {
        ConnectorHostObservationFixture.#activate(this.base, this.host, this.grant, connection);
    }
    static #activate(
        base: ConnectorHostFixture,
        host: ConnectorClientHost,
        grant: ConnectorHostLocalGrant,
        connection: ConnectorHostObservationConnection,
    ): void {
        const capability: ReturnType<ConnectorClientHost['observationCapability']> =
            host.observationCapability(connection.companionNonce, connection);
        const body: Omit<ConnectorHostObservationActivation, 'signature'> = {
            authorityId: base.identity.settings.authorityId,
            enrollmentId: grant.enrollmentId,
            leaseId: connection.leaseId,
            journalId: grant.journalId,
            companionNonce: connection.companionNonce,
            runtimeId: capability.runtimeId,
            publicationSha256: ConnectorHostObservationCapabilityProof.publicationSha256(
                capability.publication,
            ),
            issuedAtMs: connection.nowMs,
            expiresAtMs: connection.expiresAtMs,
        };
        const activation: ConnectorHostObservationActivation = {
            ...body,
            signature: base.peer.authority.sign(
                SignaturePurpose.HostObservationPermit,
                Buffer.from(ConnectorHostObservationCapabilityTranscript.activation(body)),
            ),
        };
        host.activateObservation(
            JSON.parse(Transcript.encode(activation)),
            connection.companionNonce,
            connection,
        );
    }
    /** A current private permit can renew only the same origin and optional already pinned native instance. */
    public permit(changes: Partial<Omit<Permit, 'signature'>> = {}): Permit {
        const origin: ConnectorHostObservationOrigin = {
            accountSha256: '4'.repeat(64),
            ownerSha256: this.capture.ownerSha256,
            providerSha256: this.capture.providerSha256,
            environmentId: this.grant.environmentId,
            enrollmentId: this.grant.enrollmentId,
            journalId: this.grant.journalId,
            grantId: this.grant.profile.grantId,
            grantRevision: this.grant.profile.grantRevision,
            startJobId: this.original.jobId,
            startSequence: this.original.sequence,
            startDispatchId: this.original.dispatchId,
            startRequestHash: this.original.requestHash,
            startResponseHash: this.completion.responseHash,
            processId: this.processId,
            kind: ConnectorHostObservationKind.Process,
        };
        const body: Omit<Permit, 'signature'> = {
            authorityId: this.grant.authorityId,
            leaseId: this.connection.leaseId,
            companionNonce: this.connection.companionNonce,
            observationId: this.capture.observationId,
            generation: 1n,
            origin,
            originSha256: Proof.digest(Transcript.origin(origin)),
            runtimeId: null,
            instanceSha256: null,
            issuedAtMs: BigInt(Date.now()),
            expiresAtMs: this.connection.expiresAtMs,
            ...changes,
        };
        return {
            ...body,
            signature: this.base.peer.authority.sign(
                SignaturePurpose.HostObservationPermit,
                Buffer.from(Transcript.permit(body)),
            ),
        };
    }
    /** Acknowledgment proves the exact already committed metadata batch, without any native input or cleanup authority. */
    public acknowledgment(changed: Changed): Ack {
        const body: Omit<Ack, 'signature'> = {
            authorityId: this.grant.authorityId,
            enrollmentId: changed.enrollmentId,
            leaseId: changed.leaseId,
            companionNonce: changed.companionNonce,
            journalId: changed.journalId,
            runtimeId: changed.runtimeId,
            batchRevision: changed.batchRevision,
            batchSha256: Proof.digest(Transcript.changed(changed)),
            changes: changed.changes.map((entry): Ack['changes'][number] => ({
                observationId: entry.observationId,
                generation: entry.generation,
                revision: entry.revision,
            })),
        };
        return {
            ...body,
            signature: this.base.peer.authority.sign(
                SignaturePurpose.HostObservationAcknowledgment,
                Buffer.from(Transcript.acknowledgment(body)),
            ),
        };
    }
    /** Ordinary exact effect originals remain independent from observation waiting and its metadata queue. */
    public async call(tool: ConnectorHostTool, args: string): Promise<ConnectorHostCompletion> {
        const permit: ConnectorHostPermit = this.base.permit(
            this.grant,
            ++this.#sequence,
            tool,
            args,
            this.connection.leaseId,
        );
        const completion: ConnectorHostCompletion = await this.host.execute(
            permit,
            this.connection.leaseId,
            this.connection.expiresAtMs,
        );
        await this.host.acknowledge(this.base.acknowledgment(completion), this.connection.leaseId);
        return completion;
    }
    /** The runtime is stopped and its protected temporary tree removed even after a negative assertion. */
    public async [Symbol.asyncDispose](): Promise<void> {
        try {
            await this.host[Symbol.asyncDispose]();
        } finally {
            await this.base[Symbol.asyncDispose]();
        }
    }
}
