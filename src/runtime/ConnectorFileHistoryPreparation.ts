// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

import type { ConnectorClientIdentity } from './ConnectorClientConfiguration.js';
import type { ConnectorLocalCapabilitySettings } from './ConnectorClientSettings.js';
import { ConnectorOperationJournal } from './ConnectorOperationJournal.js';
import type { ConnectorJournalPending } from './ConnectorJournalState.js';
import { ConnectorFileJournalCodec } from './ConnectorFileJournalCodec.js';
import { ConnectorFilesystem } from './ConnectorFilesystem.js';
import { ConnectorFilePolicy, type ConnectorFilePolicyDefinition } from './ConnectorFilePolicy.js';
import { ConnectorFileStageQuiescence } from './ConnectorFileStageQuiescence.js';
import type { ConnectorFileOperation } from 'nerva-connector-protocol/protocol/ConnectorFileJobs.js';
import {
    ConnectorFileFailure,
    type ConnectorFileResponse,
} from 'nerva-connector-protocol/protocol/ConnectorFiles.js';
import { ConnectorFileAction } from 'nerva-connector-protocol/protocol/ConnectorFileTypes.js';
import { ConnectorFilesCodec } from 'nerva-connector-protocol/protocol/ConnectorFilesCodec.js';
import { ExecutionConfiguration } from '../execution/ExecutionConfiguration.js';
import { ConnectorEffectKind } from './ConnectorEffectContext.js';
import { ConnectorEffectContextCodec } from './ConnectorEffectContextCodec.js';
import { KeyDerivationPurpose } from 'nerva-connector-protocol/identity/IdentityFormat.js';

/** Retaining an interrupted result is not a backend acknowledgment or permission to replace history. */
export enum ConnectorFileHistoryPreparationStatus {
    Idle = 'idle',
    AwaitingAcknowledgment = 'awaiting-acknowledgment',
    InterruptedAwaitingAcknowledgment = 'interrupted-awaiting-acknowledgment',
    Blocked = 'blocked',
}

/** Fixed local reasons contain no paths, request payloads, retained results or underlying errors. */
export enum ConnectorFileHistoryPreparationBlock {
    OriginalPolicyUnavailable = 'original-policy-unavailable',
    OriginalPolicyChanged = 'original-policy-changed',
    CleanupUnproven = 'cleanup-unproven',
    DurabilityUnconfirmed = 'durability-unconfirmed',
    StagesBusy = 'stages-busy',
    StagesUnknown = 'stages-unknown',
}

/** Only exact original ordering metadata leaves the encrypted journal consumer. */
export interface ConnectorFileHistoryPreparationState {
    readonly journalId: string;
    readonly acknowledgedSequence: bigint;
    readonly pendingJobId: string | null;
    readonly pendingSequence: bigint | null;
    readonly status: ConnectorFileHistoryPreparationStatus;
    readonly blocked: ConnectorFileHistoryPreparationBlock | null;
    readonly remoteAcknowledgmentPending: boolean;
}

/** Readiness requires both an acknowledged idle journal and proven quiescent private staging. */
export interface ConnectorFileHistoryPreparationReport {
    readonly configured: boolean;
    readonly ready: boolean;
    readonly history: ConnectorFileHistoryPreparationState | null;
    readonly stages: ConnectorFileStageQuiescence | null;
    readonly preparedPolicySha256: string | null;
}

/** Missing, corrupt or concurrently owned history is never replaced with an empty file journal. */
export class ConnectorFileHistoryPreparationError extends Error {
    /** This message is safe to display without exposing an underlying path or retained operation. */
    public constructor() {
        super('File history is unavailable or already owned; existing history was kept');
        this.name = 'ConnectorFileHistoryPreparationError';
    }
}

/** Existing-only local preparation cannot initialize, dispatch, acknowledge or reset file work. */
export class ConnectorFileHistoryPreparation {
    /** The caller owns stopped-runtime/installation locks; this method owns the existing Files journal and native resources. */
    public static async prepare(
        identity: ConnectorClientIdentity,
        signal: AbortSignal,
    ): Promise<ConnectorFileHistoryPreparationReport> {
        signal.throwIfAborted();
        const settings: ConnectorLocalCapabilitySettings | null = identity.settings.files;
        if (settings === null) {
            return {
                configured: false,
                ready: true,
                history: null,
                stages: null,
                preparedPolicySha256: null,
            };
        }
        if (process.platform !== 'linux' || identity.settings.slot !== 0) {
            throw new ConnectorFileHistoryPreparationError();
        }
        await using resources: AsyncDisposableStack = new AsyncDisposableStack();
        let journal: ConnectorOperationJournal<ConnectorFileOperation, ConnectorFileResponse>;
        try {
            journal = resources.use(
                await ConnectorOperationJournal.load(
                    settings.stateDirectory,
                    identity.settings.enrollmentId,
                    identity.key,
                    new ConnectorFileJournalCodec(),
                ),
            );
        } catch {
            signal.throwIfAborted();
            throw new ConnectorFileHistoryPreparationError();
        }
        signal.throwIfAborted();
        const pending: ConnectorJournalPending<
            ConnectorFileOperation,
            ConnectorFileResponse
        > | null = journal.pending;
        const mustRecover: boolean =
            pending !== null &&
            (pending.response === null || pending.request.action === ConnectorFileAction.Write);
        let definition: ConnectorFilePolicyDefinition;
        try {
            definition = await ConnectorFilePolicy.load(settings.policyFile);
        } catch {
            signal.throwIfAborted();
            return this.#unavailable(
                journal,
                mustRecover,
                ConnectorFileHistoryPreparationBlock.OriginalPolicyUnavailable,
            );
        }
        signal.throwIfAborted();
        const policySha256: string = ConnectorFilePolicy.commitment(definition);
        if (pending !== null && pending.request.policySha256 !== policySha256) {
            return this.#unavailable(
                journal,
                mustRecover,
                ConnectorFileHistoryPreparationBlock.OriginalPolicyChanged,
            );
        }
        signal.throwIfAborted();
        let filesystem: ConnectorFilesystem;
        try {
            filesystem = resources.use(
                await ConnectorFilesystem.load(
                    settings.policyFile,
                    [
                        identity.configurationFile,
                        identity.settings.privateKeyFile,
                        identity.settings.authorityPublicKeyFile,
                        settings.stateDirectory,
                        ...(identity.settings.execution === null
                            ? []
                            : await ExecutionConfiguration.protectedPaths(
                                  identity.settings.execution,
                              )),
                        ...(identity.settings.serverCaFile === null
                            ? []
                            : [identity.settings.serverCaFile]),
                    ],
                    policySha256,
                ),
            );
            if (filesystem.profile.policySha256 !== policySha256) {
                throw new Error('Original file policy changed');
            }
        } catch {
            signal.throwIfAborted();
            return this.#unavailable(
                journal,
                mustRecover,
                ConnectorFileHistoryPreparationBlock.OriginalPolicyUnavailable,
            );
        }
        signal.throwIfAborted();
        let stages: ConnectorFileStageQuiescence | null = null;
        if (pending !== null && pending.request.action === ConnectorFileAction.Write) {
            if (
                pending.response === null &&
                pending.effectContext.kind === ConnectorEffectKind.CapturedFile &&
                !(await this.#recover(identity, filesystem, pending, signal))
            ) {
                return this.#report(
                    journal,
                    ConnectorFileHistoryPreparationStatus.Blocked,
                    ConnectorFileHistoryPreparationBlock.CleanupUnproven,
                    null,
                    policySha256,
                );
            }
            stages = await this.#stages(filesystem, signal);
            if (stages !== ConnectorFileStageQuiescence.Quiescent) {
                return this.#report(
                    journal,
                    ConnectorFileHistoryPreparationStatus.Blocked,
                    ConnectorFileHistoryPreparationBlock.CleanupUnproven,
                    stages,
                    policySha256,
                );
            }
        }
        signal.throwIfAborted();
        let interrupted: boolean = false;
        if (pending !== null && pending.response === null) {
            try {
                await journal.finish(pending, {
                    ok: false,
                    error: ConnectorFilesCodec.isMutation(pending.request.action)
                        ? ConnectorFileFailure.Indeterminate
                        : ConnectorFileFailure.Unavailable,
                });
                interrupted = true;
            } catch {
                signal.throwIfAborted();
                return this.#report(
                    journal,
                    ConnectorFileHistoryPreparationStatus.Blocked,
                    ConnectorFileHistoryPreparationBlock.DurabilityUnconfirmed,
                    null,
                    policySha256,
                );
            }
        }
        signal.throwIfAborted();
        if (stages === null) {
            stages = await this.#stages(filesystem, signal);
        }
        if (stages !== ConnectorFileStageQuiescence.Quiescent) {
            return this.#report(
                journal,
                ConnectorFileHistoryPreparationStatus.Blocked,
                stages === ConnectorFileStageQuiescence.Busy
                    ? ConnectorFileHistoryPreparationBlock.StagesBusy
                    : ConnectorFileHistoryPreparationBlock.StagesUnknown,
                stages,
                policySha256,
            );
        }
        return this.#report(
            journal,
            journal.pending === null
                ? ConnectorFileHistoryPreparationStatus.Idle
                : interrupted
                  ? ConnectorFileHistoryPreparationStatus.InterruptedAwaitingAcknowledgment
                  : ConnectorFileHistoryPreparationStatus.AwaitingAcknowledgment,
            null,
            stages,
            policySha256,
        );
    }

    /** Cleanup requires persisted provenance plus both the current parent capture and the native FD check. */
    static async #recover(
        identity: ConnectorClientIdentity,
        filesystem: ConnectorFilesystem,
        pending: ConnectorJournalPending<ConnectorFileOperation, ConnectorFileResponse>,
        signal: AbortSignal,
    ): Promise<boolean> {
        if (pending.effectContext.kind !== ConnectorEffectKind.CapturedFile) {
            return false;
        }
        try {
            const current: typeof pending.effectContext = await filesystem.effectContext(
                pending.request.rootId,
            );
            signal.throwIfAborted();
            if (!ConnectorEffectContextCodec.same(current, pending.effectContext)) {
                return false;
            }
            const material: Buffer = Buffer.from(
                JSON.stringify([pending.jobId, pending.dispatchId, pending.requestHash]),
            );
            const token: Buffer = identity.key.deriveKey(
                KeyDerivationPurpose.WriteStaging,
                material,
            );
            try {
                await filesystem.cleanupWrite(
                    pending.request,
                    token.toString('hex'),
                    pending.effectContext,
                );
            } finally {
                token.fill(0);
                material.fill(0);
            }
            signal.throwIfAborted();
            return true;
        } catch {
            signal.throwIfAborted();
            return false;
        }
    }

    static async #stages(
        filesystem: ConnectorFilesystem,
        signal: AbortSignal,
    ): Promise<ConnectorFileStageQuiescence> {
        signal.throwIfAborted();
        try {
            const stages: ConnectorFileStageQuiescence = await filesystem.preparationStages(signal);
            signal.throwIfAborted();
            return stages;
        } catch {
            signal.throwIfAborted();
            return ConnectorFileStageQuiescence.Unknown;
        }
    }

    static #unavailable(
        journal: ConnectorOperationJournal<ConnectorFileOperation, ConnectorFileResponse>,
        mustRecover: boolean,
        blocked: ConnectorFileHistoryPreparationBlock,
    ): ConnectorFileHistoryPreparationReport {
        return journal.pending !== null && !mustRecover
            ? this.#report(journal, ConnectorFileHistoryPreparationStatus.AwaitingAcknowledgment)
            : this.#report(journal, ConnectorFileHistoryPreparationStatus.Blocked, blocked);
    }

    static #report(
        journal: ConnectorOperationJournal<ConnectorFileOperation, ConnectorFileResponse>,
        status: ConnectorFileHistoryPreparationStatus,
        blocked: ConnectorFileHistoryPreparationBlock | null = null,
        stages: ConnectorFileStageQuiescence | null = null,
        preparedPolicySha256: string | null = null,
    ): ConnectorFileHistoryPreparationReport {
        const pending: ConnectorJournalPending<
            ConnectorFileOperation,
            ConnectorFileResponse
        > | null = journal.pending;
        return {
            configured: true,
            ready:
                pending === null &&
                stages === ConnectorFileStageQuiescence.Quiescent &&
                status === ConnectorFileHistoryPreparationStatus.Idle,
            history: {
                journalId: journal.id,
                acknowledgedSequence: journal.acknowledgedSequence,
                pendingJobId: pending?.jobId ?? null,
                pendingSequence: pending?.sequence ?? null,
                status,
                blocked,
                remoteAcknowledgmentPending: pending !== null && pending.response !== null,
            },
            stages,
            preparedPolicySha256,
        };
    }
}
