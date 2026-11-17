// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

import { vi, type MockInstance } from 'vitest';
import { JointWorkspaceJournalStore } from '../../src/workspace/JointWorkspaceJournalStore.js';
import type { JointWorkspaceJournalSnapshot } from '../../src/workspace/JointWorkspaceJournalTypes.js';
import {
    JointWorkspaceWriteMethod,
    type JointWorkspaceStoreWrite,
} from './JointWorkspaceWriteMethod.js';

/** Fault injection pauses a real atomic receipt write; release always resumes the original protected filesystem implementation. */
export class JointWorkspaceDeliveryWriteGate implements Disposable {
    readonly #entered: PromiseWithResolvers<undefined> = Promise.withResolvers<undefined>();
    readonly #release: PromiseWithResolvers<undefined> = Promise.withResolvers<undefined>();
    readonly #write: JointWorkspaceStoreWrite = JointWorkspaceWriteMethod.store();
    readonly #fault: MockInstance<JointWorkspaceJournalStore['write']>;
    #gated: boolean = false;
    #active: number = 0;
    #maximumActive: number = 0;
    #calls: number = 0;

    public constructor() {
        const perform: (
            owner: JointWorkspaceJournalStore,
            snapshot: JointWorkspaceJournalSnapshot,
            initialize: boolean,
        ) => Promise<void> = async (
            owner: JointWorkspaceJournalStore,
            snapshot: JointWorkspaceJournalSnapshot,
            initialize: boolean,
        ): Promise<void> => await this.#perform(owner, snapshot, initialize);
        this.#fault = vi
            .spyOn(JointWorkspaceJournalStore.prototype, 'write')
            .mockImplementation(async function (
                this: JointWorkspaceJournalStore,
                snapshot: JointWorkspaceJournalSnapshot,
                initialize: boolean = false,
            ): Promise<void> {
                await perform(this, snapshot, initialize);
            });
    }
    public get entered(): Promise<undefined> {
        return this.#entered.promise;
    }
    public get maximumActive(): number {
        return this.#maximumActive;
    }
    public get calls(): number {
        return this.#calls;
    }
    public release(): void {
        this.#release.resolve(undefined);
    }
    public [Symbol.dispose](): void {
        this.release();
        this.#fault.mockRestore();
    }

    async #perform(
        owner: JointWorkspaceJournalStore,
        snapshot: JointWorkspaceJournalSnapshot,
        initialize: boolean,
    ): Promise<void> {
        this.#active++;
        this.#calls++;
        this.#maximumActive = Math.max(this.#maximumActive, this.#active);
        try {
            if (!this.#gated && snapshot.pending === null && snapshot.accepted !== null) {
                this.#gated = true;
                this.#entered.resolve(undefined);
                await this.#release.promise;
            }
            await this.#write.call(owner, snapshot, initialize);
        } finally {
            this.#active--;
        }
    }
}
