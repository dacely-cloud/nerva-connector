// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

import { readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { expect, it } from 'vitest';
import {
    type ConnectorMigrationApproval,
    type ConnectorMigrationApprovalBody,
    type ConnectorMigrationApplied,
    type ConnectorMigrationPlan,
    type ConnectorMigrationPlanBody,
} from 'nerva-connector-protocol/protocol/ConnectorAdmissionMigration.js';
import { ConnectorAdmissionMigrationProof } from '../src/protocol/ConnectorAdmissionMigrationProof.js';
import { ConnectorMigrationAppliedCodec } from 'nerva-connector-protocol/protocol/ConnectorMigrationAppliedCodec.js';
import { ConnectorMigrationApprovalCodec } from 'nerva-connector-protocol/protocol/ConnectorMigrationApprovalCodec.js';
import { ConnectorMigrationPlanCodec } from 'nerva-connector-protocol/protocol/ConnectorMigrationPlanCodec.js';
import { ConnectorMigrationEvidence } from '../src/runtime/ConnectorMigrationEvidence.js';
import { ConnectorMigrationPreparation } from '../src/runtime/ConnectorMigrationPreparation.js';
import {
    ConnectorHistoryMigration,
    ConnectorHistoryMigrationError,
} from '../src/runtime/ConnectorHistoryMigration.js';
import {
    ConnectorHistoryMigrationMarker,
    ConnectorHistoryMigrationPhase,
    type ConnectorHistoryMigrationReceipt,
    type ConnectorHistoryMigrationEntry,
} from '../src/runtime/ConnectorHistoryMigrationMarker.js';
import { FileHistoryFixture } from './support/FileHistoryFixture.js';
import { RuntimeMigrationApprovalFixture } from './support/RuntimeMigrationApprovalFixture.js';

const helpers: boolean =
    process.platform === 'linux' && process.env['NERVA_CONNECTOR_FILES_HELPER'] !== undefined;

it.skipIf(!helpers)(
    'stopped preparation retains the complete first randomized plan and exact old ciphertext across retries',
    async (): Promise<void> => {
        await using fixture: FileHistoryFixture = await FileHistoryFixture.create();
        await fixture.retainOriginal(fixture.permit());
        const path: string = join(fixture.state, 'file-journal');
        const before: Buffer = await readFile(path);
        const first: ConnectorMigrationPlan = await ConnectorMigrationPreparation.run(
            fixture.identity.configurationFile,
            new AbortController().signal,
        );
        const planPath: string = join(
            dirname(fixture.identity.settings.privateKeyFile),
            ConnectorMigrationPreparation.filename,
        );
        const originalPlan: Buffer = await readFile(planPath);
        const again: ConnectorMigrationPlan = await ConnectorMigrationPreparation.run(
            fixture.identity.configurationFile,
            new AbortController().signal,
        );
        expect(ConnectorMigrationPlanCodec.encode(again)).toBe(
            ConnectorMigrationPlanCodec.encode(first),
        );
        expect((await readFile(planPath)).equals(originalPlan)).toBe(true);
        expect((await readFile(path)).equals(before)).toBe(true);
        await expect(fixture.journal()).rejects.toThrow('migration');
    },
);

it.skipIf(!helpers)(
    'an unresolved old journal partial blocks both preparation and approved conversion without deleting evidence or publishing a marker',
    async (): Promise<void> => {
        await using fixture: FileHistoryFixture = await FileHistoryFixture.create();
        await fixture.retainOriginal(fixture.permit());
        const approval: ConnectorMigrationApproval = await RuntimeMigrationApprovalFixture.prepare(
            fixture.identity,
        );
        const path: string = join(fixture.state, 'file-journal');
        const before: Buffer = await readFile(path);
        const partial: Buffer = Buffer.from('OWNED UNRESOLVED ORIGINAL PARTIAL');
        const planPath: string = join(
            dirname(fixture.identity.settings.privateKeyFile),
            ConnectorMigrationPreparation.filename,
        );
        const firstPlan: Buffer = await readFile(planPath);
        await writeFile(path + '.partial', partial, { mode: 0o600, flag: 'wx' });
        await expect(
            ConnectorMigrationPreparation.run(
                fixture.identity.configurationFile,
                new AbortController().signal,
            ),
        ).rejects.toThrow('unresolved partial');
        await expect(
            ConnectorHistoryMigration.run(
                fixture.identity.configurationFile,
                new AbortController().signal,
                approval,
            ),
        ).rejects.toBeInstanceOf(ConnectorHistoryMigrationError);
        expect((await readFile(path)).equals(before)).toBe(true);
        expect((await readFile(path + '.partial')).equals(partial)).toBe(true);
        expect((await readFile(planPath)).equals(firstPlan)).toBe(true);
        await expect(
            readFile(
                join(
                    dirname(fixture.identity.settings.privateKeyFile),
                    ConnectorHistoryMigrationMarker.filename,
                ),
            ),
        ).rejects.toMatchObject({ code: 'ENOENT' });
    },
);

it.skipIf(!helpers)(
    'completed migration requires the original plan, full authority proof and matching Applied chain before startup, without rewriting journals on refusal',
    async (): Promise<void> => {
        await using fixture: FileHistoryFixture = await FileHistoryFixture.create();
        await fixture.retainOriginal(fixture.permit());
        // This authority is generated by the fixture; its synthetic fence makes no backend-fencing claim.
        const approval: ConnectorMigrationApproval = await RuntimeMigrationApprovalFixture.prepare(
            fixture.identity,
        );
        await ConnectorHistoryMigration.run(
            fixture.identity.configurationFile,
            new AbortController().signal,
            approval,
        );
        await ConnectorHistoryMigration.requireComplete(fixture.identity);
        const directory: string = dirname(fixture.identity.settings.privateKeyFile);
        const journalPath: string = join(fixture.state, 'file-journal');
        const journal: Buffer = await readFile(journalPath);
        const markerPath: string = join(directory, ConnectorHistoryMigrationMarker.filename);
        const marker: Buffer = await readFile(markerPath);
        for (const name of [
            ConnectorMigrationPreparation.filename,
            ConnectorMigrationEvidence.approvalFilename,
            ConnectorMigrationEvidence.appliedFilename,
        ]) {
            const path: string = join(directory, name);
            const original: Buffer = await readFile(path);
            await rm(path);
            await expect(
                ConnectorHistoryMigration.requireComplete(fixture.identity),
            ).rejects.toBeInstanceOf(ConnectorHistoryMigrationError);
            expect((await readFile(journalPath)).equals(journal)).toBe(true);
            expect((await readFile(markerPath)).equals(marker)).toBe(true);
            await writeFile(path, original, { mode: 0o600, flag: 'wx' });
            await ConnectorHistoryMigration.requireComplete(fixture.identity);
        }
        const appliedPath: string = join(directory, ConnectorMigrationEvidence.appliedFilename);
        const appliedBytes: Buffer = await readFile(appliedPath);
        const applied: ConnectorMigrationApplied = ConnectorMigrationAppliedCodec.decode(
            appliedBytes.toString('utf8'),
        );
        const expected: ReturnType<typeof ConnectorMigrationEvidence.expected> =
            ConnectorMigrationEvidence.expected(fixture.identity);
        const resignedApplied: ConnectorMigrationApplied =
            ConnectorAdmissionMigrationProof.signApplied(fixture.identity.key, expected, approval, {
                planSha256: applied.planSha256,
                approvalSha256: applied.approvalSha256,
                targets: applied.targets,
            });
        expect(
            ConnectorAdmissionMigrationProof.verifyApplied(expected, approval, resignedApplied),
        ).toBe(true);
        expect(resignedApplied.signature === applied.signature).toBe(false);
        await writeFile(appliedPath, ConnectorMigrationAppliedCodec.encode(resignedApplied));
        await expect(
            ConnectorHistoryMigration.requireComplete(fixture.identity),
        ).rejects.toBeInstanceOf(ConnectorHistoryMigrationError);
        expect((await readFile(journalPath)).equals(journal)).toBe(true);
        await writeFile(appliedPath, appliedBytes);
        const approvalBody: ConnectorMigrationApprovalBody = {
            plan: approval.plan,
            fenceId: approval.fenceId,
            authorizations: approval.authorizations,
        };
        const alternate: ConnectorMigrationApproval = ConnectorAdmissionMigrationProof.signApproval(
            fixture.identity.key,
            expected,
            approvalBody,
        );
        expect(
            ConnectorAdmissionMigrationProof.verifyApproval(expected, approval.plan, alternate),
        ).toBe(true);
        expect(alternate.signature === approval.signature).toBe(false);
        const approvalPath: string = join(directory, ConnectorMigrationEvidence.approvalFilename);
        const approvalBytes: Buffer = await readFile(approvalPath);
        await writeFile(approvalPath, ConnectorMigrationApprovalCodec.encode(alternate));
        await expect(
            ConnectorHistoryMigration.requireComplete(fixture.identity),
        ).rejects.toBeInstanceOf(ConnectorHistoryMigrationError);
        expect((await readFile(journalPath)).equals(journal)).toBe(true);
        await writeFile(approvalPath, approvalBytes);
        const alternateApplied: ConnectorMigrationApplied =
            ConnectorAdmissionMigrationProof.signApplied(
                fixture.identity.key,
                expected,
                alternate,
                {
                    planSha256: ConnectorAdmissionMigrationProof.planSha256(alternate.plan),
                    approvalSha256: ConnectorAdmissionMigrationProof.approvalSha256(alternate),
                    targets: applied.targets,
                },
            );
        expect(
            ConnectorAdmissionMigrationProof.verifyApplied(expected, alternate, alternateApplied),
        ).toBe(true);
        await writeFile(appliedPath, ConnectorMigrationAppliedCodec.encode(alternateApplied));
        await expect(
            ConnectorHistoryMigration.requireComplete(fixture.identity),
        ).rejects.toBeInstanceOf(ConnectorHistoryMigrationError);
        expect((await readFile(journalPath)).equals(journal)).toBe(true);
        await writeFile(appliedPath, appliedBytes);
        const first: ConnectorMigrationPlan = approval.plan;
        const body: ConnectorMigrationPlanBody = {
            authorityId: first.authorityId,
            environmentId: first.environmentId,
            enrollmentId: first.enrollmentId,
            devicePublicKey: first.devicePublicKey,
            planId: first.planId,
            targetOperationSchema: first.targetOperationSchema,
            sources: first.sources,
        };
        const alternatePlan: ConnectorMigrationPlan = ConnectorAdmissionMigrationProof.signPlan(
            fixture.identity.key,
            body,
        );
        expect(ConnectorAdmissionMigrationProof.verifyPlan(expected, alternatePlan)).toBe(true);
        expect(alternatePlan.signature === first.signature).toBe(false);
        const planPath: string = join(directory, ConnectorMigrationPreparation.filename);
        const planBytes: Buffer = await readFile(planPath);
        await writeFile(planPath, ConnectorMigrationPlanCodec.encode(alternatePlan));
        await expect(
            ConnectorHistoryMigration.requireComplete(fixture.identity),
        ).rejects.toBeInstanceOf(ConnectorHistoryMigrationError);
        expect((await readFile(journalPath)).equals(journal)).toBe(true);
        await writeFile(planPath, planBytes);
        await ConnectorHistoryMigration.requireComplete(fixture.identity);
        const complete: ConnectorHistoryMigrationReceipt = ConnectorHistoryMigrationMarker.read(
            marker,
            fixture.identity,
        );
        const mismatched: ConnectorHistoryMigrationReceipt = ConnectorHistoryMigrationMarker.create(
            fixture.identity,
            ConnectorHistoryMigrationPhase.Complete,
            complete.entries.map(
                (entry: ConnectorHistoryMigrationEntry): ConnectorHistoryMigrationEntry => ({
                    ...entry,
                    expectedPlainSha256:
                        entry.expectedPlainSha256 === 'f'.repeat(64)
                            ? 'e'.repeat(64)
                            : 'f'.repeat(64),
                }),
            ),
            complete.approvalSha256,
            complete.appliedSha256,
        );
        await writeFile(markerPath, JSON.stringify(mismatched));
        await expect(
            ConnectorHistoryMigration.requireComplete(fixture.identity),
        ).rejects.toBeInstanceOf(ConnectorHistoryMigrationError);
        expect((await readFile(journalPath)).equals(journal)).toBe(true);
        await writeFile(markerPath, marker);
        await ConnectorHistoryMigration.requireComplete(fixture.identity);
        expect((await readFile(markerPath)).equals(marker)).toBe(true);
        expect((await readFile(journalPath)).equals(journal)).toBe(true);
    },
);
