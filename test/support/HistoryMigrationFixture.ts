// SPDX-FileCopyrightText: 2026 Dacely <business@dacely.com>
// SPDX-License-Identifier: LicenseRef-Proprietary

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ConnectorClientIdentity } from '../../src/runtime/ConnectorClientConfiguration.js';
import { ConnectorJournalStore } from '../../src/runtime/ConnectorJournalStore.js';
import { type ExecutionRequest } from 'nerva-connector-protocol/execution/ExecutionJobs.js';
import { ExecutionLane } from 'nerva-connector-protocol/execution/ExecutionLane.js';
import { ExecutionJournalCodec } from '../../src/execution/ExecutionJournalCodec.js';
import { ExecutionJobsCodec } from '../../src/execution/ExecutionJobsCodec.js';
import { ExecutionProof } from 'nerva-connector-protocol/execution/ExecutionProof.js';
import type { ExecutionOutput } from 'nerva-connector-protocol/execution/ExecutionOutput.js';
import { ExecutionResultCodec } from '../../src/execution/ExecutionResultCodec.js';
import {
    ExecutionFailure,
    type ExecutionResult,
} from 'nerva-connector-protocol/execution/ExecutionTypes.js';
import { FileHistoryFixture } from './FileHistoryFixture.js';
import {
    OriginalJournalFixtureCodec,
    type OriginalJournalFixtureSnapshot,
} from './OriginalJournalFixtureCodec.js';

/** Three real purpose-separated AES stores contain old originals; no execution policy/native program is installed or loaded. */
export class HistoryMigrationFixture implements AsyncDisposable {
    private constructor(
        public readonly file: FileHistoryFixture,
        public readonly identity: ConnectorClientIdentity,
        public readonly executionState: string,
    ) {}

    /** Missing executable policy is intentional: format migration must not require native code merely to retain original metadata. */
    public static async create(): Promise<HistoryMigrationFixture> {
        const file: FileHistoryFixture = await FileHistoryFixture.create();
        try {
            const state: string = join(file.files.directory, 'execution-history');
            await mkdir(state, { mode: 0o700 });
            const identity: ConnectorClientIdentity = {
                ...file.identity,
                settings: {
                    ...file.identity.settings,
                    execution: {
                        stateDirectory: state,
                        policyFile: join(file.files.directory, 'missing-native-policy.json'),
                    },
                },
            };
            await writeFile(identity.configurationFile, JSON.stringify(identity.settings), {
                mode: 0o600,
            });
            await file.retainOriginal(file.permit());
            for (const lane of Object.values(ExecutionLane)) {
                const directory: string = join(state, lane);
                await mkdir(directory, { mode: 0o700 });
                const operation: ExecutionJournalCodec = new ExecutionJournalCodec(lane);
                const codec: OriginalJournalFixtureCodec<
                    ExecutionRequest,
                    ExecutionResult,
                    ExecutionOutput
                > = new OriginalJournalFixtureCodec(operation);
                await using store: ConnectorJournalStore<
                    OriginalJournalFixtureSnapshot<
                        ExecutionRequest,
                        ExecutionResult,
                        ExecutionOutput
                    >
                > = await ConnectorJournalStore.open(
                    directory,
                    identity.settings.enrollmentId,
                    identity.key,
                    operation.purpose,
                    codec,
                );
                const request: ExecutionRequest = ExecutionJobsCodec.request({
                    requestId: 'request-' + lane,
                    policySha256: 'a'.repeat(64),
                    rootId: 'project',
                    programId: 'probe',
                    arguments: ['PRIVATE_ORIGINAL_ARGUMENT'],
                });
                const acknowledged: bigint = lane === ExecutionLane.First ? 0n : 9007199254740993n;
                await store.write(
                    {
                        journalId: (lane === ExecutionLane.First ? 'b' : 'c').repeat(64),
                        acknowledgedSequence: acknowledged,
                        receipt:
                            acknowledged === 0n
                                ? null
                                : {
                                      jobId: 'prior',
                                      sequence: acknowledged,
                                      dispatchId: Buffer.alloc(32, 2).toString('base64url'),
                                      requestHash: 'd'.repeat(64),
                                      responseHash: 'e'.repeat(64),
                                  },
                        pending: {
                            jobId: 'job-' + lane,
                            sequence: acknowledged + 1n,
                            dispatchId: Buffer.alloc(
                                32,
                                lane === ExecutionLane.First ? 3 : 4,
                            ).toString('base64url'),
                            requestHash: ExecutionProof.requestHash(request),
                            request,
                            response:
                                lane === ExecutionLane.First
                                    ? null
                                    : ExecutionResultCodec.interrupted(
                                          ExecutionFailure.Interrupted,
                                      ),
                            progress:
                                lane === ExecutionLane.First
                                    ? { stdoutBase64: 'AP8=', stderrBase64: 'AQ==' }
                                    : null,
                        },
                    },
                    true,
                );
            }
            return new HistoryMigrationFixture(file, identity, state);
        } catch (caught: unknown) {
            await file[Symbol.asyncDispose]();
            throw caught;
        }
    }

    /** Every task-owned store and identity is removed after migration releases all locks. */
    public async [Symbol.asyncDispose](): Promise<void> {
        await this.file[Symbol.asyncDispose]();
    }
}
