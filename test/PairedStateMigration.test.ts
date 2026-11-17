// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { expect, it, afterAll } from 'vitest';
import { PairedMigrationFixture } from './support/PairedMigrationFixture.js';
import { RuntimeMigrationApprovalFixture } from './support/RuntimeMigrationApprovalFixture.js';
import { SignaturePurpose } from 'nerva-connector-protocol/identity/IdentityFormat.js';
import { ConnectorMigrationPreparation } from '../src/runtime/ConnectorMigrationPreparation.js';
import { ConnectorMigrationEvidence } from '../src/runtime/ConnectorMigrationEvidence.js';
import { ConnectorHistoryMigration } from '../src/runtime/ConnectorHistoryMigration.js';
import {
    ConnectorPrivateDirectory,
    ConnectorDirectoryPurpose,
} from '../src/runtime/ConnectorPrivateDirectory.js';
import {
    ConnectorHistoryMigrationMarker,
    ConnectorHistoryMigrationPhase,
    ConnectorHistoryMigrationSchema,
    type ConnectorHistoryMigrationReceipt,
} from '../src/runtime/ConnectorHistoryMigrationMarker.js';
import { ConnectorMigrationPlanCodec } from 'nerva-connector-protocol/protocol/ConnectorMigrationPlanCodec.js';
import { ConnectorMigrationAppliedCodec } from 'nerva-connector-protocol/protocol/ConnectorMigrationAppliedCodec.js';
import { ConnectorAdmissionMigrationProof } from '../src/protocol/ConnectorAdmissionMigrationProof.js';
import {
    ConnectorMigrationLimits,
    type ConnectorMigrationPlan,
    type ConnectorMigrationApproval,
    type ConnectorMigrationApplied,
} from 'nerva-connector-protocol/protocol/ConnectorAdmissionMigration.js';
import { WindowsStateOwner } from '../src/windows/WindowsStateOwner.js';

/** Reproduces the retired device-signed shape as hostile persisted input, without allowing it in application contracts. */
interface UnapprovedMarkerPayload extends Omit<
    ConnectorHistoryMigrationReceipt,
    'signature' | 'approvalSha256' | 'appliedSha256'
> {
    readonly approvalSha256: null;
    readonly appliedSha256: null;
}

const supported: boolean = process.platform === 'linux' || process.platform === 'win32';

afterAll(async (): Promise<void> => {
    if (process.platform === 'win32') {
        await WindowsStateOwner.close();
    }
});

it.skipIf(!supported)(
    'paired-only migration requires authority approval before any marker, preserves the native device key and retries the exact completed proofs',
    async (): Promise<void> => {
        await using fixture: PairedMigrationFixture = await PairedMigrationFixture.create();
        const keySha256: string = createHash('sha256')
            .update(await readFile(fixture.identity.settings.privateKeyFile))
            .digest('hex');
        if (process.platform === 'win32') {
            expect(
                (await readFile(fixture.identity.settings.privateKeyFile))
                    .subarray(0, 13)
                    .toString(),
            ).toBe('NEXA-DPAPI-1\n');
        }
        const signal: AbortSignal = new AbortController().signal;
        const plan: ConnectorMigrationPlan = await ConnectorMigrationPreparation.run(
            fixture.identity.configurationFile,
            signal,
        );
        expect(plan.sources).toEqual([]);
        expect(
            ConnectorMigrationPlanCodec.encode(
                await ConnectorMigrationPreparation.run(fixture.identity.configurationFile, signal),
            ),
        ).toBe(ConnectorMigrationPlanCodec.encode(plan));
        await expect(
            ConnectorHistoryMigration.run(fixture.identity.configurationFile, signal),
        ).rejects.toThrow('History migration unavailable');
        for (const name of [
            ConnectorHistoryMigrationMarker.filename,
            ConnectorMigrationEvidence.approvalFilename,
            ConnectorMigrationEvidence.appliedFilename,
        ]) {
            expect(await fixture.directory.exists(name)).toBe(false);
            expect(await fixture.directory.exists(name + '.partial')).toBe(false);
        }
        const approval: ConnectorMigrationApproval = RuntimeMigrationApprovalFixture.approve(
            fixture.identity,
            plan,
            fixture.authority,
        );
        for (const purpose of [
            ConnectorDirectoryPurpose.Runtime,
            ConnectorDirectoryPurpose.Pairing,
        ]) {
            await using competitors: AsyncDisposableStack = new AsyncDisposableStack();
            competitors.use(
                await ConnectorPrivateDirectory.open(fixture.directory.directory, purpose),
            );
            await expect(
                ConnectorHistoryMigration.run(fixture.identity.configurationFile, signal, approval),
            ).rejects.toThrow('History migration unavailable');
            expect(await fixture.directory.exists(ConnectorHistoryMigrationMarker.filename)).toBe(
                false,
            );
        }
        expect(
            await ConnectorHistoryMigration.run(
                fixture.identity.configurationFile,
                signal,
                approval,
            ),
        ).toEqual({ complete: true, upgraded: 0, alreadyCurrent: 0, historicalPending: 0 });
        await ConnectorHistoryMigration.requireComplete(fixture.identity);
        const marker: Buffer = await fixture.directory.read(
            ConnectorHistoryMigrationMarker.filename,
            ConnectorHistoryMigrationMarker.maximumBytes,
        );
        const applied: Buffer = await fixture.directory.read(
            ConnectorMigrationEvidence.appliedFilename,
            ConnectorMigrationLimits.appliedBytes,
        );
        const proof: ConnectorMigrationApplied = ConnectorMigrationAppliedCodec.decode(
            applied.toString('utf8'),
        );
        expect(proof.targets).toEqual([]);
        expect(
            ConnectorAdmissionMigrationProof.verifyApplied(
                ConnectorMigrationEvidence.expected(fixture.identity),
                approval,
                proof,
            ),
        ).toBe(true);
        expect(
            await ConnectorHistoryMigration.run(fixture.identity.configurationFile, signal),
        ).toEqual({ complete: true, upgraded: 0, alreadyCurrent: 0, historicalPending: 0 });
        expect(
            await fixture.directory.read(
                ConnectorHistoryMigrationMarker.filename,
                ConnectorHistoryMigrationMarker.maximumBytes,
            ),
        ).toEqual(marker);
        expect(
            await fixture.directory.read(
                ConnectorMigrationEvidence.appliedFilename,
                ConnectorMigrationLimits.appliedBytes,
            ),
        ).toEqual(applied);
        expect(
            createHash('sha256')
                .update(await readFile(fixture.identity.settings.privateKeyFile))
                .digest('hex'),
        ).toBe(keySha256);
    },
);

it.skipIf(!supported)(
    'a genuinely device-signed marker without authority approval cannot authorize startup or be silently replaced',
    async (): Promise<void> => {
        await using fixture: PairedMigrationFixture = await PairedMigrationFixture.create();
        const payload: UnapprovedMarkerPayload = {
            schema: ConnectorHistoryMigrationSchema.AuthorizedAdmission,
            phase: ConnectorHistoryMigrationPhase.Complete,
            bindingSha256: ConnectorHistoryMigrationMarker.binding(fixture.identity),
            approvalSha256: null,
            appliedSha256: null,
            entries: [],
        };
        const bytes: Buffer = Buffer.from(
            JSON.stringify({
                ...payload,
                signature: fixture.identity.key.sign(
                    SignaturePurpose.HistoryMigration,
                    Buffer.from(JSON.stringify(payload)),
                ),
            }),
        );
        await fixture.directory.write(
            ConnectorHistoryMigrationMarker.filename,
            bytes,
            ConnectorHistoryMigrationMarker.maximumBytes,
            true,
        );
        await expect(ConnectorHistoryMigration.requireComplete(fixture.identity)).rejects.toThrow(
            'History migration unavailable',
        );
        const approval: ConnectorMigrationApproval = await RuntimeMigrationApprovalFixture.prepare(
            fixture.identity,
            fixture.authority,
        );
        await expect(
            ConnectorHistoryMigration.run(
                fixture.identity.configurationFile,
                new AbortController().signal,
                approval,
            ),
        ).rejects.toThrow('History migration unavailable');
        expect(
            await fixture.directory.read(
                ConnectorHistoryMigrationMarker.filename,
                ConnectorHistoryMigrationMarker.maximumBytes,
            ),
        ).toEqual(bytes);
        expect(await fixture.directory.exists(ConnectorMigrationEvidence.approvalFilename)).toBe(
            false,
        );
        expect(await fixture.directory.exists(ConnectorMigrationEvidence.appliedFilename)).toBe(
            false,
        );
    },
);
