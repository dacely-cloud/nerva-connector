// SPDX-FileCopyrightText: 2026 Dacely <business@dacely.com>
// SPDX-License-Identifier: LicenseRef-Proprietary

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, it, vi, type MockInstance } from 'vitest';
import { ConnectorFrameKind } from '../src/protocol/ConnectorTransport.js';
import type { ExecutionDeliveryLink } from '../src/execution/ExecutionDeliveryLink.js';
import { ConnectorStartupStage } from '../src/runtime/ConnectorStartup.js';
import { JointWorkspaceJournalStore } from '../src/workspace/JointWorkspaceJournalStore.js';
import {
    JointWorkspaceDeliveryFixture,
    type JointWorkspaceDeliverySent,
} from './support/JointWorkspaceDeliveryFixture.js';

it('a real authenticated authority retry repeats exact saved publication bytes without another write or revision and never becomes readiness', async (): Promise<void> => {
    await using fixture: JointWorkspaceDeliveryFixture =
        await JointWorkspaceDeliveryFixture.create();
    using writes: MockInstance<typeof JointWorkspaceJournalStore.prototype.write> = vi.spyOn(
        JointWorkspaceJournalStore.prototype,
        'write',
    );
    const link: ExecutionDeliveryLink = fixture.link();
    fixture.activate(link);
    const first: JointWorkspaceDeliverySent = await fixture.sent();
    const head: Buffer = await readFile(join(fixture.source.directory, 'workspace-head'));
    expect(fixture.delivery.ready).toBe(false);
    expect(writes).toHaveBeenCalledOnce();
    fixture.delivery.receive(
        { kind: ConnectorFrameKind.JointWorkspaceRetry, retry: fixture.retry(first) },
        link,
    );
    const second: JointWorkspaceDeliverySent = await fixture.sent(1);
    expect(second.wire).toBe(first.wire);
    expect(second.publication).toEqual(first.publication);
    expect(await readFile(join(fixture.source.directory, 'workspace-head'))).toEqual(head);
    expect(writes).toHaveBeenCalledOnce();
    expect(fixture.journal.snapshot.revision).toBe(1n);
    expect(fixture.delivery.ready).toBe(false);
    expect(fixture.readyCount).toBe(0);
    expect(fixture.stages).toContain(ConnectorStartupStage.WorkspaceOriginals);
    fixture.accept(second);
    expect(await fixture.ready()).toBe(link.leaseId);
    expect(fixture.delivery.ready).toBe(true);
    expect(fixture.journal.pending).toBeNull();
    expect(fixture.journal.snapshot.accepted?.publication).toEqual(first.publication);
    expect(writes).toHaveBeenCalledTimes(2);
});

it('two explicit pairs serialize one exact in-flight publication and readiness waits for both durable signed acceptances', async (): Promise<void> => {
    await using fixture: JointWorkspaceDeliveryFixture =
        await JointWorkspaceDeliveryFixture.create(2);
    const link: ExecutionDeliveryLink = fixture.link();
    fixture.activate(link);
    const first: JointWorkspaceDeliverySent = await fixture.sent();
    expect(fixture.sentCount).toBe(1);
    expect(first.publication.descriptor.binding.revision).toBe(1n);
    expect(fixture.journal.pending).toEqual(first.publication);
    fixture.accept(first);
    const second: JointWorkspaceDeliverySent = await fixture.sent(1);
    expect(second.publication.descriptor.binding.revision).toBe(2n);
    expect(fixture.journal.pending).toEqual(second.publication);
    expect(fixture.journal.snapshot.accepted?.publication).toEqual(first.publication);
    expect(fixture.delivery.ready).toBe(false);
    expect(fixture.readyCount).toBe(0);
    fixture.accept(second);
    expect(await fixture.ready()).toBe(link.leaseId);
    expect(fixture.delivery.ready).toBe(true);
    expect(fixture.journal.pending).toBeNull();
    expect(fixture.journal.snapshot.references).toHaveLength(2);
    expect(fixture.sentCount).toBe(2);
});

it('a Ready observer may synchronously activate a fresh actual authenticated lease without losing the publication wake-up', async (): Promise<void> => {
    await using fixture: JointWorkspaceDeliveryFixture =
        await JointWorkspaceDeliveryFixture.create();
    const first: ExecutionDeliveryLink = fixture.link();
    const replacement: ExecutionDeliveryLink = fixture.link();
    fixture.onReady = (): void => {
        fixture.onReady = null;
        fixture.activate(replacement);
    };
    fixture.activate(first);
    const publication: JointWorkspaceDeliverySent = await fixture.sent();
    fixture.accept(publication);
    const next: JointWorkspaceDeliverySent = await fixture.sent(1);
    expect(next.link).toBe(replacement);
    expect(fixture.delivery.ready).toBe(false);
    expect(next.publication.descriptor).toEqual(publication.publication.descriptor);
    expect(fixture.journal.snapshot.revision).toBe(1n);
    fixture.accept(next);
    expect(await fixture.ready(1)).toBe(replacement.leaseId);
    expect(fixture.delivery.ready).toBe(true);
});

it('the real five-second response deadline closes the current link, preserves pending metadata and leaves no deadline timer', async (): Promise<void> => {
    await using fixture: JointWorkspaceDeliveryFixture =
        await JointWorkspaceDeliveryFixture.create();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
        const link: ExecutionDeliveryLink = fixture.link();
        fixture.activate(link);
        const publication: JointWorkspaceDeliverySent = await fixture.sent();
        await vi.advanceTimersByTimeAsync(4999);
        expect(fixture.closedCount).toBe(0);
        expect(fixture.delivery.ready).toBe(false);
        await vi.advanceTimersByTimeAsync(1);
        expect(await fixture.closed()).toBe(link);
        expect(fixture.closedCount).toBe(1);
        expect(fixture.journal.pending).toEqual(publication.publication);
        expect(fixture.journal.snapshot.accepted).toBeNull();
        expect(fixture.readyCount).toBe(0);
        expect(vi.getTimerCount()).toBe(0);
    } finally {
        vi.useRealTimers();
    }
});
