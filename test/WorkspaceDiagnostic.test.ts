// SPDX-FileCopyrightText: 2026 Dacely <business@dacely.com>
// SPDX-License-Identifier: LicenseRef-Proprietary

import { execFile } from 'node:child_process';
import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';
import { SigningKey } from '../src/identity/SigningKey.js';
import { SignatureSuite } from 'nerva-connector-protocol/identity/IdentityFormat.js';
import { ConnectorFileMode } from 'nerva-connector-protocol/protocol/ConnectorFiles.js';
import { ExecutionWorkspaceAccess } from 'nerva-connector-protocol/execution/ExecutionTypes.js';
import {
    WorkspaceDiagnostic,
    WorkspaceCompatibility,
    type WorkspaceDiagnosticRequest,
    type WorkspaceDiagnosticReport,
} from '../src/workspace/WorkspaceDiagnostic.js';
import { InspectionFixture } from './support/InspectionFixture.js';
import {
    ConnectorClientConfiguration,
    type ConnectorClientIdentity,
} from '../src/runtime/ConnectorClientConfiguration.js';
import type { ConnectorClientSettings } from '../src/runtime/ConnectorClientSettings.js';
import { NetworkCanary } from './support/NetworkCanary.js';

const helpers: boolean =
    process.platform === 'linux' &&
    process.env['NERVA_CONNECTOR_FILES_HELPER'] !== undefined &&
    process.env['NERVA_CONNECTOR_EXEC_HELPER'] !== undefined;

it.skipIf(!helpers)(
    'a private key file does not implicitly forbid unrelated workspaces below its parent directory',
    async (): Promise<void> => {
        await using fixture: InspectionFixture = await InspectionFixture.create();
        await using network: NetworkCanary = new NetworkCanary();
        const input: WorkspaceDiagnosticRequest = await request(fixture, await network.endpoint());
        const loaded: ConnectorClientIdentity = await ConnectorClientConfiguration.load(
            input.configurationFile,
        );
        using keys: DisposableStack = new DisposableStack();
        keys.use(loaded.key);
        const path: string = join(fixture.directory, 'device-key.json');
        await rename(loaded.settings.privateKeyFile, path);
        const settings: ConnectorClientSettings = { ...loaded.settings, privateKeyFile: path };
        await writeFile(input.configurationFile, JSON.stringify(settings), { mode: 0o600 });
        expect(await WorkspaceDiagnostic.inspect(input, new AbortController().signal)).toEqual({
            fileRootId: fixture.fileRootId,
            executionRootId: fixture.executionRootId,
            status: WorkspaceCompatibility.Compatible,
        });
        expect(network.connections).toBe(0);
    },
);

/** Only test-owned device and public authority files are created; the journals intentionally do not exist. */
async function request(
    fixture: InspectionFixture,
    endpoint: string,
): Promise<WorkspaceDiagnosticRequest> {
    const directory: string = join(fixture.directory, 'identity');
    await mkdir(directory, { mode: 0o700 });
    using device: SigningKey = SigningKey.generate();
    using authority: SigningKey = SigningKey.generate();
    const secret: Buffer = device.encode();
    try {
        await writeFile(join(directory, 'device-key.json'), secret, { mode: 0o600 });
    } finally {
        secret.fill(0);
    }
    const pin: string = join(directory, 'authority.json');
    await writeFile(
        pin,
        JSON.stringify({ suite: SignatureSuite.MlDsa44Ed25519, publicKey: authority.publicKey }),
        { mode: 0o600 },
    );
    const configurationFile: string = join(fixture.directory, 'runtime.json');
    await writeFile(
        configurationFile,
        JSON.stringify({
            authorityId: 'authority',
            authorityPublicKeyFile: pin,
            environmentId: 'environment',
            enrollmentId: 'conn_' + 'a'.repeat(64),
            slot: 0,
            endpoints: [endpoint],
            privateKeyFile: join(directory, 'device-key.json'),
            serverCaFile: null,
            files: {
                policyFile: fixture.filePolicy,
                stateDirectory: join(fixture.directory, 'files-history'),
            },
            execution: {
                policyFile: fixture.executionPolicy,
                stateDirectory: join(fixture.directory, 'commands-history'),
            },
        }),
        { mode: 0o600 },
    );
    return {
        configurationFile,
        fileRootId: fixture.fileRootId,
        executionRootId: fixture.executionRootId,
    };
}

it.skipIf(!helpers).each([
    [
        ConnectorFileMode.ReadOnly,
        ExecutionWorkspaceAccess.ReadOnly,
        true,
        WorkspaceCompatibility.Compatible,
    ],
    [
        ConnectorFileMode.ReadWrite,
        ExecutionWorkspaceAccess.ReadWrite,
        true,
        WorkspaceCompatibility.Compatible,
    ],
    [
        ConnectorFileMode.ReadOnly,
        ExecutionWorkspaceAccess.ReadOnly,
        false,
        WorkspaceCompatibility.DifferentRoot,
    ],
    [
        ConnectorFileMode.ReadOnly,
        ExecutionWorkspaceAccess.ReadWrite,
        true,
        WorkspaceCompatibility.AccessMismatch,
    ],
] satisfies readonly (readonly [
    ConnectorFileMode,
    ExecutionWorkspaceAccess,
    boolean,
    WorkspaceCompatibility,
])[])(
    'real native helper inspection returns %s/%s/same=%s: %s without grants, network or journal creation',
    async (
        mode: ConnectorFileMode,
        access: ExecutionWorkspaceAccess,
        same: boolean,
        status: WorkspaceCompatibility,
    ): Promise<void> => {
        await using fixture: InspectionFixture = await InspectionFixture.create(mode, access, same);
        await using network: NetworkCanary = new NetworkCanary();
        const input: WorkspaceDiagnosticRequest = await request(fixture, await network.endpoint());
        const before: readonly string[] = await readdir(fixture.directory, { recursive: true });
        const policy: Buffer = await readFile(fixture.filePolicy);
        const key: Buffer = await readFile(join(fixture.directory, 'identity/device-key.json'));
        try {
            const report: WorkspaceDiagnosticReport = await WorkspaceDiagnostic.inspect(
                input,
                new AbortController().signal,
            );
            expect(report).toEqual({
                fileRootId: fixture.fileRootId,
                executionRootId: fixture.executionRootId,
                status,
            });
            expect((await readFile(fixture.filePolicy)).equals(policy)).toBe(true);
            expect(
                (await readFile(join(fixture.directory, 'identity/device-key.json'))).equals(key),
            ).toBe(true);
            expect(await readdir(fixture.directory, { recursive: true })).toEqual(before);
            expect(network.connections).toBe(0);
            expect(
                await WorkspaceDiagnostic.inspect(
                    { ...input, executionRootId: 'not-granted' },
                    new AbortController().signal,
                ),
            ).toMatchObject({ status: WorkspaceCompatibility.Unavailable });
        } finally {
            key.fill(0);
        }
    },
);

it.skipIf(!helpers)(
    'the actual standalone Main command reports only aliases/status and grants nothing',
    async (): Promise<void> => {
        await using fixture: InspectionFixture = await InspectionFixture.create();
        await using network: NetworkCanary = new NetworkCanary();
        const input: WorkspaceDiagnosticRequest = await request(fixture, await network.endpoint());
        const before: readonly string[] = await readdir(fixture.directory, { recursive: true });
        const result: Awaited<ReturnType<typeof execFile.__promisify__>> = await promisify(
            execFile,
        )(
            process.execPath,
            [
                resolve('build/nerva-connector.mjs'),
                'connector',
                'inspect-workspace',
                '--config',
                input.configurationFile,
                '--file-root',
                input.fileRootId,
                '--execution-root',
                input.executionRootId,
            ],
            { timeout: 8000, maxBuffer: 4096, env: { ...process.env, NODE_OPTIONS: '' } },
        );
        expect(result.stdout.toString()).toBe(
            JSON.stringify({
                fileRootId: input.fileRootId,
                executionRootId: input.executionRootId,
                status: WorkspaceCompatibility.Compatible,
            }) + '\n',
        );
        expect(result.stderr.toString()).toBe(
            'Inspection grants no joint Machine command capability.\n',
        );
        expect(await readdir(fixture.directory, { recursive: true })).toEqual(before);
        expect(network.connections).toBe(0);
        const stop: AbortController = new AbortController();
        stop.abort();
        expect((await WorkspaceDiagnostic.inspect(input, stop.signal)).status).toBe(
            WorkspaceCompatibility.Unavailable,
        );
    },
);
