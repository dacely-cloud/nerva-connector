// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

import { performance } from 'node:perf_hooks';
import { SignaturePurpose } from 'nerva-connector-protocol/identity/IdentityFormat.js';
import { ConnectorHostObservationCodec as Codec } from 'nerva-connector-protocol/protocol/ConnectorHostObservationCodec.js';
import { ConnectorHostObservationTranscript as Transcript } from 'nerva-connector-protocol/protocol/ConnectorHostObservationTranscript.js';
import {
    ConnectorHostObservationLimits as Limits,
    type ConnectorHostObservationPermit as Permit,
    type ConnectorHostObservationReady as Ready,
    type ConnectorHostObservationChanged as Changed,
    type ConnectorHostObservationChange as Change,
    type ConnectorHostObservationAcknowledgment as Ack,
} from 'nerva-connector-protocol/protocol/ConnectorHostObservation.js';
import type { ConnectorClientHost } from './ConnectorClientHost.js';
import type {
    ConnectorHostObservationConnection as Connection,
    ConnectorHostObservationOwned as Owned,
} from './ConnectorHostObservationOwners.js';
import { ConnectorHostProof } from './ConnectorHostProof.js';

/** The negotiated side socket supplies bounded writes; failure closes only metadata transport. */
export interface ConnectorHostObservationSink {
    ready(value: Ready): void;
    changed(value: Changed): void;
    failed(): void;
}
/** One current signed read generation retains no process bytes and owns exactly one local version waiter. */
interface ObservationSlot {
    readonly owned: Owned;
    readonly ready: Ready;
    readonly permitJson: string;
    readonly stop: AbortController;
    revision: bigint;
    acknowledged: bigint;
}

/** A companion delivers signed coalesced hints outside the effect lane; actual reads, input, EOF and cleanup retain their original APIs. */
export class ConnectorHostObservationDelivery implements AsyncDisposable {
    readonly #slots: Map<string, ObservationSlot> = new Map();
    readonly #permits: Permit[] = [];
    readonly #tasks: Set<Promise<void>> = new Set();
    readonly #stop: AbortController = new AbortController();
    readonly #expiry: NodeJS.Timeout;
    #timer: NodeJS.Timeout | undefined;
    #running: boolean = false;
    #flushRequested: boolean = false;
    #pending: Changed | null = null;
    #runtimeId: string | null = null;
    #batchRevision: bigint = 0n;
    #tokens: number = 64;
    #refilledAt: number = performance.now();
    #closed: boolean = false;

    /** The caller has already verified Activation on this exact primary lease, companion nonce and native runtime. */
    public constructor(
        public readonly host: ConnectorClientHost,
        public readonly connection: Connection,
        public readonly sink: ConnectorHostObservationSink,
    ) {
        const remaining: bigint = connection.expiresAtMs - BigInt(Date.now());
        if (remaining <= 0n || remaining > Limits.PermitMs) {
            throw new Error('Invalid host observation companion lifetime');
        }
        this.#expiry = setTimeout((): void => this.#fail(), Number(remaining));
    }

    /** Only closed wire permits enter the bounded metadata queue; input or process effects never wait on it. */
    public permit(raw: unknown): void {
        try {
            this.#admit();
            const permit: Permit = Codec.permit(raw);
            if (
                permit.leaseId !== this.connection.leaseId ||
                permit.companionNonce !== this.connection.companionNonce ||
                this.#permits.length >= Limits.Entries
            ) {
                throw new Error('Host observation permit queue denied');
            }
            this.#permits.push(
                Object.freeze({ ...permit, origin: Object.freeze({ ...permit.origin }) }),
            );
            this.#pump();
        } catch {
            this.#fail();
        }
    }

    /** Only an exact authority-signed outstanding batch advances delivery; stale valid ACKs never advance anything. */
    public acknowledge(raw: unknown): void {
        try {
            this.#admit();
            const ack: Ack = Codec.acknowledgment(raw);
            if (
                ack.authorityId !== this.host.identity.settings.authorityId ||
                ack.enrollmentId !== this.host.grant.enrollmentId ||
                ack.journalId !== this.host.grant.journalId ||
                ack.leaseId !== this.connection.leaseId ||
                ack.companionNonce !== this.connection.companionNonce ||
                ack.runtimeId !== this.#runtimeId ||
                !ConnectorHostProof.verify(
                    this.host.identity.authority.publicKey,
                    SignaturePurpose.HostObservationAcknowledgment,
                    Buffer.from(Transcript.acknowledgment(ack)),
                    ack.signature,
                )
            ) {
                throw new Error('Host observation acknowledgment denied');
            }
            const pending: Changed | null = this.#pending;
            if (pending === null || ack.batchRevision < pending.batchRevision) {
                if (ack.batchRevision > this.#batchRevision) {
                    throw new Error('Unknown future host observation acknowledgment');
                }
                return;
            }
            const rows: readonly Ack['changes'][number][] = pending.changes.map(
                (item: Change): Ack['changes'][number] => ({
                    observationId: item.observationId,
                    generation: item.generation,
                    revision: item.revision,
                }),
            );
            if (
                ack.batchRevision !== pending.batchRevision ||
                ack.batchSha256 !== ConnectorHostProof.digest(Transcript.changed(pending)) ||
                Transcript.encode(rows) !== Transcript.encode(ack.changes)
            ) {
                throw new Error('Host observation acknowledgment changed batch');
            }
            for (const change of pending.changes) {
                const slot: ObservationSlot | undefined = this.#slots.get(change.observationId);
                if (slot === undefined || slot.owned.permit.generation !== change.generation) {
                    throw new Error('Host observation batch owner changed');
                }
                slot.acknowledged = change.revision;
            }
            this.#pending = null;
            this.#pump();
            if (this.#dirty()) {
                this.#schedule();
            }
        } catch {
            this.#fail();
        }
    }

    /** Local side closure joins waiters but never closes the primary lease, releases a process or changes its original. */
    public async [Symbol.asyncDispose](): Promise<void> {
        this.#close();
        await Promise.allSettled(this.#tasks);
    }

    #admit(): void {
        if (this.#closed || BigInt(Date.now()) >= this.connection.expiresAtMs) {
            throw new Error('Host observation companion closed');
        }
        const now: number = performance.now();
        const added: number = Math.floor((now - this.#refilledAt) / 125);
        if (added > 0) {
            this.#tokens = Math.min(64, this.#tokens + added);
            this.#refilledAt += added * 125;
        }
        if (this.#tokens === 0) {
            throw new Error('Host observation control budget exceeded');
        }
        this.#tokens -= 1;
    }
    #pump(): void {
        if (this.#closed || this.#running || (this.#pending !== null && !this.#flushRequested)) {
            return;
        }
        this.#running = true;
        const task: Promise<void> = this.#run();
        this.#tasks.add(task);
        void this.#finished(task);
    }
    async #run(): Promise<void> {
        while (!this.#closed) {
            const permit: Permit | undefined =
                this.#pending === null ? this.#permits.shift() : undefined;
            if (permit !== undefined) {
                await this.#install(permit);
                continue;
            }
            if (this.#flushRequested) {
                this.#flushRequested = false;
                await this.#flush();
            }
            return;
        }
    }
    async #finished(task: Promise<void>): Promise<void> {
        try {
            await task;
        } catch {
            this.#fail();
        } finally {
            this.#tasks.delete(task);
            this.#running = false;
            if (
                !this.#closed &&
                (this.#flushRequested || (this.#pending === null && this.#permits.length !== 0))
            ) {
                this.#pump();
            }
        }
    }

    async #install(permit: Permit): Promise<void> {
        const encoded: string = Transcript.encode(permit);
        const previous: ObservationSlot | undefined = this.#slots.get(permit.observationId);
        if (previous?.permitJson === encoded) {
            await this.#until(this.host.inspectObservation(previous.owned, this.#connection()));
            if (!this.#closed) {
                this.sink.ready(previous.ready);
            }
            return;
        }
        if (previous === undefined && this.#slots.size >= Limits.Entries) {
            throw new Error('Host observation source capacity exceeded');
        }
        const owned: Owned = await this.#until(
            this.host.observe(Codec.json(encoded), this.#connection()),
        );
        this.#stop.signal.throwIfAborted();
        const state: ReturnType<Owned['source']['state']> = owned.source.state();
        if (this.#runtimeId !== null && state.runtimeId !== this.#runtimeId) {
            throw new Error('Host observation native runtime changed');
        }
        this.#runtimeId = state.runtimeId;
        const body: Omit<Ready, 'signature'> = {
            enrollmentId: permit.origin.enrollmentId,
            leaseId: permit.leaseId,
            companionNonce: permit.companionNonce,
            journalId: permit.origin.journalId,
            observationId: permit.observationId,
            generation: permit.generation,
            originSha256: permit.originSha256,
            permitSha256: ConnectorHostProof.digest(Transcript.permit(permit)),
            runtimeId: state.runtimeId,
            instanceSha256: owned.instanceSha256,
            revision: state.revision,
        };
        const ready: Ready = Object.freeze({
            ...body,
            signature: this.host.identity.key.sign(
                SignaturePurpose.HostObservationReady,
                Buffer.from(Transcript.ready(body)),
            ),
        });
        const slot: ObservationSlot = {
            owned,
            ready,
            permitJson: encoded,
            stop: new AbortController(),
            revision: state.revision,
            acknowledged: state.revision,
        };
        previous?.stop.abort();
        this.#slots.set(permit.observationId, slot);
        this.sink.ready(ready);
        const watcher: Promise<void> = this.#watch(slot);
        this.#tasks.add(watcher);
        void this.#watched(watcher, slot);
    }
    async #watch(slot: ObservationSlot): Promise<void> {
        const signal: AbortSignal = AbortSignal.any([this.#stop.signal, slot.stop.signal]);
        for (;;) {
            const state: ReturnType<Owned['source']['state']> = await slot.owned.source.wait(
                slot.revision,
                signal,
            );
            signal.throwIfAborted();
            if (this.#slots.get(slot.owned.permit.observationId) !== slot) {
                return;
            }
            if (state.revision > slot.revision) {
                slot.revision = state.revision;
                this.#schedule();
            }
        }
    }
    async #watched(task: Promise<void>, slot: ObservationSlot): Promise<void> {
        try {
            await task;
        } catch {
            if (!this.#closed && !slot.stop.signal.aborted) {
                this.#fail();
            }
        } finally {
            this.#tasks.delete(task);
        }
    }
    #dirty(): boolean {
        return Array.from(this.#slots.values()).some(
            (slot: ObservationSlot): boolean => slot.revision > slot.acknowledged,
        );
    }
    #schedule(): void {
        if (this.#closed || this.#timer !== undefined) {
            return;
        }
        this.#timer = setTimeout((): void => {
            this.#timer = undefined;
            this.#flushRequested = true;
            this.#pump();
        }, 1000 / Limits.BatchesPerSecond);
    }
    async #flush(): Promise<void> {
        let pending: Changed | null = this.#pending;
        if (pending === null) {
            const slots: readonly ObservationSlot[] = Array.from(this.#slots.values())
                .filter((slot: ObservationSlot): boolean => slot.revision > slot.acknowledged)
                .toSorted((left: ObservationSlot, right: ObservationSlot): number =>
                    left.owned.permit.observationId < right.owned.permit.observationId ? -1 : 1,
                );
            if (slots.length === 0 || this.#runtimeId === null) {
                return;
            }
            for (const slot of slots) {
                await this.#until(this.host.inspectObservation(slot.owned, this.#connection()));
            }
            this.#stop.signal.throwIfAborted();
            this.#batchRevision += 1n;
            const changes: readonly Change[] = slots.map((slot: ObservationSlot): Change =>
                Object.freeze({
                    observationId: slot.owned.permit.observationId,
                    generation: slot.owned.permit.generation,
                    originSha256: slot.owned.permit.originSha256,
                    permitSha256: slot.ready.permitSha256,
                    instanceSha256: slot.owned.instanceSha256,
                    processId: slot.owned.permit.origin.processId,
                    kind: slot.owned.permit.origin.kind,
                    revision: slot.revision,
                }),
            );
            const body: Omit<Changed, 'signature'> = {
                enrollmentId: this.host.grant.enrollmentId,
                leaseId: this.connection.leaseId,
                companionNonce: this.connection.companionNonce,
                journalId: this.host.grant.journalId,
                runtimeId: this.#runtimeId,
                batchRevision: this.#batchRevision,
                changes: Object.freeze(changes),
            };
            pending = Object.freeze({
                ...body,
                signature: this.host.identity.key.sign(
                    SignaturePurpose.HostObservationChanged,
                    Buffer.from(Transcript.changed(body)),
                ),
            });
            this.#pending = pending;
        } else {
            for (const change of pending.changes) {
                const slot: ObservationSlot | undefined = this.#slots.get(change.observationId);
                if (slot === undefined) {
                    throw new Error('Outstanding host observation owner unavailable');
                }
                await this.#until(this.host.inspectObservation(slot.owned, this.#connection()));
            }
        }
        this.#stop.signal.throwIfAborted();
        if (this.#pending === pending) {
            this.sink.changed(pending);
            if (this.#pending !== null || this.#dirty()) {
                this.#schedule();
            }
        }
    }
    #connection(): Connection {
        return { ...this.connection, nowMs: BigInt(Date.now()) };
    }
    async #until<T>(work: Promise<T>): Promise<T> {
        const canceled: PromiseWithResolvers<T> = Promise.withResolvers<T>();
        const abort: () => void = (): void => canceled.reject(this.#stop.signal.reason);
        if (this.#stop.signal.aborted) {
            abort();
        } else {
            this.#stop.signal.addEventListener('abort', abort, { once: true });
        }
        try {
            const result: T = await Promise.race([work, canceled.promise]);
            this.#stop.signal.throwIfAborted();
            return result;
        } finally {
            this.#stop.signal.removeEventListener('abort', abort);
        }
    }
    #close(): void {
        if (this.#closed) {
            return;
        }
        this.#closed = true;
        this.host.deactivateObservation(this.connection.companionNonce);
        this.#stop.abort();
        clearTimeout(this.#expiry);
        clearTimeout(this.#timer);
        this.#timer = undefined;
        this.#permits.length = 0;
        this.#pending = null;
        for (const slot of this.#slots.values()) {
            slot.stop.abort();
        }
        this.#slots.clear();
    }
    #fail(): void {
        if (!this.#closed) {
            this.#close();
            this.sink.failed();
        }
    }
}
