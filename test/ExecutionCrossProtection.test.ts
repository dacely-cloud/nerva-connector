// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { SigningKey } from '../src/identity/SigningKey.js';
import { Boundary } from 'nerva-connector-protocol/protocol/Boundary.js';
import { ConnectorFileMode } from 'nerva-connector-protocol/protocol/ConnectorFiles.js';
import { ExecutionWorkspaceAccess } from '../src/execution/ExecutionTypes.js';
import { ExecutionLane } from 'nerva-connector-protocol/execution/ExecutionLane.js';
import { ExecutionConfiguration } from '../src/execution/ExecutionConfiguration.js';
import { ExecutionPolicy } from '../src/execution/ExecutionPolicy.js';
import type { ExecutionPolicyDefinition } from '../src/execution/ExecutionPolicyTypes.js';
import type { ConnectorClientIdentity } from '../src/runtime/ConnectorClientConfiguration.js';
import { InspectionFixture } from './support/InspectionFixture.js';

/** Both private native code and upload scratch must stay outside every command grant. */
enum FileAuthority {
    Helper = 'helper',
    Staging = 'staging',
    StagingChild = 'staging-child',
    StateChild = 'state-child',
}

const helpers: boolean =
    process.env['NERVA_CONNECTOR_FILES_HELPER'] !== undefined &&
    process.env['NERVA_CONNECTOR_EXEC_HELPER'] !== undefined;

it.skipIf(!helpers)(
    'noncanonical private authority references cannot weaken command-root prefix exclusions',
    async (): Promise<void> => {
        await using fixture: InspectionFixture = await InspectionFixture.create();
        await expect(
            ExecutionPolicy.load(fixture.executionPolicy, [
                fixture.directory + '/different-project/../project',
            ]),
        ).rejects.toThrow('Canonical');
    },
);

/** The normal execution loader consumes a previously validated local identity; this fixture supplies only owned references. */
function identity(fixture: InspectionFixture, key: SigningKey): ConnectorClientIdentity {
    return {
        configurationFile: join(fixture.directory, 'runtime.json'),
        settings: {
            authorityId: 'test-authority',
            authorityPublicKeyFile: join(fixture.directory, 'authority.json'),
            environmentId: 'test-environment',
            enrollmentId: 'conn_' + 'c'.repeat(64),
            slot: 0,
            endpoints: ['wss://127.0.0.1:1/v1/connector/tunnel'],
            privateKeyFile: join(fixture.directory, 'device-key.json'),
            serverCaFile: null,
            files: {
                policyFile: fixture.filePolicy,
                stateDirectory: join(fixture.directory, 'files-history'),
            },
            execution: {
                policyFile: fixture.executionPolicy,
                stateDirectory: join(fixture.directory, 'commands-history'),
            },
        },
        key,
        publicKey: key.publicKey,
        ca: undefined,
        authority: { authorityId: 'test-authority', publicKey: key.publicKey },
    };
}

it.skipIf(!helpers).each(Object.values(FileAuthority))(
    'the runtime command loader rejects a separate root containing file %s authority before any native launch',
    async (component: FileAuthority): Promise<void> => {
        await using fixture: InspectionFixture = await InspectionFixture.create(
            ConnectorFileMode.ReadWrite,
            ExecutionWorkspaceAccess.ReadWrite,
        );
        using key: SigningKey = SigningKey.generate();
        const client: ConnectorClientIdentity = identity(fixture, key);
        let root: string = join(fixture.directory, 'staging');
        if (component === FileAuthority.StagingChild || component === FileAuthority.StateChild) {
            root = join(
                fixture.directory,
                component === FileAuthority.StagingChild ? 'staging' : 'files-history',
                'nested',
            );
            await mkdir(root, { recursive: true, mode: 0o700 });
        }
        if (component === FileAuthority.Helper) {
            root = fixture.differentRoot;
            const helper: string | undefined = process.env['NERVA_CONNECTOR_FILES_HELPER'];
            if (helper === undefined) {
                throw new Error('Explicit actual file helper required');
            }
            const target: string = join(root, 'file-helper');
            await copyFile(helper, target);
            const raw: unknown = JSON.parse(await readFile(fixture.filePolicy, 'utf8'));
            const policy: Readonly<Record<string, unknown>> = Boundary.record(raw, [
                'mode',
                'revision',
                'helperFile',
                'helperSha256',
                'roots',
            ]);
            await writeFile(
                fixture.filePolicy,
                JSON.stringify({
                    ...policy,
                    helperFile: target,
                    helperSha256: createHash('sha256')
                        .update(await readFile(target))
                        .digest('hex'),
                }),
                { mode: 0o600 },
            );
        }
        const definition: ExecutionPolicyDefinition = {
            ...fixture.executionDefinition,
            roots: [
                {
                    id: fixture.executionRootId,
                    path: root,
                    access: ExecutionWorkspaceAccess.ReadWrite,
                },
            ],
        };
        await writeFile(
            fixture.executionPolicy,
            JSON.stringify(definition, (_key: string, value: unknown): unknown =>
                typeof value === 'bigint' ? value.toString() : value,
            ),
            { mode: 0o600 },
        );
        const before: Buffer = await readFile(fixture.filePolicy);
        const load: () => Promise<void> = async (): Promise<void> => {
            const policy: ExecutionPolicy = await ExecutionConfiguration.loadPolicy(client, {
                lane: ExecutionLane.First,
                policyFile: fixture.executionPolicy,
                stateDirectory: join(fixture.directory, 'commands-history'),
            });
            await policy[Symbol.asyncDispose]();
        };
        await expect(load()).rejects.toThrow('overlaps protected');
        expect(await readFile(fixture.filePolicy)).toEqual(before);
    },
);
