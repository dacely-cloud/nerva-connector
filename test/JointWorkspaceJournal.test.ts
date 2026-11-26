// SPDX-FileCopyrightText: 2026 Dacely <business@dacely.com>
// SPDX-License-Identifier: LicenseRef-Proprietary

import { readFile, stat, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import type { JointWorkspaceDescriptor } from 'nerva-connector-protocol/workspace/JointWorkspaceBinding.js';
import { JointWorkspaceProof } from 'nerva-connector-protocol/workspace/JointWorkspaceProof.js';
import { ConnectorFileMode } from 'nerva-connector-protocol/protocol/ConnectorFiles.js';
import { JointWorkspaceJournal } from '../src/workspace/JointWorkspaceJournal.js';
import type { JointWorkspacePublication } from 'nerva-connector-protocol/workspace/JointWorkspacePublication.js';
import type { JointWorkspaceReceipt } from 'nerva-connector-protocol/workspace/JointWorkspaceReceipt.js';
import { JointWorkspaceJournalFixture } from './support/JointWorkspaceJournalFixture.js';

it('requires explicit initialization, forbids overwrite and takes an exclusive actual installation lock', async (): Promise<void> => {
    await using fixture: JointWorkspaceJournalFixture = await JointWorkspaceJournalFixture.create();
    await expect(fixture.open()).rejects.toThrow();
    expect(await readdir(fixture.directory)).toEqual([]);
    await fixture.initialize();
    const before: Buffer = await readFile(join(fixture.directory, 'workspace-head'));
    await expect(fixture.initialize()).rejects.toThrow();
    expect(await readFile(join(fixture.directory, 'workspace-head'))).toEqual(before);
    await using journal: JointWorkspaceJournal = await fixture.open();
    await expect(fixture.open()).rejects.toThrow();
    expect(journal.snapshot.revision).toBe(0n);
    expect(journal.pending).toBeNull();
    expect((await stat(join(fixture.directory, 'workspace-head'))).mode & 0o777).toBe(0o600);
});

it('durably reserves before capture, permanently retains originals and maps each exact alias pair independently', async (): Promise<void> => {
    await using fixture: JointWorkspaceJournalFixture = await JointWorkspaceJournalFixture.create();
    await fixture.initialize();
    let first: JointWorkspaceDescriptor;
    {
        await using journal: JointWorkspaceJournal = await fixture.open();
        const revision: bigint = await journal.reserveRevision(fixture.signal);
        expect(revision).toBe(1n);
        await expect(journal.reserveRevision(fixture.signal)).rejects.toThrow('pending');
        first = await journal.retain(fixture.signed(revision), fixture.signal);
        const archive: Buffer = await readFile(join(fixture.directory, 'workspace-binding-1'));
        expect(archive.includes(Buffer.from(first.signature))).toBe(false);
        const resigned: JointWorkspaceDescriptor = JointWorkspaceProof.sign(
            fixture.device,
            first.binding,
        );
        expect(await journal.retain(resigned, fixture.signal)).toEqual(first);
        expect(await readFile(join(fixture.directory, 'workspace-binding-1'))).toEqual(archive);
        const second: JointWorkspaceDescriptor = await journal.retain(
            fixture.signed(
                await journal.reserveRevision(fixture.signal),
                'other-file',
                'other-command',
            ),
            fixture.signal,
        );
        const third: JointWorkspaceDescriptor = await journal.retain(
            fixture.signed(await journal.reserveRevision(fixture.signal)),
            fixture.signal,
        );
        expect(
            (await journal.current('file-project', 'command-project', fixture.signal))?.binding
                .revision,
        ).toBe(third.binding.revision);
        expect(await journal.current('other-file', 'other-command', fixture.signal)).toEqual(
            second,
        );
        expect(await journal.current('other-file', 'command-project', fixture.signal)).toBeNull();
        expect(await journal.descriptor(1n, fixture.signal)).toEqual(first);
        expect(Object.isFrozen(journal.snapshot.references)).toBe(true);
    }
    await using reopened: JointWorkspaceJournal = await fixture.open();
    expect(await reopened.descriptor(1n, fixture.signal)).toEqual(first);
    expect(reopened.snapshot.revision).toBe(3n);
    expect(reopened.snapshot.references).toHaveLength(3);
});

it('persists exact pending proof bytes before sending and retires them only with a matching signed authority receipt', async (): Promise<void> => {
    await using fixture: JointWorkspaceJournalFixture = await JointWorkspaceJournalFixture.create();
    await fixture.initialize();
    let publication: JointWorkspacePublication;
    {
        await using journal: JointWorkspaceJournal = await fixture.open();
        const descriptor: JointWorkspaceDescriptor = await journal.retain(
            fixture.signed(await journal.reserveRevision(fixture.signal)),
            fixture.signal,
        );
        publication = await journal.publish(fixture.publicationFor(descriptor), fixture.signal);
        expect(await journal.publish(fixture.publicationFor(descriptor), fixture.signal)).toEqual(
            publication,
        );
        await expect(journal.reserveRevision(fixture.signal)).rejects.toThrow();
    }
    const receipt: JointWorkspaceReceipt = fixture.receiptFor(publication);
    {
        await using reopened: JointWorkspaceJournal = await fixture.open();
        expect(reopened.pending).toEqual(publication);
        await expect(
            reopened.accept(
                fixture.current,
                publication,
                { ...receipt, publicationSha256: 'f'.repeat(64) },
                fixture.nowMs,
                fixture.signal,
            ),
        ).rejects.toThrow('authentication');
        expect(reopened.pending).toEqual(publication);
        expect(
            await reopened.accept(
                fixture.current,
                publication,
                receipt,
                fixture.nowMs,
                fixture.signal,
            ),
        ).toEqual(receipt);
        expect(reopened.pending).toBeNull();
        expect(
            await reopened.accept(
                fixture.current,
                publication,
                fixture.receiptFor(publication),
                fixture.nowMs,
                fixture.signal,
            ),
        ).toEqual(receipt);
    }
    await using accepted: JointWorkspaceJournal = await fixture.open();
    expect(accepted.pending).toBeNull();
    expect(accepted.snapshot.accepted?.publication).toEqual(publication);
    expect(accepted.snapshot.accepted?.receipt).toEqual(receipt);
});

it('explicit replacement-lease publication preserves the binding and rejects a delayed acknowledgment for the prior exact publication', async (): Promise<void> => {
    await using fixture: JointWorkspaceJournalFixture = await JointWorkspaceJournalFixture.create();
    await fixture.initialize();
    await using journal: JointWorkspaceJournal = await fixture.open();
    const descriptor: JointWorkspaceDescriptor = await journal.retain(
        fixture.signed(await journal.reserveRevision(fixture.signal)),
        fixture.signal,
    );
    const old: JointWorkspacePublication = await journal.publish(
        fixture.publicationFor(descriptor),
        fixture.signal,
    );
    const replacement: JointWorkspacePublication = await journal.publish(
        fixture.publicationFor(descriptor, 2),
        fixture.signal,
    );
    expect(replacement.descriptor).toEqual(old.descriptor);
    await expect(
        journal.accept(
            fixture.current,
            old,
            fixture.receiptFor(old),
            fixture.nowMs,
            fixture.signal,
        ),
    ).rejects.toThrow('different original');
    expect(journal.pending).toEqual(replacement);
    await journal.accept(
        { ...fixture.current, leaseId: replacement.leaseId },
        replacement,
        fixture.receiptFor(replacement),
        fixture.nowMs,
        fixture.signal,
    );
    expect(journal.pending).toBeNull();
});

it('refuses revision body changes, unreserved descriptors, permanent journal substitutions and unretained descriptor signatures', async (): Promise<void> => {
    await using fixture: JointWorkspaceJournalFixture = await JointWorkspaceJournalFixture.create();
    await fixture.initialize();
    await using journal: JointWorkspaceJournal = await fixture.open();
    await expect(journal.retain(fixture.signed(1n), fixture.signal)).rejects.toThrow('reservation');
    const descriptor: JointWorkspaceDescriptor = await journal.retain(
        fixture.signed(await journal.reserveRevision(fixture.signal)),
        fixture.signal,
    );
    await expect(
        journal.retain(
            JointWorkspaceProof.sign(fixture.device, {
                ...descriptor.binding,
                access: ConnectorFileMode.ReadOnly,
            }),
            fixture.signal,
        ),
    ).rejects.toThrow('body changed');
    await expect(
        journal.retain(
            JointWorkspaceProof.sign(fixture.device, {
                ...descriptor.binding,
                fileJournalId: 'f'.repeat(64),
            }),
            fixture.signal,
        ),
    ).rejects.toThrow('installation');
    await expect(
        journal.publish(
            fixture.publicationFor(JointWorkspaceProof.sign(fixture.device, descriptor.binding)),
            fixture.signal,
        ),
    ).rejects.toThrow('original descriptor');
});
