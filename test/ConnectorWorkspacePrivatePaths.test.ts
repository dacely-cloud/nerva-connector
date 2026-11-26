// SPDX-FileCopyrightText: 2026 Dacely <business@dacely.com>
// SPDX-License-Identifier: LicenseRef-Proprietary

import { readFile, writeFile, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { ConnectorClientFiles } from '../src/runtime/ConnectorClientFiles.js';
import { ConnectorFilePolicy } from '../src/runtime/ConnectorFilePolicy.js';
import { ConnectorFileMode } from 'nerva-connector-protocol/protocol/ConnectorFiles.js';
import { ExecutionConfiguration } from '../src/execution/ExecutionConfiguration.js';
import { ExecutionPolicyCodec } from '../src/execution/ExecutionPolicyCodec.js';
import type { ExecutionPolicyDefinition } from 'nerva-connector-protocol/execution/ExecutionPolicyTypes.js';
import type { ExecutionClientSettings } from '../src/execution/ExecutionClientSettings.js';
import { JointWorkspaceConfiguration } from '../src/workspace/JointWorkspaceConfiguration.js';
import { FileHistoryFixture } from './support/FileHistoryFixture.js';
import { ExecutionFixture } from './support/ExecutionFixture.js';
import { ExecutionIdentity } from './support/ExecutionIdentity.js';
import { setup } from './support/ExecutionSetup.js';

const filesHelper: string | undefined = process.env['NERVA_CONNECTOR_FILES_HELPER'];
const execHelper: string | undefined = process.env['NERVA_CONNECTOR_EXEC_HELPER'];

/** Exact future private leaves are protected before any file or directory exists there. */
enum WorkspacePrivateLeaf {
    Mapping = 'configurationFile',
    History = 'stateDirectory',
    Setup = 'setupFile',
}

it.skipIf(filesHelper === undefined).each(Object.values(WorkspacePrivateLeaf))(
    'actual file policy preflight refuses the absent joint %s leaf as a root or write stage without touching existing history',
    async (leaf: WorkspacePrivateLeaf): Promise<void> => {
        await using fixture: FileHistoryFixture = await FileHistoryFixture.create();
        const paths: ReturnType<typeof JointWorkspaceConfiguration.paths> =
            JointWorkspaceConfiguration.paths(fixture.identity.settings.privateKeyFile);
        const forbidden: string = paths[leaf];
        await expect(lstat(forbidden)).rejects.toMatchObject({ code: 'ENOENT' });
        const original: Awaited<ReturnType<typeof ConnectorFilePolicy.load>> =
            await ConnectorFilePolicy.load(fixture.files.policy);
        const history: Buffer = await readFile(join(fixture.state, 'file-journal'));
        await writeFile(
            fixture.files.policy,
            JSON.stringify(
                {
                    ...original,
                    roots: [
                        {
                            id: 'project',
                            path: forbidden,
                            stagingPath: join(fixture.files.directory, 'staging'),
                        },
                    ],
                },
                (_key: string, value: unknown): unknown =>
                    typeof value === 'bigint' ? value.toString() : value,
            ),
            { mode: 0o600 },
        );
        await expect(ConnectorClientFiles.load(fixture.identity)).rejects.toThrow(
            'overlaps protected',
        );
        await writeFile(
            fixture.files.policy,
            JSON.stringify(
                {
                    ...original,
                    mode: ConnectorFileMode.ReadWrite,
                    roots: [{ id: 'project', path: fixture.files.root, stagingPath: forbidden }],
                },
                (_key: string, value: unknown): unknown =>
                    typeof value === 'bigint' ? value.toString() : value,
            ),
            { mode: 0o600 },
        );
        await expect(ConnectorClientFiles.load(fixture.identity)).rejects.toThrow(
            'overlaps protected',
        );
        expect(await readFile(join(fixture.state, 'file-journal'))).toEqual(history);
        await expect(lstat(forbidden)).rejects.toMatchObject({ code: 'ENOENT' });
    },
);

it.skipIf(execHelper === undefined).each(Object.values(WorkspacePrivateLeaf))(
    'actual command policy preflight refuses the absent joint %s leaf as a workspace without creating it or journals',
    async (leaf: WorkspacePrivateLeaf): Promise<void> => {
        if (execHelper === undefined) {
            throw new Error('Explicit native execution helper required');
        }
        await using fixture: ExecutionFixture = await ExecutionFixture.create(execHelper);
        const settings: ExecutionClientSettings = await setup(fixture);
        using authority: ExecutionIdentity = new ExecutionIdentity(fixture.directory, settings);
        const paths: ReturnType<typeof JointWorkspaceConfiguration.paths> =
            JointWorkspaceConfiguration.paths(authority.identity.settings.privateKeyFile);
        const forbidden: string = paths[leaf];
        await expect(lstat(forbidden)).rejects.toMatchObject({ code: 'ENOENT' });
        const definition: ExecutionPolicyDefinition = ExecutionPolicyCodec.policy(
            JSON.parse(await readFile(settings.policyFile, 'utf8')),
        );
        await writeFile(
            settings.policyFile,
            JSON.stringify(
                {
                    ...definition,
                    roots: definition.roots.map((root): (typeof definition.roots)[number] => ({
                        ...root,
                        path: forbidden,
                    })),
                },
                (_key: string, value: unknown): unknown =>
                    typeof value === 'bigint' ? value.toString() : value,
            ),
            { mode: 0o600 },
        );
        await expect(
            ExecutionConfiguration.loadPolicy(authority.identity, settings),
        ).rejects.toThrow('overlaps protected');
        await expect(lstat(forbidden)).rejects.toMatchObject({ code: 'ENOENT' });
        await expect(
            lstat(ExecutionConfiguration.journalDirectory(settings)),
        ).rejects.toMatchObject({ code: 'ENOENT' });
    },
    20000,
);
