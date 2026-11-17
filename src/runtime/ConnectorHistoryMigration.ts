// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

import { dirname, join } from 'node:path';
import { type ConnectorClientIdentity } from './ConnectorClientConfiguration.js';
import { ConnectorPrivateDirectory } from './ConnectorPrivateDirectory.js';
import {
    ConnectorHistoryMigrationMarker,
    ConnectorHistoryMigrationPhase,
    type ConnectorHistoryMigrationReceipt,
    type ConnectorHistoryMigrationEntry,
} from './ConnectorHistoryMigrationMarker.js';
import {
    ConnectorJournalMigrationOwner,
    type ConnectorHistoryMigrationPlan,
} from './ConnectorJournalMigrationOwner.js';
import { ConnectorFileJournalCodec } from './ConnectorFileJournalCodec.js';
import { ExecutionJournalCodec } from '../execution/ExecutionJournalCodec.js';
import { ExecutionLane } from 'nerva-connector-protocol/execution/ExecutionLane.js';
import { ProtectedFiles } from '../local/ProtectedFiles.js';
import { ConnectorMigrationInstallation } from './ConnectorMigrationInstallation.js';
import { ConnectorMigrationEvidence } from './ConnectorMigrationEvidence.js';
import { ConnectorAdmissionMigrationProof } from '../protocol/ConnectorAdmissionMigrationProof.js';
import type {
    ConnectorMigrationApproval,
    ConnectorMigrationTarget,
} from 'nerva-connector-protocol/protocol/ConnectorAdmissionMigration.js';

/** Completion converts only local storage format; it is not backend acknowledgment, physical proof or policy activation. */
export interface ConnectorHistoryMigrationReport {
    readonly complete: true;
    readonly upgraded: number;
    readonly alreadyCurrent: number;
    readonly historicalPending: number;
}

/** One safe message covers missing, corrupt, changed and concurrently owned history without leaking retained contents. */
export class ConnectorHistoryMigrationError extends Error {
    public constructor(canceled: boolean = false) {
        super(
            canceled
                ? 'History migration canceled; keep existing history and retry migration'
                : 'History migration unavailable; stop the connector and keep all original histories',
        );
        this.name = 'ConnectorHistoryMigrationError';
    }
}

/** Explicit stopped migration prevalidates every configured original before any format replacement. */
export class ConnectorHistoryMigration {
    /** Runtime callers already own their Runtime lock; an incomplete or malformed marker forbids capability startup. */
    public static async requireComplete(identity: ConnectorClientIdentity): Promise<void> {
        const path: string = join(
            dirname(identity.settings.privateKeyFile),
            ConnectorHistoryMigrationMarker.filename,
        );
        try {
            if (await ProtectedFiles.exists(path + '.partial')) {
                throw new ConnectorHistoryMigrationError();
            }
            if (!(await ProtectedFiles.exists(path))) {
                return;
            }
            const bytes: Buffer = await ProtectedFiles.readPrivate(
                path,
                ConnectorHistoryMigrationMarker.maximumBytes,
            );
            const marker: ConnectorHistoryMigrationReceipt = ConnectorHistoryMigrationMarker.read(
                bytes,
                identity,
            );
            if (marker.phase !== ConnectorHistoryMigrationPhase.Complete) {
                throw new ConnectorHistoryMigrationError();
            }
            await ConnectorMigrationEvidence.requireComplete(
                identity,
                marker.approvalSha256,
                marker.appliedSha256,
                marker.entries,
            );
        } catch {
            throw new ConnectorHistoryMigrationError();
        }
    }

    /** No network, native effect, journal initialization, acknowledgment, enrollment or capability change occurs. */
    public static async run(
        path: string,
        signal: AbortSignal,
        input: ConnectorMigrationApproval | null = null,
    ): Promise<ConnectorHistoryMigrationReport> {
        try {
            signal.throwIfAborted();
            await using installation: ConnectorMigrationInstallation =
                await ConnectorMigrationInstallation.open(path);
            const identity: ConnectorClientIdentity = installation.identity;
            const runtime: ConnectorPrivateDirectory = installation.runtime;
            const approval: ConnectorMigrationApproval = await ConnectorMigrationEvidence.approval(
                installation,
                input,
            );
            const approvalSha256: string =
                ConnectorAdmissionMigrationProof.approvalSha256(approval);
            const plans: ConnectorHistoryMigrationPlan[] = [];
            if (identity.settings.files !== null) {
                signal.throwIfAborted();
                plans.push(
                    installation.own(
                        await ConnectorJournalMigrationOwner.load(
                            identity.settings.files.stateDirectory,
                            identity,
                            new ConnectorFileJournalCodec(),
                            approval,
                        ),
                    ),
                );
            }
            if (identity.settings.execution !== null) {
                for (const lane of Object.values(ExecutionLane)) {
                    signal.throwIfAborted();
                    plans.push(
                        installation.own(
                            await ConnectorJournalMigrationOwner.load(
                                join(identity.settings.execution.stateDirectory, lane),
                                identity,
                                new ExecutionJournalCodec(lane),
                                approval,
                            ),
                        ),
                    );
                }
            }
            signal.throwIfAborted();
            await runtime.cleanPartial(
                ConnectorHistoryMigrationMarker.filename,
                ConnectorHistoryMigrationMarker.maximumBytes,
            );
            let marker: ConnectorHistoryMigrationReceipt;
            const exists: boolean = await runtime.exists(ConnectorHistoryMigrationMarker.filename);
            if (exists) {
                marker = ConnectorHistoryMigrationMarker.read(
                    await runtime.read(
                        ConnectorHistoryMigrationMarker.filename,
                        ConnectorHistoryMigrationMarker.maximumBytes,
                    ),
                    identity,
                );
                if (
                    marker.entries.length !== plans.length ||
                    marker.approvalSha256 !== approvalSha256
                ) {
                    throw new ConnectorHistoryMigrationError();
                }
                for (let index: number = 0; index < plans.length; index++) {
                    const plan: ConnectorHistoryMigrationPlan | undefined = plans[index];
                    const entry: ConnectorHistoryMigrationEntry | undefined = marker.entries[index];
                    if (plan === undefined || entry === undefined) {
                        throw new ConnectorHistoryMigrationError();
                    }
                    plan.match(entry, marker.phase === ConnectorHistoryMigrationPhase.Complete);
                }
            } else {
                if (plans.some((plan: ConnectorHistoryMigrationPlan): boolean => !plan.original)) {
                    throw new ConnectorHistoryMigrationError();
                }
                marker = ConnectorHistoryMigrationMarker.create(
                    identity,
                    ConnectorHistoryMigrationPhase.Prepared,
                    plans.map(
                        (plan: ConnectorHistoryMigrationPlan): ConnectorHistoryMigrationEntry =>
                            plan.entry,
                    ),
                    approvalSha256,
                    null,
                );
            }
            const report: ConnectorHistoryMigrationReport = {
                complete: true,
                upgraded: plans.filter(
                    (plan: ConnectorHistoryMigrationPlan): boolean => plan.original,
                ).length,
                alreadyCurrent: plans.filter(
                    (plan: ConnectorHistoryMigrationPlan): boolean => !plan.original,
                ).length,
                historicalPending: plans.filter(
                    (plan: ConnectorHistoryMigrationPlan): boolean => plan.historicalPending,
                ).length,
            };
            if (exists && marker.phase === ConnectorHistoryMigrationPhase.Complete) {
                await ConnectorMigrationEvidence.requireComplete(
                    identity,
                    marker.approvalSha256,
                    marker.appliedSha256,
                    marker.entries,
                );
                return report;
            }
            signal.throwIfAborted();
            await ConnectorMigrationEvidence.retainApproval(runtime, approval);
            if (!exists) {
                await this.#write(runtime, marker, true);
            }
            for (const plan of plans) {
                signal.throwIfAborted();
                await plan.commit();
            }
            signal.throwIfAborted();
            const targets: ConnectorMigrationTarget[] = [];
            for (const plan of plans) {
                targets.push(await plan.target());
            }
            const appliedSha256: string = ConnectorMigrationEvidence.appliedSha256(
                await ConnectorMigrationEvidence.applied(installation, approval, targets),
            );
            signal.throwIfAborted();
            await this.#write(
                runtime,
                ConnectorHistoryMigrationMarker.create(
                    identity,
                    ConnectorHistoryMigrationPhase.Complete,
                    marker.entries,
                    marker.approvalSha256,
                    appliedSha256,
                ),
                false,
            );
            signal.throwIfAborted();
            return report;
        } catch {
            throw new ConnectorHistoryMigrationError(signal.aborted);
        }
    }

    static async #write(
        owner: ConnectorPrivateDirectory,
        marker: ConnectorHistoryMigrationReceipt,
        initialize: boolean,
    ): Promise<void> {
        const bytes: Buffer = Buffer.from(JSON.stringify(marker));
        try {
            await owner.write(
                ConnectorHistoryMigrationMarker.filename,
                bytes,
                ConnectorHistoryMigrationMarker.maximumBytes,
                initialize,
            );
        } finally {
            bytes.fill(0);
        }
    }
}
