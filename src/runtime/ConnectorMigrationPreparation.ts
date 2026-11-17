// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { type ExecutionRequest } from '../execution/ExecutionJobs.js';
import { ExecutionLane } from 'nerva-connector-protocol/execution/ExecutionLane.js';
import { ExecutionJournalCodec } from '../execution/ExecutionJournalCodec.js';
import type { ExecutionResult } from '../execution/ExecutionTypes.js';
import type { ExecutionOutput } from '../execution/ExecutionOutput.js';
import type { ConnectorFileOperation } from 'nerva-connector-protocol/protocol/ConnectorFileJobs.js';
import type { ConnectorFileResponse } from 'nerva-connector-protocol/protocol/ConnectorFiles.js';
import { ConnectorOperationSchema } from 'nerva-connector-protocol/protocol/ConnectorOperationSchema.js';
import {
    ConnectorMigrationLimits,
    type ConnectorMigrationPlan,
    type ConnectorMigrationPlanBody,
    type ConnectorMigrationSource,
    type ConnectorMigrationExpected,
    type ConnectorMigrationOriginal,
} from 'nerva-connector-protocol/protocol/ConnectorAdmissionMigration.js';
import { ConnectorMigrationPlanCodec } from 'nerva-connector-protocol/protocol/ConnectorMigrationPlanCodec.js';
import { ConnectorAdmissionMigrationProof } from '../protocol/ConnectorAdmissionMigrationProof.js';
import { ConnectorApprovedJournalMigration } from './ConnectorApprovedJournalMigration.js';
import { ConnectorMigrationInstallation } from './ConnectorMigrationInstallation.js';
import { ConnectorJournalMigrationSourceCodec } from './ConnectorJournalMigrationSourceCodec.js';
import type { ConnectorJournalMigrationSource } from './ConnectorJournalMigrationSource.js';
import { ConnectorJournalStore, ConnectorJournalOpenIntent } from './ConnectorJournalStore.js';
import type { ConnectorJournalRecord } from './ConnectorJournalRecord.js';
import type { ConnectorOperationCodec, ConnectorStorageCodec } from './ConnectorOperationCodec.js';
import { ConnectorFileJournalCodec } from './ConnectorFileJournalCodec.js';

/** Preparation reads authenticated old ciphertext without providing any path that can rewrite it. */
class ConnectorMigrationInspectionCodec<
    TRequest,
    TResponse,
    TProgress = never,
> implements ConnectorStorageCodec<
    ConnectorJournalMigrationSource<TRequest, TResponse, TProgress>
> {
    readonly #source: ConnectorJournalMigrationSourceCodec<TRequest, TResponse, TProgress>;
    public constructor(operation: ConnectorOperationCodec<TRequest, TResponse, TProgress>) {
        this.#source = new ConnectorJournalMigrationSourceCodec(operation);
    }
    public read(
        raw: unknown,
        sourceSha256: string,
    ): ConnectorJournalMigrationSource<TRequest, TResponse, TProgress> {
        return this.#source.read(raw, sourceSha256);
    }
    public encode(_state: ConnectorJournalMigrationSource<TRequest, TResponse, TProgress>): string {
        throw new Error('Migration source inspection cannot write retained history');
    }
}

/** A signed, source-bound plan is prepared while all configured journals and installation writers are stopped. */
export class ConnectorMigrationPreparation {
    /** One no-overwrite private plan is retained across interruption and operator approval. */
    public static readonly filename: string = 'admission-migration-plan.json';

    /** Repeated preparation reuses the full first device proof only when every exact source is still unchanged. */
    public static async run(path: string, signal: AbortSignal): Promise<ConnectorMigrationPlan> {
        signal.throwIfAborted();
        await using installation: ConnectorMigrationInstallation =
            await ConnectorMigrationInstallation.open(path);
        const sources: ConnectorMigrationSource[] = [];
        if (installation.identity.settings.files !== null) {
            sources.push(
                await this.#source<ConnectorFileOperation, ConnectorFileResponse>(
                    installation,
                    installation.identity.settings.files.stateDirectory,
                    new ConnectorFileJournalCodec(),
                ),
            );
        }
        if (installation.identity.settings.execution !== null) {
            for (const lane of Object.values(ExecutionLane)) {
                signal.throwIfAborted();
                sources.push(
                    await this.#source<ExecutionRequest, ExecutionResult, ExecutionOutput>(
                        installation,
                        join(installation.identity.settings.execution.stateDirectory, lane),
                        new ExecutionJournalCodec(lane),
                    ),
                );
            }
        }
        const expected: ConnectorMigrationExpected = {
            authorityId: installation.identity.authority.authorityId,
            authorityPublicKey: installation.identity.authority.publicKey,
            environmentId: installation.identity.settings.environmentId,
            enrollmentId: installation.identity.settings.enrollmentId,
            devicePublicKey: installation.identity.publicKey,
        };
        if (await installation.runtime.exists(this.filename + '.partial')) {
            throw new Error(
                'Migration plan has an unresolved partial; preserve the original history',
            );
        }
        if (await installation.runtime.exists(this.filename)) {
            const original: ConnectorMigrationPlan = ConnectorMigrationPlanCodec.decode(
                new TextDecoder('utf-8', { fatal: true }).decode(
                    await installation.runtime.read(
                        this.filename,
                        ConnectorMigrationLimits.planBytes,
                    ),
                ),
            );
            if (
                !ConnectorAdmissionMigrationProof.verifyPlan(expected, original) ||
                Buffer.compare(
                    Buffer.from(
                        ConnectorAdmissionMigrationProof.planPayload(
                            this.#body(expected, original.planId, sources),
                        ),
                    ),
                    Buffer.from(
                        ConnectorAdmissionMigrationProof.planPayload(
                            this.#body(expected, original.planId, original.sources),
                        ),
                    ),
                ) !== 0
            ) {
                throw new Error(
                    'Prepared migration source changed; keep the first signed plan and all histories',
                );
            }
            return original;
        }
        const plan: ConnectorMigrationPlan = ConnectorAdmissionMigrationProof.signPlan(
            installation.identity.key,
            this.#body(expected, randomUUID(), sources),
        );
        signal.throwIfAborted();
        await installation.runtime.write(
            this.filename,
            Buffer.from(ConnectorMigrationPlanCodec.encode(plan)),
            ConnectorMigrationLimits.planBytes,
            true,
        );
        return plan;
    }

    static #body(
        expected: ConnectorMigrationExpected,
        planId: string,
        sources: readonly ConnectorMigrationSource[],
    ): ConnectorMigrationPlanBody {
        return {
            authorityId: expected.authorityId,
            environmentId: expected.environmentId,
            enrollmentId: expected.enrollmentId,
            devicePublicKey: expected.devicePublicKey,
            planId,
            targetOperationSchema: ConnectorOperationSchema.ExplicitAdmission,
            sources,
        };
    }

    static async #source<TRequest, TResponse, TProgress = never>(
        installation: ConnectorMigrationInstallation,
        directory: string,
        operation: ConnectorOperationCodec<TRequest, TResponse, TProgress>,
    ): Promise<ConnectorMigrationSource> {
        const store: ConnectorJournalStore<
            ConnectorJournalMigrationSource<TRequest, TResponse, TProgress>
        > = installation.own(
            await ConnectorJournalStore.open(
                directory,
                installation.identity.settings.enrollmentId,
                installation.identity.key,
                operation.purpose,
                new ConnectorMigrationInspectionCodec(operation),
                ConnectorJournalOpenIntent.Migration,
            ),
        );
        const record: ConnectorJournalRecord<
            ConnectorJournalMigrationSource<TRequest, TResponse, TProgress>
        > = await store.readRecord();
        const pending: ConnectorMigrationOriginal | null =
            record.state.pending === null
                ? null
                : {
                      jobId: record.state.pending.jobId,
                      sequence: record.state.pending.sequence,
                      dispatchId: record.state.pending.dispatchId,
                      requestHash: record.state.pending.requestHash,
                  };
        return {
            lane: ConnectorApprovedJournalMigration.lane(operation.purpose),
            sourceSha256: record.sourceSha256,
            journalId: record.state.journalId,
            acknowledgedSequence: record.state.acknowledgedSequence,
            receipt: record.state.receipt,
            pending,
        };
    }
}
