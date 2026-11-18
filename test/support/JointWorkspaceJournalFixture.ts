// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

import { mkdtemp, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { JointWorkspaceDescriptor } from 'nerva-connector-protocol/workspace/JointWorkspaceBinding.js';
import {
    JointWorkspaceAssembly,
    type JointWorkspaceSources,
} from '../../src/workspace/JointWorkspaceAssembly.js';
import { JointWorkspacePublicationProof } from 'nerva-connector-protocol/workspace/JointWorkspacePublicationProof.js';
import { JointWorkspaceProof } from 'nerva-connector-protocol/workspace/JointWorkspaceProof.js';
import { JointWorkspaceReceiptProof } from 'nerva-connector-protocol/workspace/JointWorkspaceReceiptProof.js';
import type { JointWorkspacePublication } from 'nerva-connector-protocol/workspace/JointWorkspacePublication.js';
import type { JointWorkspaceReceipt } from 'nerva-connector-protocol/workspace/JointWorkspaceReceipt.js';
import { JointWorkspaceJournal } from '../../src/workspace/JointWorkspaceJournal.js';
import type { JointWorkspaceJournalIdentity } from '../../src/workspace/JointWorkspaceJournalTypes.js';
import type {
    ExecutionRootGrant,
    ExecutionProgramGrant,
} from 'nerva-connector-protocol/execution/ExecutionJobs.js';
import { JointWorkspaceReceiptFixture } from './JointWorkspaceReceiptFixture.js';
import { SigningKey } from '../../src/identity/SigningKey.js';

/** Private real filesystem journals use synthetic protocol captures, never a claim of actual workspace admission. */
export class JointWorkspaceJournalFixture
    extends JointWorkspaceReceiptFixture
    implements AsyncDisposable
{
    public readonly signal: AbortSignal = new AbortController().signal;
    private constructor(public readonly directory: string) {
        super();
    }

    public static async create(): Promise<JointWorkspaceJournalFixture> {
        return new JointWorkspaceJournalFixture(
            await mkdtemp(join(homedir(), '.nerva-workspace-journal-')),
        );
    }

    public get journalIdentity(): JointWorkspaceJournalIdentity {
        const sources: JointWorkspaceSources = this.sources();
        return {
            scope: this.scope,
            fileJournalId: sources.fileJournalId,
            executionJournals: sources.executionJournals,
        };
    }

    public async initialize(): Promise<void> {
        await JointWorkspaceJournal.initialize(
            this.directory,
            this.device,
            this.journalIdentity,
            this.signal,
        );
    }

    public async open(signal: AbortSignal = this.signal): Promise<JointWorkspaceJournal> {
        return await JointWorkspaceJournal.open(
            this.directory,
            this.device,
            this.journalIdentity,
            signal,
        );
    }

    public signed(
        revision: bigint,
        fileRootId: string = 'file-project',
        executionRootId: string = 'command-project',
    ): JointWorkspaceDescriptor {
        const sources: JointWorkspaceSources = this.sources();
        return JointWorkspaceAssembly.create(this.device, this.scope, revision, {
            ...sources,
            fileProfile: { ...sources.fileProfile, roots: [fileRootId] },
            executionProfile: {
                ...sources.executionProfile,
                roots: sources.executionProfile.roots.map(
                    (root: ExecutionRootGrant): ExecutionRootGrant => ({
                        ...root,
                        id: executionRootId,
                    }),
                ),
                programs: sources.executionProfile.programs.map(
                    (program: ExecutionProgramGrant): ExecutionProgramGrant => ({
                        ...program,
                        rootIds: [executionRootId],
                    }),
                ),
            },
            file: { ...sources.file, rootId: fileRootId },
            execution: { ...sources.execution, rootId: executionRootId },
        });
    }

    public publicationFor(
        descriptor: JointWorkspaceDescriptor,
        leaseByte: number = 1,
    ): JointWorkspacePublication {
        return JointWorkspacePublicationProof.sign(SigningKey, this.device, {
            enrollmentId: this.expected.enrollmentId,
            slot: 0,
            leaseId: Buffer.alloc(32, leaseByte).toString('base64url'),
            descriptor,
        });
    }

    public receiptFor(publication: JointWorkspacePublication): JointWorkspaceReceipt {
        return JointWorkspaceReceiptProof.sign(this.authority, {
            authorityId: this.expected.authorityId,
            environmentId: this.expected.environmentId,
            enrollmentId: this.expected.enrollmentId,
            slot: 0,
            leaseId: publication.leaseId,
            bindingRevision: publication.descriptor.binding.revision,
            bindingSha256: JointWorkspaceProof.bindingSha256(publication.descriptor.binding),
            publicationSha256: JointWorkspaceReceiptProof.publicationSha256(publication),
            issuedAtMs: this.nowMs,
        });
    }

    public async [Symbol.asyncDispose](): Promise<void> {
        super[Symbol.dispose]();
        await rm(this.directory, { recursive: true, force: true });
    }
}
