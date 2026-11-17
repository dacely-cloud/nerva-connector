// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

import { readFile, writeFile, symlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { isBuiltin } from 'node:module';
import { rolldown, type RolldownBuild } from 'rolldown';
import { expect, it } from 'vitest';
import {
    ConnectorFileMode,
    ConnectorFileFailure,
    type ConnectorFileRead,
    type ConnectorFileWrite,
} from 'nerva-connector-protocol/protocol/ConnectorFiles.js';
import {
    ConnectorFileAction,
    ConnectorWriteMode,
} from 'nerva-connector-protocol/protocol/ConnectorFileTypes.js';
import { ConnectorFileJobsCodec } from 'nerva-connector-protocol/protocol/ConnectorFileJobsCodec.js';
import { ConnectorFilesystem } from '../src/runtime/ConnectorFilesystem.js';
import { ProtectedFiles } from '../src/local/ProtectedFiles.js';
import { ConnectorCapabilityFixture } from './support/ConnectorCapabilityFixture.js';
import { ConnectorPermissionTerminal } from './support/ConnectorPermissionTerminal.js';

it
    .skipIf(process.platform !== 'linux')
    .each([ConnectorFileMode.ReadOnly, ConnectorFileMode.ReadWrite])(
    'the actual signed-installed CLI approves %s in a real terminal and enforces native read/write boundaries',
    async (mode: ConnectorFileMode): Promise<void> => {
        await using fixture: ConnectorCapabilityFixture = await ConnectorCapabilityFixture.create();
        const directory: string = fixture.service.layout.installationDirectory;
        const keyFile: string = join(directory, 'state', 'device-key.json');
        const key: Buffer = await readFile(keyFile);
        await writeFile(join(fixture.workspace, 'proof.txt'), 'actual-cli-file');
        const outside: string = join(fixture.service.release.directory, 'outside');
        await writeFile(outside, 'not-granted');
        await symlink(outside, join(fixture.workspace, 'outside'));
        expect(
            await ConnectorPermissionTerminal.run({
                directory,
                workspace: fixture.workspace,
                mode,
                allow: true,
            }),
        ).toContain('real-terminal-local-approval-verified');
        expect(await readFile(keyFile)).toEqual(key);
        expect(await ProtectedFiles.exists(fixture.journalFile)).toBe(true);
        await using native: ConnectorFilesystem = await ConnectorFilesystem.load(
            join(directory, 'capabilities', 'files-policy.json'),
            [fixture.runtimeFile, keyFile],
        );
        expect(native.profile.mode).toBe(mode);
        const read: ConnectorFileRead = {
            action: ConnectorFileAction.Read,
            requestId: 'cli-read',
            policySha256: native.profile.policySha256,
            rootId: 'workspace',
            path: 'proof.txt',
            offset: 0n,
            limit: 128,
        };
        expect(await native.dispatch(ConnectorFileJobsCodec.encode(read))).toMatchObject({
            ok: true,
            result: { dataBase64: Buffer.from('actual-cli-file').toString('base64') },
        });
        expect(
            await native.dispatch(
                ConnectorFileJobsCodec.encode({
                    ...read,
                    path: 'outside',
                    requestId: 'cli-outside',
                }),
            ),
        ).toEqual({ ok: false, error: ConnectorFileFailure.Denied });
        const write: ConnectorFileWrite = {
            action: ConnectorFileAction.Write,
            requestId: 'cli-write',
            policySha256: native.profile.policySha256,
            rootId: 'workspace',
            path: 'written.txt',
            mode: ConnectorWriteMode.Create,
            dataBase64: Buffer.from('actual-cli-write').toString('base64'),
        };
        expect(
            await native.dispatch(ConnectorFileJobsCodec.encode(write), 'b'.repeat(64)),
        ).toMatchObject(
            mode === ConnectorFileMode.ReadOnly
                ? { ok: false, error: ConnectorFileFailure.Denied }
                : { ok: true },
        );
        if (mode === ConnectorFileMode.ReadWrite) {
            expect(await readFile(join(fixture.workspace, 'written.txt'), 'utf8')).toBe(
                'actual-cli-write',
            );
        } else {
            expect(await ProtectedFiles.exists(join(fixture.workspace, 'written.txt'))).toBe(false);
        }
    },
    45000,
);

it.skipIf(process.platform !== 'linux')(
    'the actual permission CLI refuses to grant when the final answer stays on Not now',
    async (): Promise<void> => {
        await using fixture: ConnectorCapabilityFixture = await ConnectorCapabilityFixture.create();
        const directory: string = fixture.service.layout.installationDirectory;
        const original: Buffer = await readFile(fixture.runtimeFile);
        expect(
            await ConnectorPermissionTerminal.run({
                directory,
                workspace: fixture.workspace,
                mode: ConnectorFileMode.ReadWrite,
                allow: false,
            }),
        ).toContain('real-terminal-local-approval-verified');
        expect(await readFile(fixture.runtimeFile)).toEqual(original);
        expect(await ProtectedFiles.exists(join(directory, 'permissions'))).toBe(false);
        expect(await ProtectedFiles.exists(join(directory, 'capabilities'))).toBe(false);
    },
    45000,
);

it.skipIf(process.platform !== 'linux')(
    'the actual standalone Main/TUI assembly cancels controlled preparation when Ctrl+C arrives after Allow',
    async (): Promise<void> => {
        await using fixture: ConnectorCapabilityFixture = await ConnectorCapabilityFixture.create();
        const directory: string = fixture.service.layout.installationDirectory;
        const original: Buffer = await readFile(fixture.runtimeFile);
        const entryFile: string = join(
            fixture.service.release.directory,
            'permission-cancellation-probe.mjs',
        );
        const bundle: RolldownBuild = await rolldown({
            input: resolve('test/support/ConnectorPermissionCancellationProbe.ts'),
            platform: 'node',
            external: (id: string): boolean => isBuiltin(id),
        });
        try {
            await bundle.write({
                file: entryFile,
                format: 'esm',
                codeSplitting: false,
                minify: true,
            });
        } finally {
            await bundle.close();
        }
        expect(
            await ConnectorPermissionTerminal.run({
                directory,
                workspace: fixture.workspace,
                mode: ConnectorFileMode.ReadOnly,
                allow: true,
                entryFile,
                interruptAfterApproval: true,
            }),
        ).toContain('real-terminal-local-approval-verified');
        expect(await readFile(fixture.runtimeFile)).toEqual(original);
        expect(await ProtectedFiles.exists(join(directory, 'permissions'))).toBe(false);
        expect(await ProtectedFiles.exists(join(directory, 'capabilities'))).toBe(false);
    },
    45000,
);
