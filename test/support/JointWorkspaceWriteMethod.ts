// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

import { ConnectorPrivateDirectory } from '../../src/runtime/ConnectorPrivateDirectory.js';
import { JointWorkspaceJournalStore } from '../../src/workspace/JointWorkspaceJournalStore.js';
import type { JointWorkspaceJournalSnapshot } from '../../src/workspace/JointWorkspaceJournalTypes.js';

/** Captured original calls retain an explicit receiver even after Vitest replaces the prototype method for fault injection. */
export interface JointWorkspaceStoreWrite {
    (
        this: JointWorkspaceJournalStore,
        snapshot: JointWorkspaceJournalSnapshot,
        initialize?: boolean,
    ): Promise<void>;
}
export interface JointWorkspaceDirectoryWrite {
    (
        this: ConnectorPrivateDirectory,
        name: string,
        bytes: Buffer,
        maximum: number,
        initialize: boolean,
    ): Promise<void>;
}

/** The reflection boundary is immediately narrowed and its actual asynchronous result validated; no replacement IO is simulated. */
export class JointWorkspaceWriteMethod {
    public static store(): JointWorkspaceStoreWrite {
        const method: unknown = Reflect.get(JointWorkspaceJournalStore.prototype, 'write');
        if (typeof method !== 'function') {
            throw new Error('Actual journal write method required');
        }
        return async function (
            this: JointWorkspaceJournalStore,
            snapshot: JointWorkspaceJournalSnapshot,
            initialize: boolean = false,
        ): Promise<void> {
            await JointWorkspaceWriteMethod.#result(
                Reflect.apply(method, this, [snapshot, initialize]),
            );
        };
    }
    public static directory(): JointWorkspaceDirectoryWrite {
        const method: unknown = Reflect.get(ConnectorPrivateDirectory.prototype, 'write');
        if (typeof method !== 'function') {
            throw new Error('Actual private-directory write method required');
        }
        return async function (
            this: ConnectorPrivateDirectory,
            name: string,
            bytes: Buffer,
            maximum: number,
            initialize: boolean,
        ): Promise<void> {
            await JointWorkspaceWriteMethod.#result(
                Reflect.apply(method, this, [name, bytes, maximum, initialize]),
            );
        };
    }
    static async #result(raw: unknown): Promise<void> {
        if (!(raw instanceof Promise) || (await raw) !== undefined) {
            throw new Error('Actual storage write must complete as Promise<void>');
        }
    }
}
