// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

import type { JointWorkspaceDescriptor } from 'nerva-connector-protocol/workspace/JointWorkspaceBinding.js';
import { JointWorkspaceProof } from 'nerva-connector-protocol/workspace/JointWorkspaceProof.js';
import {
    JointWorkspaceJournalLimits,
    type JointWorkspaceJournalSnapshot,
    type JointWorkspaceJournalPair,
    type JointWorkspaceJournalReference,
} from './JointWorkspaceJournalTypes.js';

/** Pure bounded head transitions preserve permanent archive references and exact current alias-pair identity. */
export class JointWorkspaceJournalTransition {
    public static pairs(
        snapshot: JointWorkspaceJournalSnapshot,
        descriptor: JointWorkspaceDescriptor,
    ): readonly JointWorkspaceJournalPair[] {
        const binding: JointWorkspaceDescriptor['binding'] = descriptor.binding;
        const pair: JointWorkspaceJournalPair = Object.freeze({
            fileRootId: binding.fileRootId,
            executionRootId: binding.executionRootId,
            revision: binding.revision,
        });
        const rest: readonly JointWorkspaceJournalPair[] = snapshot.pairs.filter(
            (entry: JointWorkspaceJournalPair): boolean =>
                entry.fileRootId !== pair.fileRootId ||
                entry.executionRootId !== pair.executionRootId,
        );
        if (rest.length >= JointWorkspaceJournalLimits.pairs) {
            throw new Error('Joint workspace current alias-pair quota exhausted');
        }
        return Object.freeze([...rest, pair]);
    }

    /** An already-published archive can finalize only its original durable reservation. */
    public static finalize(
        snapshot: JointWorkspaceJournalSnapshot,
        descriptor: JointWorkspaceDescriptor,
    ): JointWorkspaceJournalSnapshot {
        if (descriptor.binding.revision !== snapshot.reservedRevision) {
            throw new Error('Joint workspace archive lost its original reservation');
        }
        const references: readonly JointWorkspaceJournalReference[] = Object.freeze([
            ...snapshot.references,
            Object.freeze({
                revision: descriptor.binding.revision,
                bindingSha256: JointWorkspaceProof.bindingSha256(descriptor.binding),
            }),
        ]);
        return Object.freeze({
            ...snapshot,
            reservedRevision: null,
            references,
            pairs: this.pairs(snapshot, descriptor),
        });
    }
}
