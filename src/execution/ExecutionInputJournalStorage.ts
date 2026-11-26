// SPDX-FileCopyrightText: 2026 Dacely <business@dacely.com>
// SPDX-License-Identifier: LicenseRef-Proprietary

import type { ConnectorJournalRecord } from '../runtime/ConnectorJournalRecord.js';
import { ExecutionInputJournalStore } from './ExecutionInputJournalStore.js';
import type { ExecutionInputRecordCodec } from './ExecutionInputRecordCodec.js';
import {
    ExecutionInputJournalPhase,
    ExecutionInputJournalLimits,
    type ExecutionInputJournalRecordState,
    type ExecutionInputJournalState,
} from './ExecutionInputJournalTypes.js';

/** One mutex and source commitment own all phase/control publications for the fixed encrypted input file. */
export class ExecutionInputJournalStorage implements AsyncDisposable {
    #record: ConnectorJournalRecord<ExecutionInputJournalRecordState> | null = null;
    #busy: boolean = false;
    #closed: boolean = false;
    #failed: boolean = false;
    public constructor(public readonly store: ExecutionInputJournalStore) {}

    /** The immutable codec exposes only scoped validation, not a second storage or native owner. */
    public get codec(): ExecutionInputRecordCodec {
        return this.store.codec;
    }
    /** A failed atomic publication forbids later effect authority. */
    public get failed(): boolean {
        return this.#failed;
    }
    /** Loading is explicit and cannot create a missing original. */
    public get loaded(): boolean {
        return this.#record !== null;
    }
    /** Only validated decrypted records may be adopted by phase recovery while holding this mutex. */
    public adopt(record: ConnectorJournalRecord<ExecutionInputJournalRecordState> | null): void {
        this.#active();
        this.#record = record;
    }
    /** Current immutable memory state is distinct from a file-presence observation. */
    public state(): ExecutionInputJournalRecordState {
        this.#active();
        if (this.#record === null) {
            throw new Error('Interactive input record unavailable');
        }
        return this.#record.state;
    }
    /** Only an explicit current Ready record owns an input cursor. */
    public ready(): ExecutionInputJournalState {
        const state: ExecutionInputJournalRecordState = this.state();
        if (state.phase !== ExecutionInputJournalPhase.Ready) {
            throw new Error('Interactive cursor owner unavailable');
        }
        return state;
    }
    /** Exclusive directory ownership prevents another legitimate process from changing the selected first proof. */
    public async read(): Promise<ConnectorJournalRecord<ExecutionInputJournalRecordState>> {
        this.#active();
        return await this.store.read();
    }
    /** Absence is explicit; callers still decide whether an unbound main crash gap permits no-input recovery. */
    public async existing(): Promise<ConnectorJournalRecord<ExecutionInputJournalRecordState> | null> {
        this.#active();
        return (await this.store.directory.exists(ExecutionInputJournalLimits.basename))
            ? await this.store.read()
            : null;
    }
    /** Publication compares the full original ciphertext commitment before replacing its fixed file. */
    public async publish(
        state: ExecutionInputJournalRecordState,
    ): Promise<ExecutionInputJournalRecordState> {
        this.#active();
        try {
            this.#record = await this.store.write(state, this.#record?.sourceSha256 ?? null);
            return this.#record.state;
        } catch (caught: unknown) {
            this.#failed = true;
            throw caught;
        }
    }
    /** Ready controls cannot accidentally publish a Prepared state through a broad internal union. */
    public async publishReady(
        state: ExecutionInputJournalState,
    ): Promise<ExecutionInputJournalState> {
        const saved: ExecutionInputJournalRecordState = await this.publish(state);
        if (saved.phase !== ExecutionInputJournalPhase.Ready) {
            throw new Error('Ready publication changed its phase');
        }
        return saved;
    }
    /** One finite mutation runs at a time; callers cannot queue unbounded disk or signature work. */
    public async run<T>(action: () => Promise<T>): Promise<T> {
        this.#active();
        if (this.#busy) {
            throw new Error('Interactive cursor owner is busy');
        }
        this.#busy = true;
        try {
            return await action();
        } finally {
            this.#busy = false;
        }
    }
    /** The enclosing lifecycle joins mutation owners before releasing the independent kernel lock. */
    public async [Symbol.asyncDispose](): Promise<void> {
        if (this.#busy) {
            throw new Error('Join interactive cursor mutation before disposal');
        }
        if (!this.#closed) {
            this.#closed = true;
            this.#record = null;
            await this.store[Symbol.asyncDispose]();
        }
    }
    #active(): void {
        if (this.#closed || this.#failed) {
            throw new Error('Interactive input storage owner unavailable');
        }
    }
}
