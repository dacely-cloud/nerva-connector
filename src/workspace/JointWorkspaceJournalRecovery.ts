// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

import type { JointWorkspaceDescriptor } from 'nerva-connector-protocol/workspace/JointWorkspaceBinding.js';
import { JointWorkspaceCodec } from 'nerva-connector-protocol/workspace/JointWorkspaceCodec.js';
import { JointWorkspaceProof } from './JointWorkspaceProof.js';
import type { JointWorkspacePublication } from 'nerva-connector-protocol/workspace/JointWorkspacePublication.js';
import type {
    JointWorkspaceJournalSnapshot,
    JointWorkspaceJournalReference,
} from './JointWorkspaceJournalTypes.js';
import { JointWorkspaceJournalStore } from './JointWorkspaceJournalStore.js';
import { JointWorkspaceJournalTransition } from './JointWorkspaceJournalTransition.js';

/** Recovery runs under the installation's exclusive directory owner before any runtime publication can resume. */
export class JointWorkspaceJournalRecovery {
    public static async load(
        store: JointWorkspaceJournalStore,
        initial: JointWorkspaceJournalSnapshot,
        signal: AbortSignal,
    ): Promise<JointWorkspaceJournalSnapshot> {
        signal.throwIfAborted();
        let snapshot: JointWorkspaceJournalSnapshot = initial;
        const reserved: bigint | null = snapshot.reservedRevision;
        if (reserved !== null) {
            if (await store.archiveExists(reserved)) {
                snapshot = JointWorkspaceJournalTransition.finalize(
                    snapshot,
                    await store.archive(reserved),
                );
            } else {
                if (await store.archivePartialExists(reserved)) {
                    throw new Error(
                        'Joint workspace archive has retained partial history; keep original state',
                    );
                }
                snapshot = Object.freeze({ ...snapshot, reservedRevision: null });
            }
            signal.throwIfAborted();
            await store.write(snapshot);
        }
        if (snapshot.pending !== null) {
            await this.original(store, snapshot, snapshot.pending);
        }
        if (snapshot.accepted !== null) {
            await this.original(store, snapshot, snapshot.accepted.publication);
        }
        signal.throwIfAborted();
        return snapshot;
    }

    /** Compare the full original descriptor proof as well as its stable body reference. */
    public static async original(
        store: JointWorkspaceJournalStore,
        snapshot: JointWorkspaceJournalSnapshot,
        publication: JointWorkspacePublication,
    ): Promise<void> {
        const descriptor: JointWorkspaceDescriptor = await this.descriptor(
            store,
            snapshot,
            publication.descriptor.binding.revision,
        );
        this.sameOriginal(descriptor, publication);
    }

    /** Re-signed copies cannot replace the exact original descriptor proof retained before publication. */
    public static sameOriginal(
        descriptor: JointWorkspaceDescriptor,
        publication: JointWorkspacePublication,
    ): void {
        if (
            JointWorkspaceCodec.encode(descriptor) !==
            JointWorkspaceCodec.encode(publication.descriptor)
        ) {
            throw new Error('Joint workspace publication replaced its original descriptor proof');
        }
    }

    public static async descriptor(
        store: JointWorkspaceJournalStore,
        snapshot: JointWorkspaceJournalSnapshot,
        revision: bigint,
    ): Promise<JointWorkspaceDescriptor> {
        const reference: JointWorkspaceJournalReference | undefined = snapshot.references.find(
            (entry: JointWorkspaceJournalReference): boolean => entry.revision === revision,
        );
        if (reference === undefined) {
            throw new Error('Joint workspace revision was not retained');
        }
        const descriptor: JointWorkspaceDescriptor = await store.archive(revision);
        if (JointWorkspaceProof.bindingSha256(descriptor.binding) !== reference.bindingSha256) {
            throw new Error('Joint workspace archive differs from its original reference');
        }
        return descriptor;
    }
}
