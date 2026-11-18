// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

import { SigningKey } from '../identity/SigningKey.js';
import { Boundary } from 'nerva-connector-protocol/protocol/Boundary.js';
import type { JointWorkspaceDescriptor } from 'nerva-connector-protocol/workspace/JointWorkspaceBinding.js';
import { JointWorkspaceProof } from 'nerva-connector-protocol/workspace/JointWorkspaceProof.js';
import { JointWorkspacePublicationCodec } from 'nerva-connector-protocol/workspace/JointWorkspacePublicationCodec.js';
import { JointWorkspaceReceiptCodec } from 'nerva-connector-protocol/workspace/JointWorkspaceReceiptCodec.js';
import { JointWorkspaceReceiptProof } from 'nerva-connector-protocol/workspace/JointWorkspaceReceiptProof.js';
import type { JointWorkspacePublication } from 'nerva-connector-protocol/workspace/JointWorkspacePublication.js';
import type {
    JointWorkspaceReceipt,
    JointWorkspaceReceiptExpected,
} from 'nerva-connector-protocol/workspace/JointWorkspaceReceipt.js';
import { JointWorkspaceJournalContext } from './JointWorkspaceJournalContext.js';
import { JointWorkspaceJournalState } from './JointWorkspaceJournalState.js';
import { JointWorkspaceJournalStore } from './JointWorkspaceJournalStore.js';
import { JointWorkspaceJournalRecovery } from './JointWorkspaceJournalRecovery.js';
import { JointWorkspaceJournalTransition } from './JointWorkspaceJournalTransition.js';
import {
    JointWorkspaceJournalLimits,
    type JointWorkspaceJournalIdentity,
    type JointWorkspaceJournalSnapshot,
    type JointWorkspaceJournalReference,
    type JointWorkspaceJournalPair,
    type JointWorkspaceJournalAccepted,
} from './JointWorkspaceJournalTypes.js';

/** Installation ownership serializes durable reservations, immutable archives, publication attempts and authenticated acceptance. */
export class JointWorkspaceJournal implements AsyncDisposable {
    readonly #stop: AbortController = new AbortController();
    readonly #store: JointWorkspaceJournalStore;
    readonly #context: JointWorkspaceJournalContext;
    #snapshot: JointWorkspaceJournalSnapshot;
    #busy: boolean = false;
    #closed: boolean = false;
    #failed: boolean = false;
    #disposal: Promise<void> | null = null;
    #idle: PromiseWithResolvers<undefined> = Promise.withResolvers<undefined>();

    private constructor(
        store: JointWorkspaceJournalStore,
        context: JointWorkspaceJournalContext,
        snapshot: JointWorkspaceJournalSnapshot,
    ) {
        this.#store = store;
        this.#context = context;
        this.#snapshot = snapshot;
        this.#idle.resolve(undefined);
    }

    /** Explicit first installation cannot replace a head, retained partial or immutable original. */
    public static async initialize(
        directory: string,
        key: SigningKey,
        identity: JointWorkspaceJournalIdentity,
        signal: AbortSignal,
    ): Promise<void> {
        signal.throwIfAborted();
        const context: JointWorkspaceJournalContext = new JointWorkspaceJournalContext(
            identity,
            key,
        );
        await using store: JointWorkspaceJournalStore = await JointWorkspaceJournalStore.open(
            directory,
            key,
            context,
        );
        signal.throwIfAborted();
        await store.initialize(new JointWorkspaceJournalState(context).empty());
        signal.throwIfAborted();
    }

    /** Existing encrypted state is required; recovery consumes unused reservations and finalizes already-published immutable archives. */
    public static async open(
        directory: string,
        key: SigningKey,
        identity: JointWorkspaceJournalIdentity,
        signal: AbortSignal,
    ): Promise<JointWorkspaceJournal> {
        signal.throwIfAborted();
        const context: JointWorkspaceJournalContext = new JointWorkspaceJournalContext(
            identity,
            key,
        );
        const store: JointWorkspaceJournalStore = await JointWorkspaceJournalStore.open(
            directory,
            key,
            context,
        );
        try {
            const snapshot: JointWorkspaceJournalSnapshot =
                await JointWorkspaceJournalRecovery.load(store, await store.read(), signal);
            return new JointWorkspaceJournal(store, context, snapshot);
        } catch (caught: unknown) {
            await store[Symbol.asyncDispose]();
            throw caught;
        }
    }

    /** Snapshot metadata is frozen; archived original descriptors are loaded explicitly when required. */
    public get snapshot(): JointWorkspaceJournalSnapshot {
        this.#active();
        return this.#snapshot;
    }
    public get pending(): JointWorkspacePublication | null {
        return this.snapshot.pending;
    }
    public get failed(): boolean {
        return this.#failed;
    }

    /** The durable reservation completes before callers capture/sign that revision; consumed revisions are never reused. */
    public async reserveRevision(signal: AbortSignal): Promise<bigint> {
        return await this.#run(signal, async (): Promise<bigint> => {
            if (
                this.#snapshot.reservedRevision !== null ||
                this.#snapshot.pending !== null ||
                this.#snapshot.revision >= BigInt(JointWorkspaceJournalLimits.revisions)
            ) {
                throw new Error(
                    'Joint workspace revision cannot be reserved while pending or beyond quota',
                );
            }
            const revision: bigint = this.#snapshot.revision + 1n;
            await this.#commit({ ...this.#snapshot, revision, reservedRevision: revision });
            return revision;
        });
    }

    /** Exact retained-body retries return the original signature, including at full quota; no newer proof may retag an old revision. */
    public async retain(
        value: JointWorkspaceDescriptor,
        signal: AbortSignal,
    ): Promise<JointWorkspaceDescriptor> {
        return await this.#run(signal, async (): Promise<JointWorkspaceDescriptor> => {
            const descriptor: JointWorkspaceDescriptor = this.#context.descriptor(value);
            const existing: JointWorkspaceJournalReference | undefined = this.#reference(
                descriptor.binding.revision,
            );
            if (existing !== undefined) {
                if (
                    existing.bindingSha256 !== JointWorkspaceProof.bindingSha256(descriptor.binding)
                ) {
                    throw new Error('Original joint workspace revision body changed');
                }
                return await this.#descriptor(existing.revision);
            }
            if (this.#snapshot.reservedRevision !== descriptor.binding.revision) {
                throw new Error('Joint workspace descriptor has no original durable reservation');
            }
            JointWorkspaceJournalTransition.pairs(this.#snapshot, descriptor);
            try {
                await this.#store.retain(descriptor);
            } catch (caught: unknown) {
                this.#failed = true;
                throw caught;
            }
            await this.#finalize(descriptor);
            return descriptor;
        });
    }

    public async descriptor(
        revision: bigint,
        signal: AbortSignal,
    ): Promise<JointWorkspaceDescriptor> {
        return await this.#run(
            signal,
            async (): Promise<JointWorkspaceDescriptor> => await this.#descriptor(revision),
        );
    }

    public async current(
        fileRootId: string,
        executionRootId: string,
        signal: AbortSignal,
    ): Promise<JointWorkspaceDescriptor | null> {
        return await this.#run(signal, async (): Promise<JointWorkspaceDescriptor | null> => {
            const file: string = Boundary.id(fileRootId);
            const execution: string = Boundary.id(executionRootId);
            const pair: JointWorkspaceJournalPair | undefined = this.#snapshot.pairs.find(
                (entry: JointWorkspaceJournalPair): boolean =>
                    entry.fileRootId === file && entry.executionRootId === execution,
            );
            if (pair === undefined) {
                return null;
            }
            const descriptor: JointWorkspaceDescriptor = await this.#descriptor(pair.revision);
            if (
                descriptor.binding.fileRootId !== file ||
                descriptor.binding.executionRootId !== execution
            ) {
                this.#failed = true;
                throw new Error('Joint workspace current pair differs from its immutable archive');
            }
            return descriptor;
        });
    }

    /** Persist before sending; same-lease retries reuse original bytes, and an explicit replacement lease may republish only that same binding. */
    public async publish(
        value: JointWorkspacePublication,
        signal: AbortSignal,
    ): Promise<JointWorkspacePublication> {
        return await this.#run(signal, async (): Promise<JointWorkspacePublication> => {
            const publication: JointWorkspacePublication =
                JointWorkspacePublicationCodec.value(value);
            this.#context.publication(publication);
            await this.#original(publication);
            const binding: JointWorkspaceDescriptor['binding'] = publication.descriptor.binding;
            if (
                this.#snapshot.reservedRevision !== null ||
                !this.#snapshot.pairs.some(
                    (pair: JointWorkspaceJournalPair): boolean =>
                        pair.fileRootId === binding.fileRootId &&
                        pair.executionRootId === binding.executionRootId &&
                        pair.revision === binding.revision,
                )
            ) {
                throw new Error('Joint workspace publication is not the retained current pair');
            }
            const pending: JointWorkspacePublication | null = this.#snapshot.pending;
            if (pending !== null) {
                if (
                    JointWorkspaceProof.bindingSha256(pending.descriptor.binding) !==
                    JointWorkspaceProof.bindingSha256(binding)
                ) {
                    throw new Error('A different joint workspace publication remains unresolved');
                }
                if (pending.leaseId === publication.leaseId) {
                    return pending;
                }
            }
            await this.#commit({ ...this.#snapshot, pending: publication });
            return publication;
        });
    }

    /** Only the matching authority-signed exact-publication receipt can retire pending state; no unsigned success is persisted. */
    public async accept(
        expected: JointWorkspaceReceiptExpected,
        original: JointWorkspacePublication,
        receipt: JointWorkspaceReceipt,
        nowMs: bigint,
        signal: AbortSignal,
    ): Promise<JointWorkspaceReceipt> {
        return await this.#run(signal, async (): Promise<JointWorkspaceReceipt> => {
            const current: JointWorkspaceReceiptExpected =
                JointWorkspaceReceiptCodec.expected(expected);
            if (
                current.authorityPublicKey !== this.#context.identity.scope.authorityPublicKey ||
                current.authorityId !== this.#context.scope.authorityId ||
                current.environmentId !== this.#context.scope.environmentId ||
                current.enrollmentId !== this.#context.scope.enrollmentId ||
                current.devicePublicKey !== this.#context.scope.devicePublicKey ||
                !JointWorkspaceReceiptProof.verify(SigningKey, current, original, receipt, nowMs)
            ) {
                throw new Error(
                    'Joint workspace acceptance does not match current trusted authentication',
                );
            }
            const hash: string = JointWorkspaceReceiptProof.publicationSha256(original);
            if (this.#snapshot.pending === null) {
                const accepted: JointWorkspaceJournalAccepted | null = this.#snapshot.accepted;
                if (
                    accepted !== null &&
                    JointWorkspaceReceiptProof.publicationSha256(accepted.publication) === hash
                ) {
                    return accepted.receipt;
                }
                throw new Error('Joint workspace acceptance has no original retained publication');
            }
            if (JointWorkspaceReceiptProof.publicationSha256(this.#snapshot.pending) !== hash) {
                throw new Error(
                    'Joint workspace acceptance names a different original publication',
                );
            }
            const accepted: JointWorkspaceJournalAccepted = Object.freeze({
                publication: this.#snapshot.pending,
                receipt: JointWorkspaceReceiptCodec.value(receipt),
                leaseIssuedAtMs: current.leaseIssuedAtMs,
                leaseExpiresAtMs: current.leaseExpiresAtMs,
            });
            await this.#commit({ ...this.#snapshot, pending: null, accepted });
            return accepted.receipt;
        });
    }

    public async [Symbol.asyncDispose](): Promise<void> {
        this.#disposal ??= this.#close();
        await this.#disposal;
    }
    async #close(): Promise<void> {
        this.#closed = true;
        this.#stop.abort();
        await this.#idle.promise;
        await this.#store[Symbol.asyncDispose]();
    }

    async #descriptor(revision: bigint): Promise<JointWorkspaceDescriptor> {
        if (this.#reference(revision) === undefined) {
            throw new Error('Joint workspace revision was not retained');
        }
        try {
            return await JointWorkspaceJournalRecovery.descriptor(
                this.#store,
                this.#snapshot,
                revision,
            );
        } catch (caught: unknown) {
            this.#failed = true;
            throw caught;
        }
    }
    async #original(publication: JointWorkspacePublication): Promise<void> {
        const descriptor: JointWorkspaceDescriptor = await this.#descriptor(
            publication.descriptor.binding.revision,
        );
        JointWorkspaceJournalRecovery.sameOriginal(descriptor, publication);
    }
    #reference(revision: bigint): JointWorkspaceJournalReference | undefined {
        return this.#snapshot.references.find(
            (entry: JointWorkspaceJournalReference): boolean => entry.revision === revision,
        );
    }
    async #finalize(descriptor: JointWorkspaceDescriptor): Promise<void> {
        await this.#commit(JointWorkspaceJournalTransition.finalize(this.#snapshot, descriptor));
    }
    async #commit(snapshot: JointWorkspaceJournalSnapshot): Promise<void> {
        try {
            await this.#store.write(snapshot);
            this.#snapshot = Object.freeze(snapshot);
        } catch (caught: unknown) {
            this.#failed = true;
            throw caught;
        }
    }
    async #run<T>(signal: AbortSignal, action: () => Promise<T>): Promise<T> {
        this.#active();
        signal.throwIfAborted();
        if (this.#busy) {
            throw new Error('Joint workspace history already has an active operation');
        }
        this.#busy = true;
        this.#idle = Promise.withResolvers<undefined>();
        const active: AbortSignal = AbortSignal.any([signal, this.#stop.signal]);
        try {
            active.throwIfAborted();
            const result: T = await action();
            active.throwIfAborted();
            return result;
        } finally {
            this.#busy = false;
            this.#idle.resolve(undefined);
        }
    }
    #active(): void {
        if (this.#closed || this.#failed) {
            throw new Error('Joint workspace history is closed or requires validated reopening');
        }
    }
}
