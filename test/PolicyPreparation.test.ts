// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

import { execFile, type ExecException } from 'node:child_process';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { expect, it } from 'vitest';
import { FileHistoryFixture } from './support/FileHistoryFixture.js';
import { NetworkCanary } from './support/NetworkCanary.js';
import { ConnectorFileMode } from 'nerva-connector-protocol/protocol/ConnectorFiles.js';
import type { ConnectorFilePermit } from 'nerva-connector-protocol/protocol/ConnectorFileJobs.js';
import {
    ConnectorFileHistoryPreparationStatus,
    ConnectorFileHistoryPreparationBlock,
} from '../src/runtime/ConnectorFileHistoryPreparation.js';
import { ConnectorFileStageQuiescence } from '../src/runtime/ConnectorFileStageQuiescence.js';
import {
    ConnectorDirectoryPurpose,
    ConnectorPrivateDirectory,
} from '../src/runtime/ConnectorPrivateDirectory.js';

interface PreparationCommandResult {
    readonly code: number;
    readonly stdout: string;
    readonly stderr: string;
}

/** Executes the actual standalone command with finite runtime/output and no inherited debugger options. */
class PreparationCommand {
    public static async run(configurationFile: string): Promise<PreparationCommandResult> {
        const completed: PromiseWithResolvers<PreparationCommandResult> =
            Promise.withResolvers<PreparationCommandResult>();
        execFile(
            process.execPath,
            [
                resolve('build/nerva-connector.mjs'),
                'connector',
                'prepare-policy-change',
                '--config',
                configurationFile,
            ],
            {
                timeout: 8000,
                maxBuffer: 8192,
                encoding: 'utf8',
                env: { ...process.env, NODE_OPTIONS: '' },
            },
            (error: ExecException | null, stdout: string, stderr: string): void => {
                if (error !== null && (error.killed || typeof error.code !== 'number')) {
                    completed.reject(error);
                    return;
                }
                const code: number = typeof error?.code === 'number' ? error.code : 0;
                completed.resolve({ code, stdout, stderr });
            },
        );
        return await completed.promise;
    }
}

const helpers: boolean =
    process.platform === 'linux' && process.env['NERVA_CONNECTOR_FILES_HELPER'] !== undefined;
const notice =
    'Local preparation does not authorize a policy change; keep the original configuration until server work is acknowledged.\n';

it.skipIf(!helpers)(
    'the actual idle CLI reports local-only readiness without changing ciphertext, configuration or key, and contacts no server',
    async (): Promise<void> => {
        await using fixture: FileHistoryFixture = await FileHistoryFixture.create();
        await using network: NetworkCanary = new NetworkCanary();
        const endpoint: string = await network.endpoint();
        await writeFile(
            fixture.identity.configurationFile,
            JSON.stringify({ ...fixture.identity.settings, endpoints: [endpoint] }),
            { mode: 0o600 },
        );
        const configuration: Buffer = await readFile(fixture.identity.configurationFile);
        const key: Buffer = await readFile(fixture.identity.settings.privateKeyFile);
        const journal: Buffer = await readFile(join(fixture.state, 'file-journal'));
        try {
            await network.probe();
            expect(network.connections).toBe(1);
            const result: PreparationCommandResult = await PreparationCommand.run(
                fixture.identity.configurationFile,
            );
            expect(result.code).toBe(0);
            const report: unknown = JSON.parse(result.stdout);
            expect(report).toMatchObject({
                localReady: true,
                remoteStateVerified: false,
                files: {
                    configured: true,
                    ready: true,
                    stages: ConnectorFileStageQuiescence.Quiescent,
                    history: {
                        acknowledgedSequence: '0',
                        pendingSequence: null,
                        remoteAcknowledgmentPending: false,
                    },
                },
                execution: { configured: false, ready: true, lanes: [] },
            });
            expect(result.stderr).toBe(notice);
            expect(await readFile(join(fixture.state, 'file-journal'))).toEqual(journal);
            expect(await readFile(fixture.identity.configurationFile)).toEqual(configuration);
            expect(await readFile(fixture.identity.settings.privateKeyFile)).toEqual(key);
            expect(network.connections).toBe(1);
            await network.probe();
            expect(network.connections).toBe(2);
        } finally {
            key.fill(0);
        }
    },
);

it.skipIf(!helpers)(
    'the actual CLI recovers Started Write without replay, retains the terminal result byte-for-byte on repeat, and refuses activation',
    async (): Promise<void> => {
        await using fixture: FileHistoryFixture = await FileHistoryFixture.create();
        const original: ConnectorFilePermit = fixture.permit();
        await fixture.retain(original);
        await writeFile(join(fixture.files.root, 'destination'), 'OLD', { mode: 0o600 });
        const result: PreparationCommandResult = await PreparationCommand.run(
            fixture.identity.configurationFile,
        );
        expect(result.code).toBe(1);
        const report: unknown = JSON.parse(result.stdout);
        expect(report).toMatchObject({
            localReady: false,
            remoteStateVerified: false,
            files: {
                history: {
                    pendingJobId: original.jobId,
                    pendingSequence: '1',
                    status: ConnectorFileHistoryPreparationStatus.InterruptedAwaitingAcknowledgment,
                    remoteAcknowledgmentPending: true,
                },
            },
        });
        expect(result.stderr).toBe(notice);
        expect(result.stdout).not.toContain('NEW');
        expect(await readFile(join(fixture.files.root, 'destination'), 'utf8')).toBe('OLD');
        expect(await readdir(join(fixture.files.directory, 'staging'))).toEqual([]);
        const retained: Buffer = await readFile(join(fixture.state, 'file-journal'));
        const repeated: PreparationCommandResult = await PreparationCommand.run(
            fixture.identity.configurationFile,
        );
        expect(repeated.code).toBe(1);
        const repeatedReport: unknown = JSON.parse(repeated.stdout);
        expect(repeatedReport).toMatchObject({
            files: {
                history: { status: ConnectorFileHistoryPreparationStatus.AwaitingAcknowledgment },
            },
        });
        expect(await readFile(join(fixture.state, 'file-journal'))).toEqual(retained);
        expect((await fixture.pending())?.request).toEqual(original.request);
    },
);

it.skipIf(!helpers)(
    'the actual CLI retains unproven Started Write staging and ciphertext instead of claiming cleanup',
    async (): Promise<void> => {
        await using fixture: FileHistoryFixture = await FileHistoryFixture.create();
        const original: ConnectorFilePermit = fixture.permit();
        await fixture.retain(original);
        await writeFile(fixture.staged(original), 'PRIVATE RETAINED', { mode: 0o600 });
        const ciphertext: Buffer = await readFile(join(fixture.state, 'file-journal'));
        const result: PreparationCommandResult = await PreparationCommand.run(
            fixture.identity.configurationFile,
        );
        const report: unknown = JSON.parse(result.stdout);
        expect(result.code).toBe(1);
        expect(report).toMatchObject({
            localReady: false,
            remoteStateVerified: false,
            files: {
                history: {
                    status: ConnectorFileHistoryPreparationStatus.Blocked,
                    blocked: ConnectorFileHistoryPreparationBlock.CleanupUnproven,
                    remoteAcknowledgmentPending: false,
                },
            },
        });
        expect(result.stdout).not.toContain('PRIVATE RETAINED');
        expect(await readFile(fixture.staged(original), 'utf8')).toBe('PRIVATE RETAINED');
        expect(await readFile(join(fixture.state, 'file-journal'))).toEqual(ciphertext);
    },
);

it.skipIf(!helpers).each([ConnectorDirectoryPurpose.Runtime, ConnectorDirectoryPurpose.Pairing])(
    'a live %s owner rejects the real command before any recovery effects',
    async (purpose: ConnectorDirectoryPurpose): Promise<void> => {
        await using fixture: FileHistoryFixture = await FileHistoryFixture.create();
        const original: ConnectorFilePermit = fixture.permit();
        await fixture.retain(original);
        await writeFile(fixture.staged(original), 'KEEP', { mode: 0o600 });
        const journal: Buffer = await readFile(join(fixture.state, 'file-journal'));
        await using owner: ConnectorPrivateDirectory = await ConnectorPrivateDirectory.open(
            dirname(fixture.identity.settings.privateKeyFile),
            purpose,
        );
        expect(owner.directory).toBe(dirname(fixture.identity.settings.privateKeyFile));
        const result: PreparationCommandResult = await PreparationCommand.run(
            fixture.identity.configurationFile,
        );
        expect(result.code).toBe(1);
        expect(result.stdout).toBe('');
        expect(result.stderr).toContain('Local preparation unavailable; stop the connector');
        expect(result.stderr).not.toContain(fixture.files.directory);
        expect(await readFile(join(fixture.state, 'file-journal'))).toEqual(journal);
        expect(await readFile(fixture.staged(original), 'utf8')).toBe('KEEP');
    },
);

it.skipIf(!helpers)(
    'missing existing history is never initialized by the actual command',
    async (): Promise<void> => {
        await using fixture: FileHistoryFixture = await FileHistoryFixture.create(
            ConnectorFileMode.ReadWrite,
            false,
        );
        const before: readonly string[] = await readdir(fixture.files.directory, {
            recursive: true,
        });
        const result: PreparationCommandResult = await PreparationCommand.run(
            fixture.identity.configurationFile,
        );
        expect(result.code).toBe(1);
        expect(result.stdout).toBe('');
        expect(result.stderr).toContain('Local preparation unavailable');
        expect(await readdir(fixture.files.directory, { recursive: true })).toEqual(before);
    },
);

it.skipIf(!helpers)(
    'an idle journal with unowned staging contents cannot become locally ready or erase the contents',
    async (): Promise<void> => {
        await using fixture: FileHistoryFixture = await FileHistoryFixture.create();
        await writeFile(join(fixture.files.directory, 'staging/unknown'), 'KEEP', { mode: 0o600 });
        const journal: Buffer = await readFile(join(fixture.state, 'file-journal'));
        const result: PreparationCommandResult = await PreparationCommand.run(
            fixture.identity.configurationFile,
        );
        expect(result.code).toBe(1);
        const report: unknown = JSON.parse(result.stdout);
        expect(report).toMatchObject({
            localReady: false,
            remoteStateVerified: false,
            files: {
                stages: ConnectorFileStageQuiescence.Busy,
                history: { blocked: ConnectorFileHistoryPreparationBlock.StagesBusy },
            },
        });
        expect(await readFile(join(fixture.files.directory, 'staging/unknown'), 'utf8')).toBe(
            'KEEP',
        );
        expect(await readFile(join(fixture.state, 'file-journal'))).toEqual(journal);
    },
);
