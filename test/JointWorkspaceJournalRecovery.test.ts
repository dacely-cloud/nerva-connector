// SPDX-FileCopyrightText: 2026 Dacely <business@dacely.com>
// SPDX-License-Identifier: LicenseRef-Proprietary

import { readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, it, vi, type MockInstance } from 'vitest';
import type { JointWorkspaceDescriptor } from 'nerva-connector-protocol/workspace/JointWorkspaceBinding.js';
import { JointWorkspaceProof } from 'nerva-connector-protocol/workspace/JointWorkspaceProof.js';
import { JointWorkspaceJournal } from '../src/workspace/JointWorkspaceJournal.js';
import { JointWorkspaceJournalContext } from '../src/workspace/JointWorkspaceJournalContext.js';
import { JointWorkspaceJournalStore } from '../src/workspace/JointWorkspaceJournalStore.js';
import {
    JointWorkspaceJournalLimits,
    type JointWorkspaceJournalSnapshot,
    type JointWorkspaceJournalReference,
} from '../src/workspace/JointWorkspaceJournalTypes.js';
import { JointWorkspaceWriteMethod } from './support/JointWorkspaceWriteMethod.js';
import { JointWorkspaceJournalFixture } from './support/JointWorkspaceJournalFixture.js';

it('consumes a durable reservation without an archive and never reuses that revision after reopening', async (): Promise<void> => {
    await using fixture: JointWorkspaceJournalFixture = await JointWorkspaceJournalFixture.create();
    await fixture.initialize();
    {
        await using journal: JointWorkspaceJournal = await fixture.open();
        expect(await journal.reserveRevision(fixture.signal)).toBe(1n);
    }
    await using reopened: JointWorkspaceJournal = await fixture.open();
    expect(reopened.snapshot.revision).toBe(1n);
    expect(reopened.snapshot.reservedRevision).toBeNull();
    expect(reopened.snapshot.references).toEqual([]);
    expect(await reopened.reserveRevision(fixture.signal)).toBe(2n);
});

it('recovers a real immutable archive published before a failed head finalization without rewriting its proof or ciphertext', async (): Promise<void> => {
    await using fixture: JointWorkspaceJournalFixture = await JointWorkspaceJournalFixture.create();
    await fixture.initialize();
    const descriptor: JointWorkspaceDescriptor = fixture.signed(1n);
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
        if (snapshot.references.length === 1) {
            throw new Error('Owned fixture interrupted head finalization');
        }
        await write.call(this, snapshot, initialize);
    });
    try {
        await using journal: JointWorkspaceJournal = await fixture.open();
        await journal.reserveRevision(fixture.signal);
        await expect(journal.retain(descriptor, fixture.signal)).rejects.toThrow('finalization');
        expect(journal.failed).toBe(true);
    } finally {
        fault.mockRestore();
    }
    const bytes: Buffer = await readFile(join(fixture.directory, 'workspace-binding-1'));
    await using reopened: JointWorkspaceJournal = await fixture.open();
    expect(reopened.snapshot.reservedRevision).toBeNull();
    expect(await reopened.current('file-project', 'command-project', fixture.signal)).toEqual(
        descriptor,
    );
    expect(await readFile(join(fixture.directory, 'workspace-binding-1'))).toEqual(bytes);
    expect(await reopened.reserveRevision(fixture.signal)).toBe(2n);
});

it('retains a stranded signed archive partial and original reservation rather than deleting or reusing either', async (): Promise<void> => {
    await using fixture: JointWorkspaceJournalFixture = await JointWorkspaceJournalFixture.create();
    await fixture.initialize();
    {
        await using journal: JointWorkspaceJournal = await fixture.open();
        await journal.reserveRevision(fixture.signal);
    }
    const context: JointWorkspaceJournalContext = new JointWorkspaceJournalContext(
        fixture.journalIdentity,
        fixture.device,
    );
    {
        await using store: JointWorkspaceJournalStore = await JointWorkspaceJournalStore.open(
            fixture.directory,
            fixture.device,
            context,
        );
        await store.retain(fixture.signed(1n));
    }
    await rename(
        join(fixture.directory, 'workspace-binding-1'),
        join(fixture.directory, 'workspace-binding-1.partial'),
    );
    const head: Buffer = await readFile(join(fixture.directory, 'workspace-head'));
    const partial: Buffer = await readFile(join(fixture.directory, 'workspace-binding-1.partial'));
    await expect(fixture.open()).rejects.toThrow('retained partial');
    expect(await readFile(join(fixture.directory, 'workspace-head'))).toEqual(head);
    expect(await readFile(join(fixture.directory, 'workspace-binding-1.partial'))).toEqual(partial);
});

it('refuses missing-head reinitialization when immutable originals remain and preserves all surviving bytes', async (): Promise<void> => {
    await using fixture: JointWorkspaceJournalFixture = await JointWorkspaceJournalFixture.create();
    await fixture.initialize();
    {
        await using journal: JointWorkspaceJournal = await fixture.open();
        await journal.retain(
            fixture.signed(await journal.reserveRevision(fixture.signal)),
            fixture.signal,
        );
    }
    const archive: Buffer = await readFile(join(fixture.directory, 'workspace-binding-1'));
    await unlink(join(fixture.directory, 'workspace-head'));
    await expect(fixture.open()).rejects.toThrow();
    await expect(fixture.initialize()).rejects.toThrow('original history');
    expect(await readFile(join(fixture.directory, 'workspace-binding-1'))).toEqual(archive);
});

it('supports bounded4096-slot head metadata and retained exact retries at quota without weakening immutable archive checks', async (): Promise<void> => {
    await using fixture: JointWorkspaceJournalFixture = await JointWorkspaceJournalFixture.create();
    await fixture.initialize();
    let descriptor: JointWorkspaceDescriptor;
    {
        await using journal: JointWorkspaceJournal = await fixture.open();
        descriptor = await journal.retain(
            fixture.signed(await journal.reserveRevision(fixture.signal)),
            fixture.signal,
        );
    }
    const context: JointWorkspaceJournalContext = new JointWorkspaceJournalContext(
        fixture.journalIdentity,
        fixture.device,
    );
    {
        await using store: JointWorkspaceJournalStore = await JointWorkspaceJournalStore.open(
            fixture.directory,
            fixture.device,
            context,
        );
        const original: JointWorkspaceJournalSnapshot = await store.read();
        // This metadata cohort represents4095 consumed reservations, not4096 physical archive files.
        await store.write({ ...original, revision: BigInt(JointWorkspaceJournalLimits.revisions) });
    }
    {
        await using journal: JointWorkspaceJournal = await fixture.open();
        await expect(journal.reserveRevision(fixture.signal)).rejects.toThrow('quota');
        expect(
            await journal.retain(
                JointWorkspaceProof.sign(fixture.device, descriptor.binding),
                fixture.signal,
            ),
        ).toEqual(descriptor);
        expect(journal.failed).toBe(false);
    }
    {
        await using store: JointWorkspaceJournalStore = await JointWorkspaceJournalStore.open(
            fixture.directory,
            fixture.device,
            context,
        );
        const original: JointWorkspaceJournalSnapshot = await store.read();
        const references: readonly JointWorkspaceJournalReference[] = Array.from(
            new Array<number>(JointWorkspaceJournalLimits.revisions).fill(0),
            (_value: number, index: number): JointWorkspaceJournalReference => ({
                revision: BigInt(index + 1),
                bindingSha256: 'a'.repeat(64),
            }),
        );
        // Isolated authenticated-format capacity proof only; those additional metadata refs are not opened as archives.
        await store.write({ ...original, references, pairs: [], accepted: null, pending: null });
        expect((await store.read()).references).toHaveLength(4096);
        expect((await readFile(join(fixture.directory, 'workspace-head'))).byteLength).toBeLessThan(
            JointWorkspaceJournalLimits.headRecordBytes,
        );
    }
});

it('fails closed on encrypted archive tamper and never overwrites the original head or replays a capture', async (): Promise<void> => {
    await using fixture: JointWorkspaceJournalFixture = await JointWorkspaceJournalFixture.create();
    await fixture.initialize();
    {
        await using journal: JointWorkspaceJournal = await fixture.open();
        await journal.retain(
            fixture.signed(await journal.reserveRevision(fixture.signal)),
            fixture.signal,
        );
    }
    const head: Buffer = await readFile(join(fixture.directory, 'workspace-head'));
    await writeFile(join(fixture.directory, 'workspace-binding-1'), '{"nonce":"bad"}', {
        mode: 0o600,
    });
    await using journal: JointWorkspaceJournal = await fixture.open();
    await expect(
        journal.current('file-project', 'command-project', fixture.signal),
    ).rejects.toThrow();
    expect(journal.failed).toBe(true);
    await expect(journal.reserveRevision(fixture.signal)).rejects.toThrow('validated reopening');
    expect(await readFile(join(fixture.directory, 'workspace-head'))).toEqual(head);
});
