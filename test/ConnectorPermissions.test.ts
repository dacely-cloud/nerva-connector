// SPDX-FileCopyrightText: 2026 Dacely <business@dacely.com>
// SPDX-License-Identifier: LicenseRef-Proprietary

import { readFile, readdir, writeFile, symlink, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, it, vi, type MockInstance } from 'vitest';
import { ConnectorFileJobsCodec } from 'nerva-connector-protocol/protocol/ConnectorFileJobsCodec.js';
import type {
    ConnectorFileRead,
    ConnectorFileWrite,
} from 'nerva-connector-protocol/protocol/ConnectorFiles.js';
import {
    ConnectorCapabilityInstallation,
    type ConnectorCapabilityInstallationResult,
} from '../src/install/ConnectorCapabilityInstallation.js';
import {
    ConnectorPermissionWizard,
    ConnectorPermissionOutcome,
    type ConnectorPermissionResult,
} from '../src/cli/ConnectorPermissionWizard.js';
import { ConnectorPromptFixture } from './support/ConnectorPromptFixture.js';
import {
    ConnectorFileGrant,
    type ConnectorFileGrantContext,
    type ConnectorFileApproval,
} from '../src/permissions/ConnectorFileGrant.js';
import {
    ConnectorFileMode,
    ConnectorFileFailure,
} from 'nerva-connector-protocol/protocol/ConnectorFiles.js';
import {
    ConnectorFileAction,
    ConnectorWriteMode,
} from 'nerva-connector-protocol/protocol/ConnectorFileTypes.js';
import {
    ConnectorClientConfiguration,
    type ConnectorClientIdentity,
} from '../src/runtime/ConnectorClientConfiguration.js';
import { ConnectorFilesystem } from '../src/runtime/ConnectorFilesystem.js';
import {
    ConnectorPrivateDirectory,
    ConnectorDirectoryPurpose,
} from '../src/runtime/ConnectorPrivateDirectory.js';
import { ProtectedFiles } from '../src/local/ProtectedFiles.js';
import { ConnectorCapabilityFixture } from './support/ConnectorCapabilityFixture.js';
import { ConnectorApproval } from '../src/cli/ConnectorPromptTypes.js';

it('keeping the default Not now creates no approval, staging, policy, history or runtime grant', async (): Promise<void> => {
    await using fixture: ConnectorCapabilityFixture = await ConnectorCapabilityFixture.create();
    const directory: string = fixture.service.layout.installationDirectory;
    const original: Buffer = await readFile(fixture.runtimeFile);
    const before: readonly string[] = (await readdir(fixture.service.release.directory)).sort();
    const questions: ConnectorPromptFixture = new ConnectorPromptFixture([
        fixture.workspace,
        ConnectorFileMode.ReadWrite,
        '',
    ]);
    let stopped: boolean = false;
    const result: ConnectorPermissionResult = await ConnectorPermissionWizard.run(
        directory,
        questions,
        AbortSignal.timeout(10000),
        (): Promise<void> => {
            stopped = true;
            return Promise.resolve();
        },
    );
    expect(result.outcome).toBe(ConnectorPermissionOutcome.Canceled);
    expect(stopped).toBe(false);
    expect(await readFile(fixture.runtimeFile)).toEqual(original);
    expect(await ProtectedFiles.exists(join(directory, 'permissions'))).toBe(false);
    expect(await ProtectedFiles.exists(join(directory, 'capabilities'))).toBe(false);
    expect((await readdir(fixture.service.release.directory)).sort()).toEqual(before);
    expect(questions.output).toContain('Folder: ' + fixture.workspace);
    expect(questions.output).toContain('Access: Read and change');
    expect(questions.selections.at(-1)?.initialValue).toBe(ConnectorApproval.NotNow);
});

it.each([ConnectorFileMode.ReadOnly, ConnectorFileMode.ReadWrite])(
    'explicit local %s approval activates real signed helper access, refuses outside reads, and preserves original history on exact repeat',
    async (mode: ConnectorFileMode): Promise<void> => {
        await using fixture: ConnectorCapabilityFixture = await ConnectorCapabilityFixture.create();
        const directory: string = fixture.service.layout.installationDirectory;
        const keyFile: string = join(directory, 'state', 'device-key.json');
        const key: Buffer = await readFile(keyFile);
        await writeFile(join(fixture.workspace, 'proof.txt'), 'native-approved');
        const outside: string = join(fixture.service.release.directory, 'outside-secret');
        await writeFile(outside, 'must-not-read');
        await symlink(outside, join(fixture.workspace, 'outside'));
        const questions: ConnectorPromptFixture = new ConnectorPromptFixture([
            fixture.workspace,
            mode,
            ConnectorApproval.Allow,
        ]);
        expect(
            (await ConnectorPermissionWizard.run(directory, questions, AbortSignal.timeout(10000)))
                .outcome,
        ).toBe(ConnectorPermissionOutcome.Installed);
        const journal: Buffer = await readFile(fixture.journalFile);
        await using files: ConnectorFilesystem = await ConnectorFilesystem.load(
            join(directory, 'capabilities', 'files-policy.json'),
            [fixture.runtimeFile, keyFile],
        );
        expect(files.profile.mode).toBe(mode);
        const read: ConnectorFileRead = {
            action: ConnectorFileAction.Read,
            requestId: 'read',
            policySha256: files.profile.policySha256,
            rootId: 'workspace',
            path: 'proof.txt',
            offset: 0n,
            limit: 1024,
        };
        expect(await files.dispatch(ConnectorFileJobsCodec.encode(read))).toMatchObject({
            ok: true,
            result: { dataBase64: Buffer.from('native-approved').toString('base64') },
        });
        expect(
            await files.dispatch(
                ConnectorFileJobsCodec.encode({ ...read, requestId: 'outside', path: 'outside' }),
            ),
        ).toEqual({ ok: false, error: ConnectorFileFailure.Denied });
        const write: ConnectorFileWrite = {
            action: ConnectorFileAction.Write,
            requestId: 'write',
            policySha256: files.profile.policySha256,
            rootId: 'workspace',
            path: 'created.txt',
            mode: ConnectorWriteMode.Create,
            dataBase64: Buffer.from('native-write').toString('base64'),
        };
        expect(
            await files.dispatch(ConnectorFileJobsCodec.encode(write), 'a'.repeat(64)),
        ).toMatchObject(
            mode === ConnectorFileMode.ReadOnly
                ? { ok: false, error: ConnectorFileFailure.Denied }
                : { ok: true },
        );
        if (mode === ConnectorFileMode.ReadWrite) {
            expect(await readFile(join(fixture.workspace, 'created.txt'), 'utf8')).toBe(
                'native-write',
            );
        } else {
            expect(await ProtectedFiles.exists(join(fixture.workspace, 'created.txt'))).toBe(false);
        }
        const repeat: ConnectorPromptFixture = new ConnectorPromptFixture([
            ConnectorApproval.Allow,
        ]);
        expect(
            (await ConnectorPermissionWizard.run(directory, repeat, AbortSignal.timeout(10000)))
                .outcome,
        ).toBe(ConnectorPermissionOutcome.Installed);
        expect(repeat.texts).toHaveLength(0);
        expect(repeat.selections).toHaveLength(1);
        expect(await readFile(fixture.journalFile)).toEqual(journal);
        expect(await readFile(keyFile)).toEqual(key);
        const context: ConnectorFileGrantContext = await ConnectorFileGrant.inspect(
            directory,
            AbortSignal.timeout(10000),
        );
        await expect(
            ConnectorFileGrant.review(
                context,
                fixture.workspace,
                mode === ConnectorFileMode.ReadOnly
                    ? ConnectorFileMode.ReadWrite
                    : ConnectorFileMode.ReadOnly,
            ),
        ).rejects.toThrow('original approval changed');
        await rm(fixture.journalFile);
        expect(
            (
                await ConnectorPermissionWizard.run(
                    directory,
                    new ConnectorPromptFixture([ConnectorApproval.Allow]),
                    AbortSignal.timeout(10000),
                )
            ).outcome,
        ).toBe(ConnectorPermissionOutcome.Unavailable);
        expect(await ProtectedFiles.exists(fixture.journalFile)).toBe(false);
    },
);

it('a live runtime prevents activation; retry joins the original approval after that owner stops', async (): Promise<void> => {
    await using fixture: ConnectorCapabilityFixture = await ConnectorCapabilityFixture.create();
    const directory: string = fixture.service.layout.installationDirectory;
    const original: Buffer = await readFile(fixture.runtimeFile);
    {
        await using runtime: ConnectorPrivateDirectory = await ConnectorPrivateDirectory.open(
            join(directory, 'state'),
            ConnectorDirectoryPurpose.Runtime,
        );
        expect(runtime.directory).toBe(join(directory, 'state'));
        const result: ConnectorPermissionResult = await ConnectorPermissionWizard.run(
            directory,
            new ConnectorPromptFixture([
                fixture.workspace,
                ConnectorFileMode.ReadOnly,
                ConnectorApproval.Allow,
            ]),
            AbortSignal.timeout(10000),
        );
        expect(result.outcome).toBe(ConnectorPermissionOutcome.Unavailable);
        expect(await readFile(fixture.runtimeFile)).toEqual(original);
    }
    const repeated: ConnectorPromptFixture = new ConnectorPromptFixture([ConnectorApproval.Allow]);
    expect(
        (await ConnectorPermissionWizard.run(directory, repeated, AbortSignal.timeout(10000)))
            .outcome,
    ).toBe(ConnectorPermissionOutcome.Installed);
    expect(repeated.texts).toHaveLength(0);
    expect(repeated.selections).toHaveLength(1);
});

it('an installation path cannot become a file root, and unverified source bootstrap gets an actionable prerequisite without writes', async (): Promise<void> => {
    await using fixture: ConnectorCapabilityFixture = await ConnectorCapabilityFixture.create();
    const directory: string = fixture.service.layout.installationDirectory;
    const context: ConnectorFileGrantContext = await ConnectorFileGrant.inspect(
        directory,
        AbortSignal.timeout(10000),
    );
    for (const root of [directory, join(directory, 'state'), fixture.service.release.directory]) {
        await expect(
            ConnectorFileGrant.review(context, root, ConnectorFileMode.ReadOnly),
        ).rejects.toThrow('outside the connector installation');
    }
    const result: ConnectorPermissionResult = await ConnectorPermissionWizard.run(
        fixture.workspace,
        new ConnectorPromptFixture([]),
        AbortSignal.timeout(10000),
    );
    expect(result.outcome).toBe(ConnectorPermissionOutcome.Unavailable);
    expect(result.message).toContain('verified signed Linux installation');
    expect(await readdir(fixture.workspace)).toEqual([]);
});

it('lost setup acknowledgment after publication retains the approved original and never claims cancellation granted nothing', async (): Promise<void> => {
    await using fixture: ConnectorCapabilityFixture = await ConnectorCapabilityFixture.create();
    const directory: string = fixture.service.layout.installationDirectory;
    const stop: AbortController = new AbortController();
    const install: typeof ConnectorCapabilityInstallation.install =
        ConnectorCapabilityInstallation.install.bind(ConnectorCapabilityInstallation);
    const spy: MockInstance<typeof ConnectorCapabilityInstallation.install> = vi
        .spyOn(ConnectorCapabilityInstallation, 'install')
        .mockImplementation(
            async (
                path: string,
                signal: AbortSignal,
            ): Promise<ConnectorCapabilityInstallationResult> => {
                await install(path, signal);
                stop.abort();
                throw new Error('Lost local setup acknowledgment');
            },
        );
    try {
        const result: ConnectorPermissionResult = await ConnectorPermissionWizard.run(
            directory,
            new ConnectorPromptFixture([
                fixture.workspace,
                ConnectorFileMode.ReadOnly,
                ConnectorApproval.Allow,
            ]),
            stop.signal,
        );
        expect(result.outcome).toBe(ConnectorPermissionOutcome.Unavailable);
        expect(result.message).toContain('it may already be on');
        expect(result.message).toContain('Try again with the same folder and access');
        expect(await ProtectedFiles.exists(join(directory, 'permissions', 'approval.json'))).toBe(
            true,
        );
        expect(result.message).not.toContain("wasn't changed");
        expect(await ProtectedFiles.exists(fixture.journalFile)).toBe(true);
    } finally {
        spy.mockRestore();
    }
    const journal: Buffer = await readFile(fixture.journalFile);
    expect(
        (
            await ConnectorPermissionWizard.run(
                directory,
                new ConnectorPromptFixture([ConnectorApproval.Allow]),
                AbortSignal.timeout(10000),
            )
        ).outcome,
    ).toBe(ConnectorPermissionOutcome.Installed);
    expect(await readFile(fixture.journalFile)).toEqual(journal);
});

it('unregistered local setup content cannot be adopted or overwritten by the convenience flow', async (): Promise<void> => {
    await using fixture: ConnectorCapabilityFixture = await ConnectorCapabilityFixture.create();
    const directory: string = fixture.service.layout.installationDirectory;
    const permissions: string = join(directory, 'permissions');
    await ProtectedFiles.createDirectory(permissions);
    const unrelated: string = join(permissions, 'unrelated');
    await writeFile(unrelated, 'keep-original', { mode: 0o600 });
    const original: Buffer = await readFile(fixture.runtimeFile);
    expect(
        (
            await ConnectorPermissionWizard.run(
                directory,
                new ConnectorPromptFixture([
                    fixture.workspace,
                    ConnectorFileMode.ReadOnly,
                    ConnectorApproval.Allow,
                ]),
                AbortSignal.timeout(10000),
            )
        ).outcome,
    ).toBe(ConnectorPermissionOutcome.Unavailable);
    expect(await readFile(unrelated, 'utf8')).toBe('keep-original');
    expect(await ProtectedFiles.exists(join(permissions, 'approval.json'))).toBe(false);
    expect(await readFile(fixture.runtimeFile)).toEqual(original);
});

it('a preexisting unrelated native grant is kept and never replaced by a new friendly policy', async (): Promise<void> => {
    await using fixture: ConnectorCapabilityFixture = await ConnectorCapabilityFixture.create();
    const directory: string = fixture.service.layout.installationDirectory;
    await ConnectorCapabilityInstallation.install(fixture.requestFile, AbortSignal.timeout(10000));
    const original: Buffer = await readFile(fixture.runtimeFile);
    const journal: Buffer = await readFile(fixture.journalFile);
    const questions: ConnectorPromptFixture = new ConnectorPromptFixture([]);
    const result: ConnectorPermissionResult = await ConnectorPermissionWizard.run(
        directory,
        questions,
        AbortSignal.timeout(10000),
    );
    expect(result.outcome).toBe(ConnectorPermissionOutcome.Unavailable);
    expect(result.message).toContain('Editing these grants is not available');
    expect(questions.texts).toEqual([]);
    expect(await readFile(fixture.runtimeFile)).toEqual(original);
    expect(await readFile(fixture.journalFile)).toEqual(journal);
});

it('changing the captured account/environment binding during local review refuses approval before any grant writes', async (): Promise<void> => {
    await using fixture: ConnectorCapabilityFixture = await ConnectorCapabilityFixture.create();
    const directory: string = fixture.service.layout.installationDirectory;
    const context: ConnectorFileGrantContext = await ConnectorFileGrant.inspect(
        directory,
        AbortSignal.timeout(10000),
    );
    const approval: ConnectorFileApproval = await ConnectorFileGrant.review(
        context,
        fixture.workspace,
        ConnectorFileMode.ReadOnly,
    );
    const original: Buffer = await readFile(fixture.runtimeFile);
    const runtime: ConnectorClientIdentity = await ConnectorClientConfiguration.load(
        fixture.runtimeFile,
    );
    using keys: DisposableStack = new DisposableStack();
    keys.use(runtime.key);
    try {
        await writeFile(
            fixture.runtimeFile,
            JSON.stringify({ ...runtime.settings, environmentId: 'reassigned-environment' }),
            { mode: 0o600 },
        );
        await expect(
            ConnectorFileGrant.approve(context, approval, AbortSignal.timeout(10000)),
        ).rejects.toThrow('original approval changed');
        expect(await ProtectedFiles.exists(join(directory, 'permissions'))).toBe(false);
        expect(await ProtectedFiles.exists(join(directory, 'capabilities'))).toBe(false);
    } finally {
        await writeFile(fixture.runtimeFile, original, { mode: 0o600 });
    }
});
