// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, it, vi, type MockInstance } from 'vitest';
import { JointWorkspaceJournal } from '../src/workspace/JointWorkspaceJournal.js';
import { JointWorkspaceJournalStore } from '../src/workspace/JointWorkspaceJournalStore.js';
import type {
    JointWorkspaceJournalSnapshot,
    JointWorkspaceJournalIdentity,
} from '../src/workspace/JointWorkspaceJournalTypes.js';
import { ConnectorPrivateDirectory } from '../src/runtime/ConnectorPrivateDirectory.js';
import { JointWorkspaceWriteMethod } from './support/JointWorkspaceWriteMethod.js';
import { JointWorkspaceJournalFixture } from './support/JointWorkspaceJournalFixture.js';

it('joins an actual atomic write on cancellation and concurrent disposal before releasing installation ownership', async (): Promise<void> => {
    await using fixture: JointWorkspaceJournalFixture = await JointWorkspaceJournalFixture.create();
    await fixture.initialize();
    const entered: PromiseWithResolvers<undefined> = Promise.withResolvers<undefined>();
    const release: PromiseWithResolvers<undefined> = Promise.withResolvers<undefined>();
    const write: ConnectorPrivateDirectory['write'] = JointWorkspaceWriteMethod.directory();
    const fault: MockInstance<ConnectorPrivateDirectory['write']> = vi.spyOn(
        ConnectorPrivateDirectory.prototype,
        'write',
    );
    fault.mockImplementation(async function (
        this: ConnectorPrivateDirectory,
        name: string,
        bytes: Buffer,
        maximum: number,
        initialize: boolean,
    ): Promise<void> {
        if (name === 'workspace-head') {
            entered.resolve(undefined);
            await release.promise;
        }
        await write.call(this, name, bytes, maximum, initialize);
    });
    const journal: JointWorkspaceJournal = await fixture.open();
    const stop: AbortController = new AbortController();
    const reservation: Promise<bigint> = journal.reserveRevision(stop.signal);
    try {
        await entered.promise;
        await expect(
            journal.current('file-project', 'command-project', fixture.signal),
        ).rejects.toThrow('active operation');
        stop.abort();
        let firstClosed: boolean = false;
        let secondClosed: boolean = false;
        const first: Promise<void> = (async (): Promise<void> => {
            await journal[Symbol.asyncDispose]();
            firstClosed = true;
        })();
        const second: Promise<void> = (async (): Promise<void> => {
            await journal[Symbol.asyncDispose]();
            secondClosed = true;
        })();
        await expect(fixture.open()).rejects.toThrow();
        expect(firstClosed).toBe(false);
        expect(secondClosed).toBe(false);
        release.resolve(undefined);
        await expect(reservation).rejects.toThrow();
        await Promise.all([first, second]);
        expect(firstClosed && secondClosed).toBe(true);
    } finally {
        release.resolve(undefined);
        await Promise.allSettled([reservation]);
        await journal[Symbol.asyncDispose]();
        fault.mockRestore();
    }
    await using reopened: JointWorkspaceJournal = await fixture.open();
    expect(reopened.snapshot.revision).toBe(1n);
    expect(reopened.snapshot.reservedRevision).toBeNull();
    expect(await reopened.reserveRevision(fixture.signal)).toBe(2n);
});

it('latches uncertain durability and recovers the real committed reservation rather than continuing from stale in-memory state', async (): Promise<void> => {
    await using fixture: JointWorkspaceJournalFixture = await JointWorkspaceJournalFixture.create();
    await fixture.initialize();
    const write: JointWorkspaceJournalStore['write'] = JointWorkspaceWriteMethod.store();
    const fault: MockInstance<JointWorkspaceJournalStore['write']> = vi.spyOn(
        JointWorkspaceJournalStore.prototype,
        'write',
    );
    fault.mockImplementation(async function (
        this: JointWorkspaceJournalStore,
        snapshot: JointWorkspaceJournalSnapshot,
        initialize: boolean = false,
    ): Promise<void> {
        await write.call(this, snapshot, initialize);
        if (snapshot.reservedRevision !== null) {
            throw new Error('Owned fixture lost acknowledgment after atomic publication');
        }
    });
    try {
        await using journal: JointWorkspaceJournal = await fixture.open();
        await expect(journal.reserveRevision(fixture.signal)).rejects.toThrow('acknowledgment');
        expect(journal.failed).toBe(true);
        await expect(journal.reserveRevision(fixture.signal)).rejects.toThrow(
            'validated reopening',
        );
    } finally {
        fault.mockRestore();
    }
    await using reopened: JointWorkspaceJournal = await fixture.open();
    expect(reopened.snapshot.revision).toBe(1n);
    expect(await reopened.reserveRevision(fixture.signal)).toBe(2n);
});

it('binds both installed authority/device scope and every permanent journal without resetting authenticated state', async (): Promise<void> => {
    await using fixture: JointWorkspaceJournalFixture = await JointWorkspaceJournalFixture.create();
    await using other: JointWorkspaceJournalFixture = await JointWorkspaceJournalFixture.create();
    await fixture.initialize();
    const original: Buffer = await readFile(join(fixture.directory, 'workspace-head'));
    const identity: JointWorkspaceJournalIdentity = fixture.journalIdentity;
    const invalid: readonly JointWorkspaceJournalIdentity[] = [
        { ...identity, scope: { ...identity.scope, authorityId: 'foreign-authority' } },
        { ...identity, scope: { ...identity.scope, environmentId: 'foreign-environment' } },
        { ...identity, scope: { ...identity.scope, enrollmentId: 'conn_' + 'b'.repeat(64) } },
        {
            ...identity,
            scope: { ...identity.scope, authorityPublicKey: other.authority.publicKey },
        },
        { ...identity, fileJournalId: 'f'.repeat(64) },
        {
            ...identity,
            executionJournals: { ...identity.executionJournals, first: 'f'.repeat(64) },
        },
        {
            ...identity,
            executionJournals: { ...identity.executionJournals, second: 'f'.repeat(64) },
        },
    ];
    for (const changed of invalid) {
        await expect(
            JointWorkspaceJournal.open(fixture.directory, fixture.device, changed, fixture.signal),
        ).rejects.toThrow();
        expect(await readFile(join(fixture.directory, 'workspace-head'))).toEqual(original);
    }
    await expect(
        JointWorkspaceJournal.open(fixture.directory, other.device, identity, fixture.signal),
    ).rejects.toThrow('identity');
    await using journal: JointWorkspaceJournal = await fixture.open();
    expect(journal.snapshot.revision).toBe(0n);
});

it('never creates default state on corrupted encrypted input or an already canceled startup', async (): Promise<void> => {
    await using fixture: JointWorkspaceJournalFixture = await JointWorkspaceJournalFixture.create();
    await fixture.initialize();
    const original: Buffer = await readFile(join(fixture.directory, 'workspace-head'));
    const corrupt: Buffer = Buffer.from('{"nonce":"invalid"}');
    await writeFile(join(fixture.directory, 'workspace-head'), corrupt, { mode: 0o600 });
    await expect(fixture.open()).rejects.toThrow();
    expect(await readFile(join(fixture.directory, 'workspace-head'))).toEqual(corrupt);
    await writeFile(join(fixture.directory, 'workspace-head'), original, { mode: 0o600 });
    const stop: AbortController = new AbortController();
    stop.abort();
    await expect(fixture.open(stop.signal)).rejects.toThrow();
    expect(await readFile(join(fixture.directory, 'workspace-head'))).toEqual(original);
    await using journal: JointWorkspaceJournal = await fixture.open();
    expect(journal.snapshot.revision).toBe(0n);
});
