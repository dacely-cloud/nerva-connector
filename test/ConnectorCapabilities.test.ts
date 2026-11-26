// SPDX-FileCopyrightText: 2026 Dacely <business@dacely.com>
// SPDX-License-Identifier: LicenseRef-Proprietary

import { expect, it, vi, type MockInstance } from 'vitest';
import { readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { ConnectorCapabilityFixture } from './support/ConnectorCapabilityFixture.js';
import {
    ConnectorCapabilityInstallation,
    type ConnectorCapabilityInstallationResult,
} from '../src/install/ConnectorCapabilityInstallation.js';
import {
    ConnectorCapabilityPhase,
    ConnectorCapabilityState,
    type ConnectorCapabilityRecord,
} from '../src/install/ConnectorCapabilityState.js';
import { ConnectorClient } from '../src/runtime/ConnectorClient.js';
import { ConnectorPrivateDirectory } from '../src/runtime/ConnectorPrivateDirectory.js';
import { ConnectorFilesystem } from '../src/runtime/ConnectorFilesystem.js';
import {
    ConnectorFileAction,
    ConnectorWriteMode,
} from 'nerva-connector-protocol/protocol/ConnectorFileTypes.js';

/** A lost observer may precede or follow actual atomic configuration publication. */
enum CapabilityPublicationLoss {
    Before = 'before',
    After = 'after',
}

it('explicit local setup enables only the approved signed native file policy, preserves original identity/history on repeat and excludes live runtimes', async (): Promise<void> => {
    await using fixture: ConnectorCapabilityFixture = await ConnectorCapabilityFixture.create();
    const keyFile: string = join(
        fixture.service.layout.installationDirectory,
        'state',
        'device-key.json',
    );
    const key: Buffer = await readFile(keyFile);
    const result: ConnectorCapabilityInstallationResult =
        await ConnectorCapabilityInstallation.install(
            fixture.requestFile,
            new AbortController().signal,
        );
    expect(result).toMatchObject({
        phase: ConnectorCapabilityPhase.Active,
        files: true,
        execution: false,
    });
    const journal: Buffer = await readFile(fixture.journalFile);
    expect(
        await ConnectorCapabilityInstallation.install(
            fixture.requestFile,
            new AbortController().signal,
        ),
    ).toEqual(result);
    expect(await readFile(fixture.journalFile)).toEqual(journal);
    expect(await readFile(keyFile)).toEqual(key);
    await using client: ConnectorClient = await ConnectorClient.load(
        fixture.runtimeFile,
        (): void => {},
    );
    expect(client.identity.configurationFile).toBe(fixture.runtimeFile);
    await expect(
        ConnectorCapabilityInstallation.install(fixture.requestFile, new AbortController().signal),
    ).rejects.toThrow();
    expect(await readFile(fixture.journalFile)).toEqual(journal);
    const policyFile: string = join(
        fixture.service.layout.installationDirectory,
        'capabilities',
        'files-policy.json',
    );
    await using files: ConnectorFilesystem = await ConnectorFilesystem.load(policyFile, [
        fixture.runtimeFile,
    ]);
    const requestId: string = crypto.randomUUID();
    const response: Awaited<ReturnType<ConnectorFilesystem['dispatch']>> = await files.dispatch(
        JSON.stringify({
            action: ConnectorFileAction.Write,
            requestId,
            policySha256: files.profile.policySha256,
            rootId: 'project',
            path: 'created.txt',
            mode: ConnectorWriteMode.Create,
            dataBase64: Buffer.from('approved-local-setup').toString('base64'),
        }),
        'a'.repeat(64),
    );
    expect(response).toMatchObject({
        ok: true,
        result: { action: ConnectorFileAction.Write, requestId, metadata: { sizeBytes: 20n } },
    });
    expect(await readFile(join(fixture.workspace, 'created.txt'), 'utf8')).toBe(
        'approved-local-setup',
    );
});

it('a changed grant cannot replace the original intent and missing active history cannot become a fresh journal', async (): Promise<void> => {
    await using fixture: ConnectorCapabilityFixture = await ConnectorCapabilityFixture.create();
    await ConnectorCapabilityInstallation.install(
        fixture.requestFile,
        new AbortController().signal,
    );
    const original: Buffer = await readFile(fixture.policyFile);
    await writeFile(
        fixture.policyFile,
        original.toString('utf8').replace('"revision":"1"', '"revision":"2"'),
    );
    const configuration: Buffer = await readFile(fixture.runtimeFile);
    await expect(
        ConnectorCapabilityInstallation.install(fixture.requestFile, new AbortController().signal),
    ).rejects.toThrow('original intent');
    expect(await readFile(fixture.runtimeFile)).toEqual(configuration);
    await writeFile(fixture.policyFile, original);
    await rm(fixture.journalFile);
    await expect(
        ConnectorCapabilityInstallation.install(fixture.requestFile, new AbortController().signal),
    ).rejects.toThrow();
    await expect(readFile(fixture.journalFile)).rejects.toThrow();
    expect(await readFile(fixture.runtimeFile)).toEqual(configuration);
});

it.each(Object.values(CapabilityPublicationLoss))(
    'lost %s-publication acknowledgement resumes the same prepared journals without broadening or resetting access',
    async (loss: CapabilityPublicationLoss): Promise<void> => {
        await using fixture: ConnectorCapabilityFixture = await ConnectorCapabilityFixture.create();
        const original: typeof ConnectorCapabilityState.write =
            ConnectorCapabilityState.write.bind(ConnectorCapabilityState);
        const spy: MockInstance<typeof ConnectorCapabilityState.write> = vi.spyOn(
            ConnectorCapabilityState,
            'write',
        );
        spy.mockImplementation(
            async (
                owner: ConnectorPrivateDirectory,
                record: ConnectorCapabilityRecord,
                initialize: boolean,
            ): Promise<void> => {
                if (
                    record.phase === ConnectorCapabilityPhase.Active &&
                    loss === CapabilityPublicationLoss.After
                ) {
                    throw new Error('Controlled publication observation loss');
                }
                await original(owner, record, initialize);
                if (
                    record.phase === ConnectorCapabilityPhase.Prepared &&
                    loss === CapabilityPublicationLoss.Before
                ) {
                    throw new Error('Controlled publication observation loss');
                }
            },
        );
        try {
            await expect(
                ConnectorCapabilityInstallation.install(
                    fixture.requestFile,
                    new AbortController().signal,
                ),
            ).rejects.toThrow('observation loss');
        } finally {
            spy.mockRestore();
        }
        const journal: Buffer = await readFile(fixture.journalFile);
        expect(
            (
                await ConnectorCapabilityInstallation.install(
                    fixture.requestFile,
                    new AbortController().signal,
                )
            ).phase,
        ).toBe(ConnectorCapabilityPhase.Active);
        expect(await readFile(fixture.journalFile)).toEqual(journal);
    },
);

it('policy roots cannot expose the installation, setup request or signing identity; preflight leaves access disabled', async (): Promise<void> => {
    await using fixture: ConnectorCapabilityFixture = await ConnectorCapabilityFixture.create();
    const original: Buffer = await readFile(fixture.runtimeFile);
    const raw: unknown = JSON.parse(await readFile(fixture.policyFile, 'utf8'));
    if (typeof raw !== 'object' || raw === null) {
        throw new Error('Fixture policy missing');
    }
    Reflect.set(raw, 'roots', [
        {
            id: 'host',
            path: fixture.service.release.directory,
            stagingPath: join(fixture.service.release.directory, 'staging'),
        },
    ]);
    await writeFile(fixture.policyFile, JSON.stringify(raw));
    await expect(
        ConnectorCapabilityInstallation.install(fixture.requestFile, new AbortController().signal),
    ).rejects.toThrow();
    expect(await readFile(fixture.runtimeFile)).toEqual(original);
    await expect(
        readFile(join(fixture.service.layout.installationDirectory, 'capabilities', 'intent.json')),
    ).rejects.toThrow();
});

it('malformed UTF-8 cannot alias an existing replacement-character policy path and enable its permissions', async (): Promise<void> => {
    await using fixture: ConnectorCapabilityFixture = await ConnectorCapabilityFixture.create();
    const shadow: string = join(fixture.service.release.directory, '\ufffd-policy.json');
    await writeFile(shadow, await readFile(fixture.policyFile), { mode: 0o600 });
    const bytes: Buffer = Buffer.from(
        JSON.stringify({
            installationDirectory: fixture.service.layout.installationDirectory,
            filesPolicyFile: shadow,
            executionPolicyFile: null,
        }),
    );
    const index: number = bytes.indexOf(Buffer.from('\ufffd'));
    expect(index).toBeGreaterThan(0);
    await writeFile(
        fixture.requestFile,
        Buffer.concat([bytes.subarray(0, index), Buffer.from([255]), bytes.subarray(index + 3)]),
    );
    const original: Buffer = await readFile(fixture.runtimeFile);
    await expect(
        ConnectorCapabilityInstallation.install(fixture.requestFile, new AbortController().signal),
    ).rejects.toThrow(/encoding/i);
    expect(await readFile(fixture.runtimeFile)).toEqual(original);
});
