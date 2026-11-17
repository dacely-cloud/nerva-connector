// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { expect, it } from 'vitest';
import { FileHistoryFixture } from './support/FileHistoryFixture.js';
import type { ConnectorFilePermit } from 'nerva-connector-protocol/protocol/ConnectorFileJobs.js';
import {
    ConnectorFileHistoryPreparation,
    ConnectorFileHistoryPreparationStatus,
    ConnectorFileHistoryPreparationBlock,
    type ConnectorFileHistoryPreparationReport,
} from '../src/runtime/ConnectorFileHistoryPreparation.js';
import { ConnectorFileStageQuiescence } from '../src/runtime/ConnectorFileStageQuiescence.js';

const helpers: boolean =
    process.platform === 'linux' && process.env['NERVA_CONNECTOR_FILES_HELPER'] !== undefined;

it.skipIf(!helpers)(
    'replacement staging and renamed original staging are retained without sealing Started when no physical effect context proves cleanup ownership',
    async (): Promise<void> => {
        await using fixture: FileHistoryFixture = await FileHistoryFixture.create();
        const original: ConnectorFilePermit = fixture.permit();
        await fixture.retain(original);
        const policy: Buffer = await readFile(fixture.files.policy);
        const stage: string = join(fixture.files.directory, 'staging');
        const originalTemporary: string = fixture.staged(original);
        await writeFile(originalTemporary, 'ORIGINAL STAGING DATA', { mode: 0o600 });
        await writeFile(join(fixture.files.root, 'destination'), 'UNCHANGED DESTINATION', {
            mode: 0o600,
        });
        const retainedStage: string = join(fixture.files.directory, 'retained-old-stage');
        await rename(stage, retainedStage);
        await mkdir(stage, { mode: 0o700 });
        await writeFile(originalTemporary, 'NEW UNRELATED STAGING DATA', { mode: 0o600 });
        const actualOriginal: string = join(retainedStage, basename(originalTemporary));
        expect(await readFile(actualOriginal, 'utf8')).toBe('ORIGINAL STAGING DATA');
        expect(await readFile(originalTemporary, 'utf8')).toBe('NEW UNRELATED STAGING DATA');

        const ciphertext: Buffer = await readFile(join(fixture.state, 'file-journal'));
        const report: ConnectorFileHistoryPreparationReport =
            await ConnectorFileHistoryPreparation.prepare(
                fixture.identity,
                new AbortController().signal,
            );

        expect(await readFile(originalTemporary, 'utf8')).toBe('NEW UNRELATED STAGING DATA');
        expect((await readFile(join(fixture.state, 'file-journal'))).equals(ciphertext)).toBe(true);
        expect((await fixture.pending())?.response).toBe(null);
        expect(await readFile(actualOriginal, 'utf8')).toBe('ORIGINAL STAGING DATA');
        expect((await readFile(fixture.files.policy)).equals(policy)).toBe(true);
        expect(await readFile(join(fixture.files.root, 'destination'), 'utf8')).toBe(
            'UNCHANGED DESTINATION',
        );
        expect(report).toMatchObject({
            ready: false,
            preparedPolicySha256: original.request.policySha256,
            stages: ConnectorFileStageQuiescence.Busy,
            history: {
                status: ConnectorFileHistoryPreparationStatus.Blocked,
                blocked: ConnectorFileHistoryPreparationBlock.CleanupUnproven,
                pendingSequence: original.sequence,
                pendingJobId: original.jobId,
                remoteAcknowledgmentPending: false,
            },
        });
    },
);
