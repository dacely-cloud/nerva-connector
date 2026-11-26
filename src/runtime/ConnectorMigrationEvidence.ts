// SPDX-FileCopyrightText: 2026 Dacely <business@dacely.com>
// SPDX-License-Identifier: LicenseRef-Proprietary

import {
    ConnectorMigrationLimits,
    type ConnectorMigrationApproval,
    type ConnectorMigrationApplied,
    type ConnectorMigrationTarget,
    type ConnectorMigrationExpected,
    type ConnectorMigrationPlan,
} from 'nerva-connector-protocol/protocol/ConnectorAdmissionMigration.js';
import { ConnectorMigrationPlanCodec } from 'nerva-connector-protocol/protocol/ConnectorMigrationPlanCodec.js';
import { ConnectorMigrationApprovalCodec } from 'nerva-connector-protocol/protocol/ConnectorMigrationApprovalCodec.js';
import { ConnectorMigrationAppliedCodec } from 'nerva-connector-protocol/protocol/ConnectorMigrationAppliedCodec.js';
import { ConnectorAdmissionMigrationProof } from 'nerva-connector-protocol/protocol/ConnectorAdmissionMigrationProof.js';
import { ConnectorMigrationPreparation } from './ConnectorMigrationPreparation.js';
import { ConnectorMigrationInstallation } from './ConnectorMigrationInstallation.js';
import { ConnectorApprovedJournalMigration } from './ConnectorApprovedJournalMigration.js';
import { ConnectorOperationPurpose } from './ConnectorOperationCodec.js';
import type { ConnectorClientIdentity } from './ConnectorClientConfiguration.js';
import type { ConnectorPrivateDirectory } from './ConnectorPrivateDirectory.js';
import { dirname, join } from 'node:path';
import { ProtectedFiles } from '../local/ProtectedFiles.js';
import { createHash } from 'node:crypto';
import type { ConnectorHistoryMigrationEntry } from './ConnectorHistoryMigrationMarker.js';
import { SigningKey } from '../identity/SigningKey.js';

/** Exact first migration proofs remain private, durable and separate from operation acknowledgement history. */
export class ConnectorMigrationEvidence {
    /** Operator approval is retained beside the immutable original device plan. */
    public static readonly approvalFilename: string = 'admission-migration-approval.json';
    /** This is a local conversion attestation; it never claims backend admission or a fabricated acknowledgement. */
    public static readonly appliedFilename: string = 'admission-migration-applied.json';

    /** The supplied or first retained approval is mandatory, including when the paired device has no operation journals. */
    public static async approval(
        installation: ConnectorMigrationInstallation,
        input: ConnectorMigrationApproval | null,
    ): Promise<ConnectorMigrationApproval> {
        const directory: ConnectorPrivateDirectory = installation.runtime;
        if (await directory.exists(this.approvalFilename + '.partial')) {
            throw new Error('Migration approval has an unresolved partial');
        }
        const retained: ConnectorMigrationApproval | null = (await directory.exists(
            this.approvalFilename,
        ))
            ? ConnectorMigrationApprovalCodec.decode(
                  this.#text(
                      await directory.read(
                          this.approvalFilename,
                          ConnectorMigrationLimits.approvalBytes,
                      ),
                  ),
              )
            : null;
        const approval: ConnectorMigrationApproval | null =
            input === null ? retained : ConnectorMigrationApprovalCodec.value(input);
        if (approval === null) {
            throw new Error('Migration requires its signed authority approval');
        }
        if (
            retained !== null &&
            ConnectorAdmissionMigrationProof.approvalSha256(retained) !==
                ConnectorAdmissionMigrationProof.approvalSha256(approval)
        ) {
            throw new Error('Migration cannot replace its first retained authority approval');
        }
        const original: ConnectorMigrationPlan = ConnectorMigrationPlanCodec.decode(
            this.#text(
                await directory.read(
                    ConnectorMigrationPreparation.filename,
                    ConnectorMigrationLimits.planBytes,
                ),
            ),
        );
        const expected: ConnectorMigrationExpected = this.expected(installation.identity);
        if (
            !ConnectorAdmissionMigrationProof.verifyApproval(
                SigningKey,
                expected,
                original,
                approval,
            )
        ) {
            throw new Error('Migration approval does not authenticate the original retained plan');
        }
        const purposes: readonly ConnectorOperationPurpose[] = [
            ...(installation.identity.settings.files === null
                ? []
                : [ConnectorOperationPurpose.Files]),
            ...(installation.identity.settings.execution === null
                ? []
                : [
                      ConnectorOperationPurpose.ExecutionFirst,
                      ConnectorOperationPurpose.ExecutionSecond,
                  ]),
        ];
        if (
            purposes.length !== approval.plan.sources.length ||
            purposes.some(
                (purpose: ConnectorOperationPurpose, index: number): boolean =>
                    ConnectorApprovedJournalMigration.lane(purpose) !==
                    approval.plan.sources[index]?.lane,
            )
        ) {
            throw new Error('Migration approval must cover all configured permanent journals');
        }
        return approval;
    }

    /** Retention occurs only after every configured source and target has passed validation. */
    public static async retainApproval(
        directory: ConnectorPrivateDirectory,
        approval: ConnectorMigrationApproval,
    ): Promise<void> {
        if (!(await directory.exists(this.approvalFilename))) {
            await directory.write(
                this.approvalFilename,
                Buffer.from(ConnectorMigrationApprovalCodec.encode(approval)),
                ConnectorMigrationLimits.approvalBytes,
                true,
            );
        }
    }

    /** The exact durable target hashes are signed only after all actual writes have been reread and verified. */
    public static async applied(
        installation: ConnectorMigrationInstallation,
        approval: ConnectorMigrationApproval,
        targets: readonly ConnectorMigrationTarget[],
    ): Promise<ConnectorMigrationApplied> {
        const directory: ConnectorPrivateDirectory = installation.runtime;
        const expected: ConnectorMigrationExpected = this.expected(installation.identity);
        if (await directory.exists(this.appliedFilename + '.partial')) {
            throw new Error('Migration applied attestation has an unresolved partial');
        }
        if (await directory.exists(this.appliedFilename)) {
            const original: ConnectorMigrationApplied = await this.readApplied(
                directory,
                installation.identity,
                approval,
            );
            if (JSON.stringify(original.targets) !== JSON.stringify(targets)) {
                throw new Error('Durable migration target changed after its first applied proof');
            }
            return original;
        }
        const applied: ConnectorMigrationApplied = ConnectorAdmissionMigrationProof.signApplied(
            SigningKey,
            installation.identity.key,
            expected,
            approval,
            {
                planSha256: ConnectorAdmissionMigrationProof.planSha256(approval.plan),
                approvalSha256: ConnectorAdmissionMigrationProof.approvalSha256(approval),
                targets,
            },
        );
        await directory.write(
            this.appliedFilename,
            Buffer.from(ConnectorMigrationAppliedCodec.encode(applied)),
            ConnectorMigrationLimits.appliedBytes,
            true,
        );
        return applied;
    }

    /** Complete local markers cannot outlive missing or substituted conversion evidence. */
    public static async readApplied(
        directory: ConnectorPrivateDirectory,
        identity: ConnectorClientIdentity,
        approval: ConnectorMigrationApproval,
    ): Promise<ConnectorMigrationApplied> {
        const applied: ConnectorMigrationApplied = ConnectorMigrationAppliedCodec.decode(
            this.#text(
                await directory.read(this.appliedFilename, ConnectorMigrationLimits.appliedBytes),
            ),
        );
        if (
            !ConnectorAdmissionMigrationProof.verifyApplied(
                SigningKey,
                this.expected(identity),
                approval,
                applied,
            )
        ) {
            throw new Error('Applied migration evidence is not authenticated');
        }
        return applied;
    }

    /** Runtime owns its installation lock already; it verifies completed proofs without reacquiring that same lock or reopening native roots. */
    public static async requireComplete(
        identity: ConnectorClientIdentity,
        approvalSha256: string,
        appliedSha256: string | null,
        entries: readonly ConnectorHistoryMigrationEntry[],
    ): Promise<void> {
        const directory: string = dirname(identity.settings.privateKeyFile);
        const approvalPath: string = join(directory, this.approvalFilename);
        const appliedPath: string = join(directory, this.appliedFilename);
        const planPath: string = join(directory, ConnectorMigrationPreparation.filename);
        for (const path of [approvalPath, appliedPath, planPath]) {
            if (await ProtectedFiles.exists(path + '.partial')) {
                throw new Error('Completed migration evidence has an unresolved partial');
            }
        }
        const plan: ConnectorMigrationPlan = ConnectorMigrationPlanCodec.decode(
            this.#text(
                await ProtectedFiles.readPrivate(planPath, ConnectorMigrationLimits.planBytes),
            ),
        );
        const approval: ConnectorMigrationApproval = ConnectorMigrationApprovalCodec.decode(
            this.#text(
                await ProtectedFiles.readPrivate(
                    approvalPath,
                    ConnectorMigrationLimits.approvalBytes,
                ),
            ),
        );
        const applied: ConnectorMigrationApplied = ConnectorMigrationAppliedCodec.decode(
            this.#text(
                await ProtectedFiles.readPrivate(
                    appliedPath,
                    ConnectorMigrationLimits.appliedBytes,
                ),
            ),
        );
        const expected: ConnectorMigrationExpected = this.expected(identity);
        if (
            ConnectorAdmissionMigrationProof.approvalSha256(approval) !== approvalSha256 ||
            this.appliedSha256(applied) !== appliedSha256 ||
            applied.targets.length !== entries.length ||
            applied.targets.some((target: ConnectorMigrationTarget, index: number): boolean => {
                const entry: ConnectorHistoryMigrationEntry | undefined = entries[index];
                return (
                    entry === undefined ||
                    target.lane !== ConnectorApprovedJournalMigration.lane(entry.purpose) ||
                    target.plainSha256 !== entry.expectedPlainSha256
                );
            }) ||
            !ConnectorAdmissionMigrationProof.verifyApproval(
                SigningKey,
                expected,
                plan,
                approval,
            ) ||
            !ConnectorAdmissionMigrationProof.verifyApplied(SigningKey, expected, approval, applied)
        ) {
            throw new Error(
                'Completed migration marker has missing or substituted authority evidence',
            );
        }
    }

    /** Scope and hybrid public pins are always read from the protected installation. */
    public static expected(identity: ConnectorClientIdentity): ConnectorMigrationExpected {
        return {
            authorityId: identity.authority.authorityId,
            authorityPublicKey: identity.authority.publicKey,
            environmentId: identity.settings.environmentId,
            enrollmentId: identity.settings.enrollmentId,
            devicePublicKey: identity.publicKey,
        };
    }

    /** Complete marker identity retains the full first Applied proof, including its randomized hybrid signature. */
    public static appliedSha256(applied: ConnectorMigrationApplied): string {
        return createHash('sha256')
            .update(ConnectorMigrationAppliedCodec.encode(applied))
            .digest('hex');
    }

    static #text(bytes: Buffer): string {
        return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    }
}
