// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

import { ConnectorAuthorizationCodec } from 'nerva-connector-protocol/protocol/ConnectorAuthorizationCodec.js';
import { ConnectorEffectContextCodec } from './ConnectorEffectContextCodec.js';
import { ConnectorEffectKind, type ConnectorEffectContext } from './ConnectorEffectContext.js';
import type { ConnectorCapturedExecutionEffect } from './ConnectorEffectContext.js';
import type { ExecutionCgroupIdentity } from '../execution/ExecutionCgroupIdentity.js';
import { randomBytes } from 'node:crypto';
import type { SigningKey } from '../identity/SigningKey.js';
import { ConnectorJournalStore } from './ConnectorJournalStore.js';
import {
    ConnectorJournalState,
    type ConnectorJournalSnapshot,
    type ConnectorJournalPending,
} from './ConnectorJournalState.js';
import { type ConnectorJournalReceipt } from 'nerva-connector-protocol/protocol/ConnectorJournalReceipt.js';
import type { ConnectorProgressCodec } from './ConnectorProgressCodec.js';
import type { ConnectorOperationCodec } from './ConnectorOperationCodec.js';
import type { ConnectorOperationDispatch } from 'nerva-connector-protocol/protocol/ConnectorOperationDispatch.js';

/** Only a newly persisted Started record permits invoking the authorized effect in this process. */
export interface ConnectorJournalClaim<TRequest, TResponse, TProgress = never> {
    readonly pending: ConnectorJournalPending<TRequest, TResponse, TProgress>;
    readonly fresh: boolean;
}

/** One ordered operation journal keeps original results across socket and process replacement. */
export class ConnectorOperationJournal<
    TRequest,
    TResponse,
    TProgress = never,
> implements AsyncDisposable {
    readonly #store: ConnectorJournalStore<
        ConnectorJournalSnapshot<TRequest, TResponse, TProgress>
    >;
    readonly #state: ConnectorJournalState<TRequest, TResponse, TProgress>;
    #snapshot: ConnectorJournalSnapshot<TRequest, TResponse, TProgress>;
    #busy: boolean = false;
    #closed: boolean = false;
    #failed: boolean = false;
    #idle: PromiseWithResolvers<undefined> = Promise.withResolvers<undefined>();
    private constructor(
        store: ConnectorJournalStore<ConnectorJournalSnapshot<TRequest, TResponse, TProgress>>,
        snapshot: ConnectorJournalSnapshot<TRequest, TResponse, TProgress>,
        state: ConnectorJournalState<TRequest, TResponse, TProgress>,
    ) {
        this.#state = state;
        this.#store = store;
        this.#snapshot = snapshot;
        this.#idle.resolve(undefined);
    }

    /** Initial installation is explicit and cannot overwrite or reset any existing journal. */
    public static async initialize<TRequest, TResponse, TProgress = never>(
        directory: string,
        enrollmentId: string,
        key: SigningKey,
        codec: ConnectorOperationCodec<TRequest, TResponse, TProgress>,
    ): Promise<void> {
        const state: ConnectorJournalState<TRequest, TResponse, TProgress> =
            new ConnectorJournalState(codec);
        await using store: ConnectorJournalStore<
            ConnectorJournalSnapshot<TRequest, TResponse, TProgress>
        > = await ConnectorJournalStore.open(directory, enrollmentId, key, codec.purpose, state);
        await store.write(state.empty(randomBytes(32).toString('hex')), true);
    }
    /** Normal startup opens existing encrypted state under exclusive process ownership, never an empty fallback. */
    public static async load<TRequest, TResponse, TProgress = never>(
        directory: string,
        enrollmentId: string,
        key: SigningKey,
        codec: ConnectorOperationCodec<TRequest, TResponse, TProgress>,
    ): Promise<ConnectorOperationJournal<TRequest, TResponse, TProgress>> {
        const state: ConnectorJournalState<TRequest, TResponse, TProgress> =
            new ConnectorJournalState(codec);
        const store: ConnectorJournalStore<
            ConnectorJournalSnapshot<TRequest, TResponse, TProgress>
        > = await ConnectorJournalStore.open(directory, enrollmentId, key, codec.purpose, state);
        try {
            return new ConnectorOperationJournal(store, await store.read(), state);
        } catch (caught: unknown) {
            await store[Symbol.asyncDispose]();
            throw caught;
        }
    }
    /** Permanent random local journal identity is published under device proof and bound once by the backend. */
    public get id(): string {
        return this.#snapshot.journalId;
    }

    /** Local preparation observes the committed permanent watermark without changing history or acknowledging a job. */
    public get acknowledgedSequence(): bigint {
        return this.#snapshot.acknowledgedSequence;
    }
    /** Readers observe only the last committed original snapshot, including while a later atomic write is in flight. */
    public get pending(): ConnectorJournalPending<TRequest, TResponse, TProgress> | null {
        return this.#snapshot.pending;
    }
    /** Durability failure requires process restart and validated state recovery, not continued execution. */
    public get failed(): boolean {
        return this.#failed;
    }

    /** Persist Started before invoking the authorized effect; an identical replay returns retained state. */
    public async begin(
        permit: ConnectorOperationDispatch<TRequest>,
        effectContext: ConnectorEffectContext,
    ): Promise<ConnectorJournalClaim<TRequest, TResponse, TProgress>> {
        this.#active();
        if (
            effectContext.kind === ConnectorEffectKind.HistoricalUnproven &&
            this.#snapshot.pending === null
        ) {
            throw new Error('Historical context cannot authorize a fresh operation');
        }
        const pending: ConnectorJournalPending<TRequest, TResponse, TProgress> = {
            jobId: permit.jobId,
            sequence: permit.sequence,
            dispatchId: permit.dispatchId,
            requestHash: permit.requestHash,
            admissionHash: permit.admissionHash,
            authorization: permit.authorization,
            request: permit.request,
            effectContext,
            response: null,
            progress: null,
        };
        const normalized: ConnectorJournalPending<TRequest, TResponse, TProgress> =
            this.#normalizePending(pending);
        if (permit.sequence !== this.#snapshot.acknowledgedSequence + 1n) {
            throw new Error('Connector journal sequence changed');
        }
        if (this.#snapshot.pending !== null) {
            this.#original(this.#snapshot.pending, normalized);
            if (
                ConnectorEffectContextCodec.encode(this.#snapshot.pending.effectContext) !==
                ConnectorEffectContextCodec.encode(normalized.effectContext)
            ) {
                throw new Error('Original effect context changed');
            }
            return { pending: this.#snapshot.pending, fresh: false };
        }
        await this.#commit({ ...this.#snapshot, pending: normalized });
        return { pending: normalized, fresh: true };
    }

    /** A Started command may bind its newly allocated empty group once, before any program or retained output. */
    public async bindExecutionGroup(
        dispatch: ConnectorOperationDispatch<TRequest>,
        group: ExecutionCgroupIdentity,
    ): Promise<ConnectorCapturedExecutionEffect> {
        this.#active();
        const pending: ConnectorJournalPending<TRequest, TResponse, TProgress> | null =
            this.#snapshot.pending;
        if (
            pending === null ||
            pending.response !== null ||
            pending.progress !== null ||
            (pending.effectContext.kind !== ConnectorEffectKind.CapturedExecution &&
                pending.effectContext.kind !== ConnectorEffectKind.CapturedInteractiveExecution) ||
            pending.effectContext.group !== null
        ) {
            throw new Error('Original command group cannot be rebound');
        }
        this.#original(pending, dispatch);
        const context: ConnectorCapturedExecutionEffect = Object.freeze({
            ...pending.effectContext,
            group,
        });
        const normalized: ConnectorJournalPending<TRequest, TResponse, TProgress> =
            this.#normalizePending({ ...pending, effectContext: context });
        if (
            normalized.effectContext.kind !== ConnectorEffectKind.CapturedExecution &&
            normalized.effectContext.kind !== ConnectorEffectKind.CapturedInteractiveExecution
        ) {
            throw new Error('Command effect context changed');
        }
        await this.#commit({ ...this.#snapshot, pending: normalized });
        return normalized.effectContext;
    }

    #normalizePending(
        pending: ConnectorJournalPending<TRequest, TResponse, TProgress>,
    ): ConnectorJournalPending<TRequest, TResponse, TProgress> {
        const raw: unknown = JSON.parse(
            JSON.stringify(pending, (_key: string, entry: unknown): unknown =>
                typeof entry === 'bigint' ? entry.toString() : entry,
            ),
        );
        return this.#state.pending(raw);
    }

    /** A result is normalized and durably encrypted before any connection may transmit it. */
    public async finish(
        permit: ConnectorOperationDispatch<TRequest>,
        response: TResponse,
    ): Promise<TResponse> {
        this.#active();
        const pending: ConnectorJournalPending<TRequest, TResponse, TProgress> | null =
            this.#snapshot.pending;
        if (pending === null) {
            throw new Error('Connector journal has no started request');
        }
        this.#original(pending, permit);
        const raw: unknown = JSON.parse(
            JSON.stringify(response, (_key: string, entry: unknown): unknown =>
                typeof entry === 'bigint' ? entry.toString() : entry,
            ),
        );
        const normalized: TResponse = this.#state.codec.response(
            raw,
            pending.request,
            pending.effectContext,
        );
        if (pending.response !== null) {
            if (
                this.#state.codec.responseHash(pending.response) !==
                this.#state.codec.responseHash(normalized)
            ) {
                throw new Error('Connector retained result changed');
            }
            return pending.response;
        }
        if (pending.progress !== null) {
            const codec: ConnectorProgressCodec<TRequest, TResponse, TProgress> | null =
                this.#state.codec.progress;
            if (codec === null) {
                throw new Error('Connector progress is not supported');
            }
            codec.finish(pending.progress, normalized);
        }
        await this.#commit({
            ...this.#snapshot,
            pending: Object.freeze({ ...pending, response: normalized, progress: null }),
        });
        return normalized;
    }

    /** Commit only an append-only prefix for the exact Started original; no connection or receipt can reset it. */
    public async retain(
        permit: ConnectorOperationDispatch<TRequest>,
        progress: TProgress,
    ): Promise<void> {
        this.#active();
        const pending: ConnectorJournalPending<TRequest, TResponse, TProgress> | null =
            this.#snapshot.pending;
        const codec: ConnectorProgressCodec<TRequest, TResponse, TProgress> | null =
            this.#state.codec.progress;
        if (pending === null || pending.response !== null || codec === null) {
            throw new Error('Connector progress is not available');
        }
        this.#original(pending, permit);
        const raw: unknown = JSON.parse(JSON.stringify(progress));
        const normalized: TProgress = codec.read(raw, pending.request, pending.effectContext);
        codec.advance(pending.progress, normalized);
        await this.#commit({
            ...this.#snapshot,
            pending: Object.freeze({ ...pending, progress: normalized }),
        });
    }

    /** Only a separately verified signed backend acknowledgment may compact the matching retained result. */
    public async acknowledge(acknowledgment: ConnectorJournalReceipt): Promise<void> {
        this.#active();
        const receipt: ConnectorJournalReceipt = {
            jobId: acknowledgment.jobId,
            sequence: acknowledgment.sequence,
            dispatchId: acknowledgment.dispatchId,
            requestHash: acknowledgment.requestHash,
            admissionHash: acknowledgment.admissionHash,
            responseHash: acknowledgment.responseHash,
        };
        if (
            receipt.sequence === this.#snapshot.acknowledgedSequence &&
            this.#snapshot.receipt !== null
        ) {
            this.#same(this.#snapshot.receipt, receipt);
            if (this.#snapshot.receipt.responseHash !== receipt.responseHash) {
                throw new Error('Connector retained acknowledgment changed');
            }
            return;
        }
        const pending: ConnectorJournalPending<TRequest, TResponse, TProgress> | null =
            this.#snapshot.pending;
        if (pending === null || pending.response === null) {
            throw new Error('Connector result was not durably retained');
        }
        this.#same(pending, receipt);
        if (this.#state.codec.responseHash(pending.response) !== receipt.responseHash) {
            throw new Error('Connector result acknowledgment changed');
        }
        await this.#commit({
            schema: this.#snapshot.schema,
            journalId: this.#snapshot.journalId,
            acknowledgedSequence: receipt.sequence,
            receipt,
            pending: null,
        });
    }

    /** Disposal joins a pending atomic write before releasing its kernel process lock. */
    public async [Symbol.asyncDispose](): Promise<void> {
        this.#closed = true;
        await this.#idle.promise;
        await this.#store[Symbol.asyncDispose]();
    }
    #original(
        pending: ConnectorJournalPending<TRequest, TResponse, TProgress>,
        dispatch: ConnectorOperationDispatch<TRequest>,
    ): void {
        this.#same(pending, dispatch);
        if (
            ConnectorAuthorizationCodec.encode(pending.authorization) !==
            ConnectorAuthorizationCodec.encode(dispatch.authorization)
        ) {
            throw new Error('Connector original authorization changed');
        }
    }

    #same(
        left: Omit<ConnectorJournalReceipt, 'responseHash'>,
        right: Omit<ConnectorJournalReceipt, 'responseHash'>,
    ): void {
        if (
            left.jobId !== right.jobId ||
            left.sequence !== right.sequence ||
            left.dispatchId !== right.dispatchId ||
            left.requestHash !== right.requestHash ||
            left.admissionHash !== right.admissionHash
        ) {
            throw new Error('Connector original dispatch changed');
        }
    }
    #active(): void {
        if (this.#closed || this.#failed || this.#busy) {
            throw new Error('Connector journal is not available');
        }
    }
    async #commit(
        snapshot: ConnectorJournalSnapshot<TRequest, TResponse, TProgress>,
    ): Promise<void> {
        this.#active();
        this.#busy = true;
        this.#idle = Promise.withResolvers<undefined>();
        try {
            await this.#store.write(snapshot, false);
            this.#snapshot = snapshot;
        } catch (caught: unknown) {
            this.#failed = true;
            throw caught;
        } finally {
            this.#busy = false;
            this.#idle.resolve(undefined);
        }
    }
}
