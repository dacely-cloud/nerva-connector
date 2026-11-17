// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

import type { ConnectorStorageCodec } from '../runtime/ConnectorOperationCodec.js';
import type { JointWorkspaceDescriptor } from 'nerva-connector-protocol/workspace/JointWorkspaceBinding.js';
import { JointWorkspaceCodec } from 'nerva-connector-protocol/workspace/JointWorkspaceCodec.js';
import { JointWorkspaceJournalContext } from './JointWorkspaceJournalContext.js';

/** Each immutable encrypted archive leaf retains the complete original signed descriptor, never a reconstructed proof. */
export class JointWorkspaceArchiveCodec implements ConnectorStorageCodec<JointWorkspaceDescriptor> {
    public constructor(public readonly context: JointWorkspaceJournalContext) {}
    public read(raw: unknown): JointWorkspaceDescriptor {
        return this.context.descriptor(JointWorkspaceCodec.descriptor(raw));
    }
    public encode(value: JointWorkspaceDescriptor): string {
        return JointWorkspaceCodec.encode(this.context.descriptor(value));
    }
}
