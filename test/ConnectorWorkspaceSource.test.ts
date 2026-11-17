// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, it, vi, type MockInstance } from 'vitest';
import { ConnectorClientFiles } from '../src/runtime/ConnectorClientFiles.js';
import { ConnectorClientExecution } from '../src/runtime/ConnectorClientExecution.js';
import { ConnectorOperationJournal } from '../src/runtime/ConnectorOperationJournal.js';
import { ExecutionClient } from '../src/execution/ExecutionClient.js';
import { ExecutionConfiguration } from '../src/execution/ExecutionConfiguration.js';
import { ExecutionPairPreparation } from '../src/execution/ExecutionPairPreparation.js';
import { ExecutionPolicy } from '../src/execution/ExecutionPolicy.js';
import { ExecutionArgumentKind } from 'nerva-connector-protocol/execution/ExecutionArgumentKind.js';
import { type ExecutionPublication } from '../src/execution/ExecutionJobs.js';
import { ExecutionLane } from 'nerva-connector-protocol/execution/ExecutionLane.js';
import type { ExecutionClientSettings } from '../src/execution/ExecutionClientSettings.js';
import type { ConnectorDeviceLease } from 'nerva-connector-protocol/protocol/ConnectorDevice.js';
import type {
    ConnectorFileWorkspaceSource,
    ConnectorExecutionWorkspaceSource,
} from '../src/workspace/ConnectorWorkspaceSource.js';
import { FileHistoryFixture } from './support/FileHistoryFixture.js';
import { ExecutionFixture } from './support/ExecutionFixture.js';
import { ExecutionIdentity } from './support/ExecutionIdentity.js';
import { setup } from './support/ExecutionSetup.js';

const filesHelper: string | undefined = process.env['NERVA_CONNECTOR_FILES_HELPER'];
const execHelper: string | undefined = process.env['NERVA_CONNECTOR_EXEC_HELPER'];

it.skipIf(filesHelper === undefined)(
    'file workspace projections borrow the actual loaded filesystem and original journal without creating or rewriting history, and retained getters close with the owner',
    async (): Promise<void> => {
        await using fixture: FileHistoryFixture = await FileHistoryFixture.create();
        const before: Buffer = await readFile(join(fixture.state, 'file-journal'));
        await using clientOwner: AsyncDisposableStack = new AsyncDisposableStack();
        const client: ConnectorClientFiles = clientOwner.use(
            await ConnectorClientFiles.load(fixture.identity),
        );
        const source: ConnectorFileWorkspaceSource = client.workspaceSource;
        try {
            expect(client.workspaceSource).toBe(source);
            expect(Object.isFrozen(source)).toBe(true);
            expect(source.profile).toBe(source.filesystem.profile);
            expect(Object.isFrozen(source.profile)).toBe(true);
            expect(source.journalId).toMatch(/^[a-f0-9]{64}$/u);
            const publication: ReturnType<ConnectorClientFiles['publication']> = client.publication(
                'A'.repeat(43),
            );
            expect(publication.profile).toBe(source.profile);
            expect(publication.journalId).toBe(source.journalId);
            expect(await readFile(join(fixture.state, 'file-journal'))).toEqual(before);
            const failed: MockInstance<() => boolean> = vi
                .spyOn(ConnectorOperationJournal.prototype, 'failed', 'get')
                .mockReturnValue(true);
            try {
                expect((): ConnectorFileWorkspaceSource => client.workspaceSource).toThrow(
                    'unavailable',
                );
                expect((): string => source.journalId).toThrow('unavailable');
                expect((): typeof source.filesystem => source.filesystem).toThrow('unavailable');
                expect((): typeof source.profile => source.profile).toThrow('unavailable');
                expect((): ReturnType<ConnectorClientFiles['publication']> =>
                    client.publication('A'.repeat(43)),
                ).toThrow('unavailable');
            } finally {
                failed.mockRestore();
            }
        } finally {
            await clientOwner.disposeAsync();
        }
        expect((): ConnectorFileWorkspaceSource => client.workspaceSource).toThrow('unavailable');
        expect((): typeof source.filesystem => source.filesystem).toThrow('unavailable');
        expect((): typeof source.profile => source.profile).toThrow('unavailable');
        expect((): string => source.journalId).toThrow('unavailable');
    },
);

it.skipIf(execHelper === undefined)(
    'both permanent command journals expose one actual shared policy before activation, with immutable public grants and closed or failed borrowed getters',
    async (): Promise<void> => {
        if (execHelper === undefined) {
            throw new Error('Explicit native execution helper required');
        }
        await using fixture: ExecutionFixture = await ExecutionFixture.create(execHelper);
        const settings: ExecutionClientSettings = await setup(fixture);
        using authority: ExecutionIdentity = new ExecutionIdentity(fixture.directory, settings);
        await ExecutionPairPreparation.prepare(authority.identity, true);
        const firstPath: string = join(
            settings.stateDirectory,
            ExecutionLane.First,
            'execution-journal',
        );
        const secondPath: string = join(
            settings.stateDirectory,
            ExecutionLane.Second,
            'execution-journal',
        );
        const firstBefore: Buffer = await readFile(firstPath);
        const secondBefore: Buffer = await readFile(secondPath);
        await using ownerResources: AsyncDisposableStack = new AsyncDisposableStack();
        const load: MockInstance<typeof ExecutionPolicy.load> = vi.spyOn(ExecutionPolicy, 'load');
        ownerResources.defer((): void => load.mockRestore());
        const owner: ConnectorClientExecution = ownerResources.use(
            await ConnectorClientExecution.load(authority.identity),
        );
        const source: ConnectorExecutionWorkspaceSource = owner.workspaceSource;
        const firstJournalId: string = source.journals.first;
        try {
            expect(load).toHaveBeenCalledTimes(1);
            expect(owner.workspaceSource).toBe(source);
            expect(Object.isFrozen(source)).toBe(true);
            expect(Object.isFrozen(source.journals)).toBe(true);
            expect(source.journals.first).not.toBe(source.journals.second);
            expect(source.profile.policySha256).toBe(source.policy.policySha256);
            expect(source.profile.revision).toBe(source.policy.definition.revision);
            expect(Object.isFrozen(source.profile)).toBe(true);
            expect(Object.isFrozen(source.profile.roots)).toBe(true);
            expect(Object.isFrozen(source.profile.resources)).toBe(true);
            for (const program of source.profile.programs) {
                expect(Object.isFrozen(program)).toBe(true);
                expect(Object.isFrozen(program.rootIds)).toBe(true);
                expect(Object.isFrozen(program.arguments)).toBe(true);
                for (const argument of program.arguments) {
                    expect(Object.isFrozen(argument)).toBe(true);
                    if (argument.kind === ExecutionArgumentKind.Choice) {
                        expect(Object.isFrozen(argument.values)).toBe(true);
                    }
                }
            }
            const lease: ConnectorDeviceLease = authority.lease();
            const link: Parameters<ConnectorClientExecution['activate']>[0] = {
                session: authority.session(lease),
                leaseId: lease.leaseId,
                send: (): void => {},
                close: (): void => {},
            };
            const publications: readonly ExecutionPublication[] = owner.activate(link);
            expect(publications[0]?.profile).toBe(source.profile);
            expect(publications[1]?.profile).toEqual(source.profile);
            expect(publications[0]?.journalId).toBe(source.journals.first);
            expect(publications[1]?.journalId).toBe(source.journals.second);
            owner.detach(link);
            expect(owner.workspaceSource).toBe(source);
            expect(await readFile(firstPath)).toEqual(firstBefore);
            expect(await readFile(secondPath)).toEqual(secondBefore);
            const failed: MockInstance<() => boolean> = vi
                .spyOn(ExecutionClient.prototype, 'failed', 'get')
                .mockReturnValue(true);
            try {
                expect((): ConnectorExecutionWorkspaceSource => owner.workspaceSource).toThrow(
                    'unavailable',
                );
                expect((): typeof source.policy => source.policy).toThrow('unavailable');
                expect((): typeof source.profile => source.profile).toThrow('unavailable');
                expect((): typeof source.journals => source.journals).toThrow('unavailable');
            } finally {
                failed.mockRestore();
            }
        } finally {
            await ownerResources.disposeAsync();
        }
        expect((): ConnectorExecutionWorkspaceSource => owner.workspaceSource).toThrow(
            'unavailable',
        );
        expect((): typeof source.policy => source.policy).toThrow('unavailable');
        expect((): typeof source.profile => source.profile).toThrow('unavailable');
        expect((): typeof source.journals => source.journals).toThrow('unavailable');
        await using policy: ExecutionPolicy = await ExecutionConfiguration.loadPolicy(
            authority.identity,
            settings,
        );
        const client: ExecutionClient = await ExecutionClient.load(
            authority.identity,
            settings,
            policy,
        );
        try {
            expect(client.journalId).toBe(firstJournalId);
            const failed: MockInstance<() => boolean> = vi
                .spyOn(ConnectorOperationJournal.prototype, 'failed', 'get')
                .mockReturnValue(true);
            try {
                expect((): string => client.journalId).toThrow('unavailable');
                expect((): typeof client.profile => client.profile).toThrow('unavailable');
            } finally {
                failed.mockRestore();
            }
        } finally {
            await client[Symbol.asyncDispose]();
        }
        expect((): string => client.journalId).toThrow('unavailable');
        expect((): typeof client.profile => client.profile).toThrow('unavailable');
    },
    20000,
);
