// SPDX-FileCopyrightText: 2026 Dacely <business@dacely.com>
// SPDX-License-Identifier: LicenseRef-Proprietary

import { ConnectorEffectKind } from '../src/runtime/ConnectorEffectContext.js';
import { createHash } from 'node:crypto';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { expect, it } from 'vitest';
import { FileHistoryFixture } from './support/FileHistoryFixture.js';
import {
    ConnectorFileMode,
    ConnectorFileFailure,
    type ConnectorFileResponse,
} from 'nerva-connector-protocol/protocol/ConnectorFiles.js';
import type { ConnectorFilePermit } from 'nerva-connector-protocol/protocol/ConnectorFileJobs.js';
import {
    ConnectorFileHistoryPreparation,
    ConnectorFileHistoryPreparationStatus,
    ConnectorFileHistoryPreparationBlock,
    type ConnectorFileHistoryPreparationReport,
} from '../src/runtime/ConnectorFileHistoryPreparation.js';
import {
    ConnectorFilePolicy,
    type ConnectorFilePolicyDefinition,
} from '../src/runtime/ConnectorFilePolicy.js';
import { ConnectorFileStageQuiescence } from '../src/runtime/ConnectorFileStageQuiescence.js';
import {
    ConnectorClientConfiguration,
    type ConnectorClientIdentity,
} from '../src/runtime/ConnectorClientConfiguration.js';

const helpers: boolean =
    process.platform === 'linux' &&
    process.env['NERVA_CONNECTOR_FILES_HELPER'] !== undefined &&
    process.env['NERVA_CONNECTOR_ORIGINAL_FILES_HELPER'] !== undefined;

it.skipIf(!helpers).each([false, true])(
    'the explicitly selected original helper keeps its pin and preserves Write history with busy stage=%s',
    async (busy: boolean): Promise<void> => {
        const selected: string | undefined = process.env['NERVA_CONNECTOR_ORIGINAL_FILES_HELPER'];
        if (selected === undefined) {
            throw new Error('Explicit original helper qualification input required');
        }
        const helper: string = resolve(selected);
        const helperBytes: Buffer = await readFile(helper);
        const originalSha256: string = createHash('sha256').update(helperBytes).digest('hex');
        await using fixture: FileHistoryFixture = await FileHistoryFixture.create(
            ConnectorFileMode.ReadWrite,
            true,
            helper,
        );
        const original: ConnectorFilePermit = fixture.permit();
        const policy: Buffer = await readFile(fixture.files.policy);
        const definition: ConnectorFilePolicyDefinition = await ConnectorFilePolicy.load(
            fixture.files.policy,
        );
        expect(definition.helperFile).toBe(helper);
        expect(definition.helperSha256).toBe(originalSha256);
        const key: Buffer = await readFile(fixture.identity.settings.privateKeyFile);
        try {
            const loaded: ConnectorClientIdentity = await ConnectorClientConfiguration.load(
                fixture.identity.configurationFile,
            );
            using loadedKey: typeof loaded.key = loaded.key;
            expect(loadedKey.publicKey === fixture.identity.key.publicKey).toBe(true);
            await fixture.retain(original);
            await writeFile(join(fixture.files.root, 'destination'), 'KEEP ORIGINAL', {
                mode: 0o600,
            });
            if (busy) {
                await writeFile(fixture.staged(original), 'PRIVATE PARTIAL', { mode: 0o600 });
            }
            const before: Buffer = await readFile(join(fixture.state, 'file-journal'));
            const report: ConnectorFileHistoryPreparationReport =
                await ConnectorFileHistoryPreparation.prepare(loaded, new AbortController().signal);
            expect(report).toMatchObject({
                ready: false,
                preparedPolicySha256: original.request.policySha256,
                stages: busy
                    ? ConnectorFileStageQuiescence.Busy
                    : ConnectorFileStageQuiescence.Quiescent,
                history: {
                    acknowledgedSequence: 0n,
                    pendingSequence: original.sequence,
                    pendingJobId: original.jobId,
                    status: busy
                        ? ConnectorFileHistoryPreparationStatus.Blocked
                        : ConnectorFileHistoryPreparationStatus.InterruptedAwaitingAcknowledgment,
                    blocked: busy ? ConnectorFileHistoryPreparationBlock.CleanupUnproven : null,
                    remoteAcknowledgmentPending: !busy,
                },
            });
            const expected: ConnectorFileResponse = {
                ok: false,
                error: ConnectorFileFailure.Indeterminate,
            };
            expect(await fixture.pending()).toEqual({
                jobId: original.jobId,
                sequence: original.sequence,
                dispatchId: original.dispatchId,
                effectContext: {
                    kind: ConnectorEffectKind.HistoricalUnproven,
                    sourceSha256: fixture.originalSourceSha256,
                },
                requestHash: original.requestHash,
                request: original.request,
                response: busy ? null : expected,
                progress: null,
            });
            if (busy) {
                expect((await readFile(join(fixture.state, 'file-journal'))).equals(before)).toBe(
                    true,
                );
                expect(await readFile(fixture.staged(original), 'utf8')).toBe('PRIVATE PARTIAL');
            } else {
                expect(await readdir(join(fixture.files.directory, 'staging'))).toEqual([]);
                const terminal: Buffer = await readFile(join(fixture.state, 'file-journal'));
                expect(
                    await ConnectorFileHistoryPreparation.prepare(
                        loaded,
                        new AbortController().signal,
                    ),
                ).toMatchObject({
                    ready: false,
                    stages: ConnectorFileStageQuiescence.Quiescent,
                    history: {
                        status: ConnectorFileHistoryPreparationStatus.AwaitingAcknowledgment,
                        remoteAcknowledgmentPending: true,
                    },
                });
                expect((await readFile(join(fixture.state, 'file-journal'))).equals(terminal)).toBe(
                    true,
                );
                // Saved terminal data does not supply physical authority to remove an unproven temporary.
                await writeFile(fixture.staged(original), 'RETAINED TEMPORARY', { mode: 0o600 });
                expect(
                    await ConnectorFileHistoryPreparation.prepare(
                        loaded,
                        new AbortController().signal,
                    ),
                ).toMatchObject({
                    ready: false,
                    stages: ConnectorFileStageQuiescence.Busy,
                    history: {
                        status: ConnectorFileHistoryPreparationStatus.Blocked,
                        blocked: ConnectorFileHistoryPreparationBlock.CleanupUnproven,
                        remoteAcknowledgmentPending: true,
                    },
                });
                expect((await readFile(join(fixture.state, 'file-journal'))).equals(terminal)).toBe(
                    true,
                );
                expect(await readFile(fixture.staged(original), 'utf8')).toBe('RETAINED TEMPORARY');
            }
            expect((await readFile(fixture.files.policy)).equals(policy)).toBe(true);
            expect((await readFile(fixture.identity.settings.privateKeyFile)).equals(key)).toBe(
                true,
            );
            expect(
                createHash('sha256')
                    .update(await readFile(helper))
                    .digest('hex'),
            ).toBe(originalSha256);
            expect((await readFile(helper)).equals(helperBytes)).toBe(true);
            expect(await readFile(join(fixture.files.root, 'destination'), 'utf8')).toBe(
                'KEEP ORIGINAL',
            );
        } finally {
            key.fill(0);
        }
    },
);
