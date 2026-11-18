// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

import { ConnectorClock } from '../protocol/ConnectorClock.js';
import type {
    HostReadObservationSource,
    HostReadObservationState,
} from '../host/HostReadObservation.js';
import type { HostReadObservationStart } from '../host/HostReadObservationStart.js';
import { SignaturePurpose } from 'nerva-connector-protocol/identity/IdentityFormat.js';
import {
    ConnectorHostOutcome,
    ConnectorHostTool,
    type ConnectorHostPermit,
    type ConnectorHostResponse,
    type ConnectorHostProfile,
} from 'nerva-connector-protocol/protocol/ConnectorHost.js';
import { ConnectorHostObservedStartCodec as Capture } from 'nerva-connector-protocol/protocol/ConnectorHostObservedStartCodec.js';
import type {
    ConnectorHostObservationCapture,
    ConnectorHostObservedArguments,
} from 'nerva-connector-protocol/protocol/ConnectorHostObservedStart.js';
import { ConnectorHostObservationCodec as Codec } from 'nerva-connector-protocol/protocol/ConnectorHostObservationCodec.js';
import { ConnectorHostObservationTranscript as Transcript } from 'nerva-connector-protocol/protocol/ConnectorHostObservationTranscript.js';
import {
    ConnectorHostObservationLimits as Limits,
    ConnectorHostObservationKind as Kind,
    type ConnectorHostObservationPermit as Permit,
    type ConnectorHostObservationOrigin as Origin,
} from 'nerva-connector-protocol/protocol/ConnectorHostObservation.js';
import { Boundary } from 'nerva-connector-protocol/protocol/Boundary.js';
import type { ConnectorClientIdentity } from './ConnectorClientConfiguration.js';
import type { ConnectorHostLocalGrant } from './ConnectorHostGrantTypes.js';
import { ConnectorHostProof } from './ConnectorHostProof.js';
import { HostOperationError } from '../host/HostOperationError.js';
import { ConnectorHostErrorCode } from 'nerva-connector-protocol/protocol/ConnectorHost.js';

/** The live connection supplies its already authenticated primary lease, not a value taken from the observation frame. */
export interface ConnectorHostObservationConnection {
    readonly leaseId: string;
    readonly companionNonce: string;
    readonly expiresAtMs: bigint;
    readonly nowMs: bigint;
}
/** A verified read permit borrows one exact actual native owner and cannot execute or clean up that owner. */
export interface ConnectorHostObservationOwned {
    readonly permit: Permit;
    readonly source: HostReadObservationSource;
    readonly instanceSha256: string;
}
/** Native arguments receive only the validated transport marker removed; the signed original stays unchanged. */
export interface ConnectorHostObservationPrepared extends ConnectorHostObservedArguments {
    readonly binding: HostReadObservationStart;
}

/** Start identity is retained independently from the single pending effect/last-receipt journal. */
interface ObservationEntry {
    readonly capture: ConnectorHostObservationCapture;
    readonly original: ObservationStartIdentity;
    readonly kind: Kind;
    processId: string | null;
    source: HostReadObservationSource | null;
    responseHash: string | null;
    accountSha256: string | null;
    generation: bigint;
    permitSha256: string | null;
}

/** Exact commitments retain correlation without copying executable argument or environment payloads per owner. */
interface ObservationStartIdentity extends Pick<
    ConnectorHostPermit,
    'enrollmentId' | 'journalId' | 'jobId' | 'sequence' | 'dispatchId' | 'requestHash'
> {}

/** Bounded start reservations precede factories and remain attached to their exact native owners across transport renewal. */
export class ConnectorHostObservationOwners implements Disposable {
    readonly #entries: Map<string, ObservationEntry> = new Map();
    #closed: boolean = false;
    /** The installed enrolled identity and approved local grant are trusted process configuration. */
    public constructor(
        public readonly identity: ConnectorClientIdentity,
        public readonly grant: ConnectorHostLocalGrant,
    ) {}

    /** Call only for a fresh journal-admitted, verified effect permit; repeated originals never create another reservation or process. */
    public prepare(original: ConnectorHostPermit): ConnectorHostObservationPrepared {
        this.#active();
        const prepared: ConnectorHostObservedArguments = Capture.strip(original.request);
        this.#prune();
        if (this.#entries.has(prepared.capture.observationId)) {
            throw new HostOperationError(
                ConnectorHostErrorCode.AlreadyExists,
                'Native observation reservation already exists',
                true,
            );
        }
        if (this.#entries.size >= Limits.Entries) {
            throw new HostOperationError(
                ConnectorHostErrorCode.ResourceLimit,
                'Native observation capacity is exhausted',
                true,
            );
        }
        const entry: ObservationEntry = {
            capture: Object.freeze({ ...prepared.capture }),
            original: Object.freeze({
                enrollmentId: original.enrollmentId,
                journalId: original.journalId,
                jobId: original.jobId,
                sequence: original.sequence,
                dispatchId: original.dispatchId,
                requestHash: original.requestHash,
            }),
            kind: Capture.kind(original.request.toolName),
            processId: null,
            source: null,
            responseHash: null,
            accountSha256: null,
            generation: 0n,
            permitSha256: null,
        };
        this.#entries.set(entry.capture.observationId, entry);
        return {
            ...prepared,
            binding: Object.freeze({
                reserve: (processId: string): void => {
                    this.#active();
                    if (
                        entry.processId !== null ||
                        this.#entries.get(entry.capture.observationId) !== entry
                    ) {
                        throw new Error('Native observation reservation changed before creation');
                    }
                    entry.processId = Boundary.id(processId);
                },
                created: (source: HostReadObservationSource): void => {
                    this.#active();
                    const state: HostReadObservationState = source.state();
                    if (
                        entry.source !== null ||
                        entry.processId !== state.processId ||
                        state.kind !== entry.kind ||
                        this.#entries.get(entry.capture.observationId) !== entry
                    ) {
                        throw new Error('Native observation owner differs from its reserved start');
                    }
                    entry.source = source;
                },
            }),
        };
    }

    /** Completion seals only this start's actual returned owner; uncertain native effects remain unresolved and consume their reservation. */
    public complete(original: ConnectorHostPermit, response: ConnectorHostResponse): void {
        const capture: ConnectorHostObservationCapture | null = Capture.read(original.request);
        if (capture === null) {
            return;
        }
        const entry: ObservationEntry | undefined = this.#entries.get(capture.observationId);
        if (entry === undefined || !this.#same(entry.original, original)) {
            throw new Error('Native observation completion has no exact start');
        }
        if (response.outcome === ConnectorHostOutcome.Failed) {
            if (entry.source === null || !this.#available(entry.source)) {
                this.#entries.delete(capture.observationId);
            }
            return;
        }
        if (response.outcome !== ConnectorHostOutcome.Succeeded) {
            return;
        }
        if (response.resultJson === null || entry.source === null) {
            throw new Error('Successful observed start has no native owner');
        }
        const raw: unknown = JSON.parse(response.resultJson);
        if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
            throw new Error('Observed start response is not a native snapshot');
        }
        const processId: unknown = Reflect.get(raw, 'processId');
        if (
            typeof processId !== 'string' ||
            processId !== entry.processId ||
            processId !== entry.source.state().processId
        ) {
            throw new Error('Observed start response differs from the actual owner');
        }
        const responseHash: string = ConnectorHostProof.responseHash(response);
        if (entry.responseHash !== null && entry.responseHash !== responseHash) {
            throw new Error('Observed start result commitment changed');
        }
        entry.responseHash = responseHash;
    }

    /** Current consent must be checked separately by the host owner before invoking this signature and exact source verifier. */
    public authorize(
        raw: unknown,
        connection: ConnectorHostObservationConnection,
        profile: ConnectorHostProfile,
    ): ConnectorHostObservationOwned {
        this.#active();
        const permit: Permit = Codec.permit(raw);
        if (
            !ConnectorHostProof.verify(
                this.identity.authority.publicKey,
                SignaturePurpose.HostObservationPermit,
                Buffer.from(Transcript.permit(permit)),
                permit.signature,
            )
        ) {
            throw new Error('Native observation permit signature denied');
        }
        const entry: ObservationEntry = this.#entry(permit, connection, profile);
        const source: HostReadObservationSource | null = entry.source;
        if (source === null) {
            throw new Error('Native observation owner unavailable');
        }
        const state: HostReadObservationState = source.state();
        const instanceSha256: string = this.#instance(permit.origin, state.runtimeId);
        const digest: string = ConnectorHostProof.digest(Transcript.permit(permit));
        if (
            permit.generation < entry.generation ||
            (permit.generation === entry.generation && digest !== entry.permitSha256) ||
            (entry.generation > 0n &&
                permit.generation > entry.generation &&
                permit.runtimeId === null) ||
            (permit.runtimeId !== null &&
                (permit.runtimeId !== state.runtimeId || permit.instanceSha256 !== instanceSha256))
        ) {
            throw new Error('Native observation generation or instance changed');
        }
        entry.accountSha256 ??= permit.origin.accountSha256;
        entry.generation = permit.generation;
        entry.permitSha256 = digest;
        return Object.freeze({
            permit: Object.freeze({ ...permit, origin: Object.freeze({ ...permit.origin }) }),
            source,
            instanceSha256,
        });
    }

    /** Cached crypto never caches revocation, expiry, native lifetime or a replacement observation generation. */
    public current(
        owned: ConnectorHostObservationOwned,
        connection: ConnectorHostObservationConnection,
        profile: ConnectorHostProfile,
    ): void {
        const entry: ObservationEntry = this.#entry(owned.permit, connection, profile);
        if (
            entry.source !== owned.source ||
            entry.generation !== owned.permit.generation ||
            owned.instanceSha256 !==
                this.#instance(owned.permit.origin, owned.source.state().runtimeId) ||
            entry.permitSha256 !== ConnectorHostProof.digest(Transcript.permit(owned.permit))
        ) {
            throw new Error('Native observation witness is no longer current');
        }
    }

    /** Metadata shutdown neither kills a native process nor claims that its effects or output were completed. */
    public [Symbol.dispose](): void {
        this.#closed = true;
        this.#entries.clear();
    }

    #entry(
        permit: Permit,
        connection: ConnectorHostObservationConnection,
        profile: ConnectorHostProfile,
    ): ObservationEntry {
        this.#active();
        const entry: ObservationEntry | undefined = this.#entries.get(permit.observationId);
        const origin: Origin = permit.origin;
        const read: ConnectorHostTool =
            origin.kind === Kind.Process
                ? ConnectorHostTool.ProcessRead
                : ConnectorHostTool.TerminalRead;
        if (
            entry === undefined ||
            entry.source === null ||
            entry.responseHash === null ||
            permit.authorityId !== this.identity.settings.authorityId ||
            permit.leaseId !== connection.leaseId ||
            permit.companionNonce !== connection.companionNonce ||
            !ConnectorClock.issued(permit.issuedAtMs, connection.nowMs) ||
            permit.expiresAtMs <= connection.nowMs ||
            permit.expiresAtMs > connection.expiresAtMs ||
            !profile.enabled ||
            !this.grant.profile.enabled ||
            !this.grant.profile.tools.includes(read) ||
            profile.grantId !== this.grant.profile.grantId ||
            profile.grantRevision !== this.grant.profile.grantRevision ||
            !profile.tools.includes(read) ||
            origin.enrollmentId !== this.grant.enrollmentId ||
            origin.environmentId !== this.grant.environmentId ||
            origin.journalId !== this.grant.journalId ||
            origin.grantId !== profile.grantId ||
            origin.grantRevision !== profile.grantRevision ||
            origin.ownerSha256 !== entry.capture.ownerSha256 ||
            origin.providerSha256 !== entry.capture.providerSha256 ||
            (entry.accountSha256 !== null && entry.accountSha256 !== origin.accountSha256) ||
            origin.startJobId !== entry.original.jobId ||
            origin.startSequence !== entry.original.sequence ||
            origin.startDispatchId !== entry.original.dispatchId ||
            origin.startRequestHash !== entry.original.requestHash ||
            origin.startResponseHash !== entry.responseHash ||
            origin.processId !== entry.processId ||
            origin.kind !== entry.kind ||
            permit.originSha256 !== ConnectorHostProof.digest(Transcript.origin(origin))
        ) {
            throw new Error('Native observation origin, consent or lease denied');
        }
        const state: HostReadObservationState = entry.source.state();
        if (state.processId !== origin.processId || state.kind !== origin.kind) {
            throw new Error('Native observation owner identity changed');
        }
        return entry;
    }
    #instance(origin: Origin, runtimeId: string): string {
        return ConnectorHostProof.digest(
            Transcript.instance(
                ConnectorHostProof.digest(Transcript.origin(origin)),
                runtimeId,
                origin.processId,
                origin.kind,
            ),
        );
    }
    #same(left: ObservationStartIdentity, right: ObservationStartIdentity): boolean {
        return (
            left.enrollmentId === right.enrollmentId &&
            left.journalId === right.journalId &&
            left.jobId === right.jobId &&
            left.sequence === right.sequence &&
            left.dispatchId === right.dispatchId &&
            left.requestHash === right.requestHash
        );
    }
    #available(source: HostReadObservationSource): boolean {
        try {
            source.state();
            return true;
        } catch {
            return false;
        }
    }
    #prune(): void {
        for (const [id, entry] of this.#entries) {
            if (entry.source !== null && !this.#available(entry.source)) {
                this.#entries.delete(id);
            }
        }
    }
    #active(): void {
        if (this.#closed) {
            throw new Error('Native observation owner is closed');
        }
    }
}
