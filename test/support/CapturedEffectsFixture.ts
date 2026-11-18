// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

import { randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import { basename } from 'node:path';
import { ConnectorFilesystem } from '../../src/runtime/ConnectorFilesystem.js';
import type { ConnectorCapturedFileEffect } from '../../src/runtime/ConnectorEffectContext.js';
import { ConnectorOperationJournal } from '../../src/runtime/ConnectorOperationJournal.js';
import { ConnectorJournalStore } from '../../src/runtime/ConnectorJournalStore.js';
import { RuntimeMigrationApprovalFixture } from './RuntimeMigrationApprovalFixture.js';
import type { ConnectorMigrationApproval } from 'nerva-connector-protocol/protocol/ConnectorAdmissionMigration.js';
import { ConnectorHistoryMigration } from '../../src/runtime/ConnectorHistoryMigration.js';
import { ConnectorFileJournalCodec } from '../../src/runtime/ConnectorFileJournalCodec.js';
import { ConnectorFileJobsCodec } from 'nerva-connector-protocol/protocol/ConnectorFileJobsCodec.js';
import { ConnectorFileProof } from 'nerva-connector-protocol/protocol/ConnectorFileProof.js';
import { SignaturePurpose } from 'nerva-connector-protocol/identity/IdentityFormat.js';
import {
    ConnectorFileMode,
    type ConnectorFileResponse,
} from 'nerva-connector-protocol/protocol/ConnectorFiles.js';
import type {
    ConnectorFileOperation,
    ConnectorFilePermit,
} from 'nerva-connector-protocol/protocol/ConnectorFileJobs.js';
import { FileHistoryFixture } from './FileHistoryFixture.js';
import {
    OriginalJournalFixtureCodec,
    type OriginalJournalFixtureSnapshot,
} from './OriginalJournalFixtureCodec.js';

/** A seed is genuine opened-root provenance and, optionally, a real successfully published native write. */
export interface CapturedOriginal {
    readonly effect: ConnectorCapturedFileEffect;
    readonly response: ConnectorFileResponse | null;
}

/** Owns disposable identity, encrypted journal and private native roots; never substitutes synthetic filesystem identity. */
export class CapturedEffectsFixture implements AsyncDisposable {
    private constructor(public readonly history: FileHistoryFixture) {}

    /** The selected helper must be the freshly built capture-capable ELF supplied by the qualification command. */
    public static async create(
        initialize: boolean = true,
        parent: string = homedir(),
    ): Promise<CapturedEffectsFixture> {
        return new CapturedEffectsFixture(
            await FileHistoryFixture.create(ConnectorFileMode.ReadWrite, initialize, null, parent),
        );
    }

    /** A real composite fixture authority signs current lease metadata for the original unchanged request. */
    public permit(original: ConnectorFilePermit = this.history.permit()): ConnectorFilePermit {
        const now: bigint = BigInt(Date.now());
        const unsigned: Omit<ConnectorFilePermit, 'signature'> = {
            ...original,
            issuedAtMs: now,
            expiresAtMs: now + 10000n,
        };
        return {
            ...unsigned,
            signature: this.history.identity.key.sign(
                SignaturePurpose.OperationFilePermit,
                ConnectorFileProof.permit(unsigned),
            ),
        };
    }

    /** Only the established device-derived staging leaf is used by these original writes. */
    public token(permit: ConnectorFilePermit): string {
        return basename(this.history.staged(permit)).slice('write-'.length);
    }

    /** Native code and roots are opened under the actual current helper digest and private-path exclusions. */
    public async filesystem(): Promise<ConnectorFilesystem> {
        return await ConnectorFilesystem.load(this.history.files.policy, [
            this.history.identity.configurationFile,
            this.history.identity.settings.privateKeyFile,
            this.history.identity.settings.authorityPublicKeyFile,
            this.history.state,
        ]);
    }

    /** Current Started capture is durably written before any optional real native effect or terminal result. */
    public async seed(
        permit: ConnectorFilePermit,
        complete: boolean = false,
    ): Promise<CapturedOriginal> {
        await using filesystem: ConnectorFilesystem = await this.filesystem();
        const effect: ConnectorCapturedFileEffect = await filesystem.effectContext(
            permit.request.rootId,
        );
        await using journal: ConnectorOperationJournal<
            ConnectorFileOperation,
            ConnectorFileResponse
        > = await this.history.journal();
        if (!(await journal.begin(permit, effect)).fresh) {
            throw new Error('Fresh owned fixture journal required');
        }
        if (!complete) {
            return { effect, response: null };
        }
        const response: ConnectorFileResponse = await filesystem.dispatchBound(
            ConnectorFileJobsCodec.encode(permit.request),
            this.token(permit),
            effect,
        );
        if (!response.ok) {
            throw new Error('Real fixture publication failed');
        }
        await filesystem.cleanupWrite(permit.request, this.token(permit), effect);
        await journal.finish(permit, response);
        return { effect, response };
    }

    /** Only explicit migration may turn exact old input into HistoricalUnproven; runtime begin cannot manufacture it. */
    public async historical(permit: ConnectorFilePermit): Promise<void> {
        const codec: ConnectorFileJournalCodec = new ConnectorFileJournalCodec();
        {
            await using store: ConnectorJournalStore<
                OriginalJournalFixtureSnapshot<ConnectorFileOperation, ConnectorFileResponse>
            > = await ConnectorJournalStore.open(
                this.history.state,
                this.history.identity.settings.enrollmentId,
                this.history.identity.key,
                codec.purpose,
                new OriginalJournalFixtureCodec(codec),
            );
            await store.write(
                {
                    journalId: randomBytes(32).toString('hex'),
                    acknowledgedSequence: 0n,
                    receipt: null,
                    pending: {
                        jobId: permit.jobId,
                        sequence: permit.sequence,
                        dispatchId: permit.dispatchId,
                        requestHash: permit.requestHash,
                        request: permit.request,
                        response: null,
                        progress: null,
                    },
                },
                true,
            );
        }
        const approval: ConnectorMigrationApproval = await RuntimeMigrationApprovalFixture.prepare(
            this.history.identity,
        );
        await ConnectorHistoryMigration.run(
            this.history.identity.configurationFile,
            new AbortController().signal,
            approval,
        );
    }

    /** All clients, journals and native owners must finish before this removes only its owned fixture directory. */
    public async [Symbol.asyncDispose](): Promise<void> {
        await this.history[Symbol.asyncDispose]();
    }
}
