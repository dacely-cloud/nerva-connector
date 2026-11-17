// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, it, vi, type MockInstance } from 'vitest';
import { ConnectorFrameKind } from '../src/protocol/ConnectorTransport.js';
import { ConnectorClientSession } from '../src/runtime/ConnectorClientSession.js';
import type { ConnectorDeviceLease } from 'nerva-connector-protocol/protocol/ConnectorDevice.js';
import type { ExecutionDeliveryLink } from '../src/execution/ExecutionDeliveryLink.js';
import { JointWorkspaceJournal } from '../src/workspace/JointWorkspaceJournal.js';
import {
    JointWorkspaceDeliveryFixture,
    type JointWorkspaceDeliverySent,
} from './support/JointWorkspaceDeliveryFixture.js';
import { JointWorkspaceDeliveryWriteGate } from './support/JointWorkspaceDeliveryWriteGate.js';

it('a replacement authenticated lease cannot race the prior receipt writer and becomes ready only after its own durable acceptance', async (): Promise<void> => {
    await using fixture: JointWorkspaceDeliveryFixture =
        await JointWorkspaceDeliveryFixture.create();
    using gate: JointWorkspaceDeliveryWriteGate = new JointWorkspaceDeliveryWriteGate();
    const first: ExecutionDeliveryLink = fixture.link();
    fixture.activate(first);
    const sent: JointWorkspaceDeliverySent = await fixture.sent();
    const originalArchive: Buffer = await readFile(
        join(fixture.source.directory, 'workspace-binding-1'),
    );
    fixture.accept(sent);
    await gate.entered;
    expect(fixture.delivery.ready).toBe(false);
    expect(fixture.journal.pending).toEqual(sent.publication);
    expect(fixture.journal.snapshot.accepted).toBeNull();
    fixture.delivery.detach(first);
    const replacement: ExecutionDeliveryLink = fixture.link();
    fixture.activate(replacement);
    expect(fixture.sentCount).toBe(1);
    expect(gate.calls).toBe(2);
    expect(gate.maximumActive).toBe(1);
    gate.release();
    const next: JointWorkspaceDeliverySent = await fixture.sent(1);
    expect(next.link).toBe(replacement);
    expect(next.publication.leaseId).not.toBe(sent.publication.leaseId);
    expect(next.publication.descriptor).toEqual(sent.publication.descriptor);
    expect(fixture.journal.snapshot.accepted?.publication).toEqual(sent.publication);
    expect(fixture.journal.pending).toEqual(next.publication);
    expect(fixture.delivery.ready).toBe(false);
    expect(fixture.readyCount).toBe(0);
    expect(gate.maximumActive).toBe(1);
    expect((): void =>
        fixture.delivery.receive(
            { kind: ConnectorFrameKind.JointWorkspaceActivated, receipt: fixture.receipt(sent) },
            first,
        ),
    ).toThrow('Unexpected');
    fixture.accept(next);
    expect(await fixture.ready()).toBe(replacement.leaseId);
    expect(fixture.delivery.ready).toBe(true);
    expect(fixture.journal.snapshot.revision).toBe(1n);
    expect(await readFile(join(fixture.source.directory, 'workspace-binding-1'))).toEqual(
        originalArchive,
    );
    expect(gate.maximumActive).toBe(1);
});

it('detach and joined disposal preserve installation lock until the actual outstanding receipt write finishes', async (): Promise<void> => {
    await using fixture: JointWorkspaceDeliveryFixture =
        await JointWorkspaceDeliveryFixture.create();
    using gate: JointWorkspaceDeliveryWriteGate = new JointWorkspaceDeliveryWriteGate();
    const link: ExecutionDeliveryLink = fixture.link();
    fixture.activate(link);
    const sent: JointWorkspaceDeliverySent = await fixture.sent();
    fixture.accept(sent);
    await gate.entered;
    fixture.delivery.detach(link);
    let closed: boolean = false;
    const closing: Promise<void> = (async (): Promise<void> => {
        await fixture.delivery[Symbol.asyncDispose]();
        await fixture.journal[Symbol.asyncDispose]();
        closed = true;
    })();
    try {
        await expect(fixture.source.open()).rejects.toThrow();
        expect(closed).toBe(false);
        expect(fixture.readyCount).toBe(0);
        gate.release();
        await closing;
        expect(closed).toBe(true);
        expect(gate.maximumActive).toBe(1);
        await using reopened: JointWorkspaceJournal = await fixture.source.open();
        expect(reopened.pending).toBeNull();
        expect(reopened.snapshot.accepted?.publication).toEqual(sent.publication);
        expect(fixture.delivery.ready).toBe(false);
    } finally {
        gate.release();
        await closing;
    }
});

it('an acceptance that becomes durable after its real confirmed lease expires never emits Ready or exposes active readiness', async (): Promise<void> => {
    await using fixture: JointWorkspaceDeliveryFixture =
        await JointWorkspaceDeliveryFixture.create();
    using gate: JointWorkspaceDeliveryWriteGate = new JointWorkspaceDeliveryWriteGate();
    const link: ExecutionDeliveryLink = fixture.link();
    fixture.activate(link);
    const sent: JointWorkspaceDeliverySent = await fixture.sent();
    const lease: ConnectorDeviceLease = ConnectorClientSession.current(
        link.session,
        BigInt(Date.now()),
    );
    fixture.accept(sent);
    await gate.entered;
    if (lease.expiresAtMs > BigInt(Number.MAX_SAFE_INTEGER)) {
        throw new Error('Fixture wall clock must remain exactly representable');
    }
    using clock: MockInstance<typeof Date.now> = vi
        .spyOn(Date, 'now')
        .mockReturnValue(Number(lease.expiresAtMs));
    gate.release();
    expect(await fixture.closed()).toBe(link);
    expect(fixture.delivery.ready).toBe(false);
    expect(fixture.readyCount).toBe(0);
    expect(fixture.journal.pending).toBeNull();
    expect(fixture.journal.snapshot.accepted?.publication).toEqual(sent.publication);
    expect(gate.maximumActive).toBe(1);
    expect(clock).toHaveBeenCalled();
});

it('even a previously ready delivery immediately reports false after its actual confirmed lease expires', async (): Promise<void> => {
    await using fixture: JointWorkspaceDeliveryFixture =
        await JointWorkspaceDeliveryFixture.create();
    const link: ExecutionDeliveryLink = fixture.link();
    fixture.activate(link);
    const sent: JointWorkspaceDeliverySent = await fixture.sent();
    fixture.accept(sent);
    await fixture.ready();
    expect(fixture.delivery.ready).toBe(true);
    const lease: ConnectorDeviceLease = ConnectorClientSession.current(
        link.session,
        BigInt(Date.now()),
    );
    if (lease.expiresAtMs > BigInt(Number.MAX_SAFE_INTEGER)) {
        throw new Error('Fixture wall clock must remain exactly representable');
    }
    using clock: MockInstance<typeof Date.now> = vi
        .spyOn(Date, 'now')
        .mockReturnValue(Number(lease.expiresAtMs));
    expect(fixture.delivery.ready).toBe(false);
    expect(clock).toHaveBeenCalled();
});
