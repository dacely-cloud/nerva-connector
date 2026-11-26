// SPDX-FileCopyrightText: 2026 Dacely <business@dacely.com>
// SPDX-License-Identifier: LicenseRef-Proprietary

import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { SharedExecutionFixture } from './SharedExecutionFixture.js';
import type { ConnectorClientIdentity } from '../../src/runtime/ConnectorClientConfiguration.js';
import { ConnectorOperationJournal } from '../../src/runtime/ConnectorOperationJournal.js';
import { ConnectorFileJournalCodec } from '../../src/runtime/ConnectorFileJournalCodec.js';
import type { ConnectorFileOperation } from 'nerva-connector-protocol/protocol/ConnectorFileJobs.js';
import type { ConnectorFileResponse } from 'nerva-connector-protocol/protocol/ConnectorFiles.js';
import { ExecutionJournalCodec } from '../../src/execution/ExecutionJournalCodec.js';
import type { ExecutionRequest } from 'nerva-connector-protocol/execution/ExecutionJobs.js';
import { ExecutionLane } from 'nerva-connector-protocol/execution/ExecutionLane.js';
import type { ExecutionResult } from 'nerva-connector-protocol/execution/ExecutionTypes.js';
import type { ExecutionOutput } from 'nerva-connector-protocol/execution/ExecutionOutput.js';
import {
    ConnectorFilePolicy,
    type ConnectorFilePolicyDefinition,
} from '../../src/runtime/ConnectorFilePolicy.js';
import {
    JointWorkspaceConfiguration,
    type JointWorkspaceConfigurationPaths,
    type JointWorkspaceLocalConfiguration,
} from '../../src/workspace/JointWorkspaceConfiguration.js';
import { JointWorkspaceJournal } from '../../src/workspace/JointWorkspaceJournal.js';
import type { JointWorkspaceJournalIdentity } from '../../src/workspace/JointWorkspaceJournalTypes.js';

/** Original protected identity, actual helper policies and three real encrypted operation histories are reused without command execution. */
export class JointWorkspaceInstallationFixture implements AsyncDisposable {
    public readonly signal: AbortSignal = new AbortController().signal;
    public readonly paths: JointWorkspaceConfigurationPaths;
    public readonly requestFile: string;

    private constructor(
        public readonly source: SharedExecutionFixture,
        public readonly identity: ConnectorClientIdentity,
        public readonly mapping: JointWorkspaceLocalConfiguration,
    ) {
        this.paths = JointWorkspaceConfiguration.paths(identity.settings.privateKeyFile);
        this.requestFile = join(source.native.directory, 'requested-bindings.json');
    }

    public static async create(
        secondPair: boolean = false,
    ): Promise<JointWorkspaceInstallationFixture> {
        const source: SharedExecutionFixture = await SharedExecutionFixture.create();
        try {
            const stateDirectory: string = join(source.native.directory, 'files-state');
            await mkdir(stateDirectory, { mode: 0o700 });
            const identity: ConnectorClientIdentity = {
                ...source.identity,
                settings: {
                    ...source.identity.settings,
                    files: { policyFile: source.native.filePolicy, stateDirectory },
                },
            };
            const first: JointWorkspaceLocalConfiguration = {
                roots: [
                    {
                        fileRootId: source.native.fileRootId,
                        executionRootId: source.native.executionRootId,
                    },
                ],
            };
            const mapping: JointWorkspaceLocalConfiguration = secondPair
                ? {
                      roots: [
                          ...first.roots,
                          { fileRootId: 'files-second', executionRootId: 'commands-second' },
                      ],
                  }
                : first;
            if (secondPair) {
                const files: ConnectorFilePolicyDefinition = await ConnectorFilePolicy.load(
                    source.native.filePolicy,
                );
                await writeFile(
                    source.native.filePolicy,
                    this.encode({
                        ...files,
                        roots: [
                            ...files.roots,
                            {
                                id: 'files-second',
                                path: source.native.differentRoot,
                                stagingPath: null,
                            },
                        ],
                    }),
                    { mode: 0o600 },
                );
                await writeFile(
                    source.native.executionPolicy,
                    this.encode({
                        ...source.native.executionDefinition,
                        roots: [
                            ...source.native.executionDefinition.roots,
                            {
                                ...source.native.executionDefinition.roots[0],
                                id: 'commands-second',
                                path: source.native.differentRoot,
                            },
                        ],
                    }),
                    { mode: 0o600 },
                );
            }
            await writeFile(identity.configurationFile, JSON.stringify(identity.settings), {
                mode: 0o600,
            });
            await ConnectorOperationJournal.initialize(
                stateDirectory,
                identity.settings.enrollmentId,
                identity.key,
                new ConnectorFileJournalCodec(),
            );
            const fixture: JointWorkspaceInstallationFixture =
                new JointWorkspaceInstallationFixture(source, identity, mapping);
            await writeFile(fixture.requestFile, JointWorkspaceConfiguration.encode(mapping), {
                mode: 0o600,
            });
            return fixture;
        } catch (caught: unknown) {
            await source[Symbol.asyncDispose]();
            throw caught;
        }
    }

    /** Original operation history remains independently owned; only public permanent IDs feed the new journal context. */
    public async workspaces(): Promise<JointWorkspaceJournal> {
        const files: typeof this.identity.settings.files = this.identity.settings.files;
        const execution: typeof this.identity.settings.execution = this.identity.settings.execution;
        if (files === null || execution === null) {
            throw new Error('Both actual fixture capabilities required');
        }
        await using file: ConnectorOperationJournal<ConnectorFileOperation, ConnectorFileResponse> =
            await ConnectorOperationJournal.load(
                files.stateDirectory,
                this.identity.settings.enrollmentId,
                this.identity.key,
                new ConnectorFileJournalCodec(),
            );
        await using first: ConnectorOperationJournal<
            ExecutionRequest,
            ExecutionResult,
            ExecutionOutput
        > = await ConnectorOperationJournal.load(
            join(execution.stateDirectory, ExecutionLane.First),
            this.identity.settings.enrollmentId,
            this.identity.key,
            new ExecutionJournalCodec(ExecutionLane.First),
        );
        await using second: ConnectorOperationJournal<
            ExecutionRequest,
            ExecutionResult,
            ExecutionOutput
        > = await ConnectorOperationJournal.load(
            join(execution.stateDirectory, ExecutionLane.Second),
            this.identity.settings.enrollmentId,
            this.identity.key,
            new ExecutionJournalCodec(ExecutionLane.Second),
        );
        const identity: JointWorkspaceJournalIdentity = {
            scope: {
                authorityId: this.identity.settings.authorityId,
                authorityPublicKey: this.identity.authority.publicKey,
                environmentId: this.identity.settings.environmentId,
                enrollmentId: this.identity.settings.enrollmentId,
                devicePublicKey: this.identity.publicKey,
            },
            fileJournalId: file.id,
            executionJournals: { first: first.id, second: second.id },
        };
        return await JointWorkspaceJournal.open(
            this.paths.stateDirectory,
            this.identity.key,
            identity,
            this.signal,
        );
    }

    public async originalBytes(): Promise<readonly Buffer[]> {
        const settings: typeof this.identity.settings = this.identity.settings;
        if (settings.files === null || settings.execution === null) {
            throw new Error('Original fixture histories required');
        }
        const executionDirectory: string = settings.execution.stateDirectory;
        return await Promise.all(
            [
                settings.privateKeyFile,
                this.identity.configurationFile,
                join(settings.files.stateDirectory, 'file-journal'),
                ...Object.values(ExecutionLane).map((lane: ExecutionLane): string =>
                    join(executionDirectory, lane, 'execution-journal'),
                ),
            ].map((path: string): Promise<Buffer> => readFile(path)),
        );
    }

    public static encode(
        value:
            ConnectorFilePolicyDefinition | SharedExecutionFixture['native']['executionDefinition'],
    ): string {
        return JSON.stringify(value, (_key: string, entry: unknown): unknown =>
            _key === 'stagingPath' && entry === null
                ? undefined
                : typeof entry === 'bigint'
                  ? entry.toString()
                  : entry,
        );
    }

    public async [Symbol.asyncDispose](): Promise<void> {
        await this.source[Symbol.asyncDispose]();
    }
}
