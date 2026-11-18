// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

import { rm, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, it, vi, type MockInstance } from 'vitest';
import { ConnectorClientHost } from '../src/runtime/ConnectorClientHost.js';
import { ConnectorHostGrant } from '../src/runtime/ConnectorHostGrant.js';
import { type ConnectorHostLocalGrant } from '../src/runtime/ConnectorHostGrantTypes.js';
import { ConnectorPrivateDirectory } from '../src/runtime/ConnectorPrivateDirectory.js';
import {
    ConnectorHostTool,
    type ConnectorHostPermit,
    type ConnectorHostCompletion,
} from 'nerva-connector-protocol/protocol/ConnectorHost.js';
import { ConnectorHostFixture } from './support/ConnectorHostFixture.js';

/** Both durable first-activation boundaries are exercised without interrupting unrelated filesystem writes. */
const FailurePoint = {
    Journal: 'journal',
    ReadyGrant: 'ready-grant',
} as const;

/** Each failed activation retains its exact journal identity for the next explicit local review. */
type FailurePoint = (typeof FailurePoint)[keyof typeof FailurePoint];

/** Captured prototype writers require the actual directory instance when the fixture delegates a real write. */
interface JournalWriter {
    (
        this: ConnectorPrivateDirectory,
        name: string,
        bytes: Buffer,
        maximum: number,
        initialize: boolean,
    ): Promise<void>;
}

/** Reflection captures the real method before instrumentation; its controlled source and arity establish this test seam. */
function isJournalWriter(value: unknown): value is JournalWriter {
    return typeof value === 'function' && value.length === 4;
}

it.skipIf(process.platform !== 'linux').each(Object.values(FailurePoint))(
    'interrupted first approval at %s remains inactive and resumes its original journal only after another review',
    async (point: FailurePoint): Promise<void> => {
        await using fixture: ConnectorHostFixture = await ConnectorHostFixture.create();
        const writer: unknown = Reflect.get(ConnectorPrivateDirectory.prototype, 'write');
        if (!isJournalWriter(writer)) {
            throw new Error('The original private journal writer is unavailable');
        }
        const spy: MockInstance<ConnectorPrivateDirectory['write']> = vi.spyOn(
            ConnectorPrivateDirectory.prototype,
            'write',
        );
        spy.mockImplementation(async function (
            this: ConnectorPrivateDirectory,
            name: string,
            bytes: Buffer,
            maximum: number,
            initialize: boolean,
        ): Promise<void> {
            if (
                (point === FailurePoint.Journal && name === 'host-journal') ||
                (point === FailurePoint.ReadyGrant && name === 'grant.json' && !initialize)
            ) {
                throw new Error('Fixture interrupted first activation');
            }
            await writer.call(this, name, bytes, maximum, initialize);
        });
        try {
            await expect(fixture.grant()).rejects.toThrow('Fixture interrupted');
        } finally {
            spy.mockRestore();
        }
        const pending: ConnectorHostLocalGrant | null = await ConnectorHostGrant.read(
            fixture.identity,
        );
        expect(pending?.journalInitialized).toBe(false);
        await expect(ConnectorClientHost.load(fixture.identity)).rejects.toThrow('incomplete');
        expect(await readdir(fixture.tasks)).toEqual([]);
        const ready: ConnectorHostLocalGrant = await fixture.grant();
        expect(ready.journalInitialized).toBe(true);
        expect(ready.journalId).toBe(pending?.journalId);
        expect(ready.profile.grantId).toBe(pending?.profile.grantId);
        const host: ConnectorClientHost = await fixture.open();
        expect(host.journal.snapshot.sequence).toBe(0n);
    },
);

it.skipIf(process.platform !== 'linux')(
    'losing both journal files after a completed effect cannot turn prior consent into fresh local history',
    async (): Promise<void> => {
        await using fixture: ConnectorHostFixture = await ConnectorHostFixture.create();
        const grant: ConnectorHostLocalGrant = await fixture.grant();
        const host: ConnectorClientHost = await fixture.open();
        const permit: ConnectorHostPermit = fixture.permit(
            grant,
            1n,
            ConnectorHostTool.DirectoryCreate,
            '{"path":"retained-effect","recursive":false}',
        );
        const result: ConnectorHostCompletion = await host.execute(
            permit,
            permit.leaseId,
            permit.expiresAtMs,
        );
        await host.acknowledge(fixture.acknowledgment(result), permit.leaseId);
        await host[Symbol.asyncDispose]();
        const directory: string = ConnectorHostGrant.directory(fixture.identity);
        await rm(join(directory, 'host-journal'));
        await rm(join(directory, 'host-ready'));
        await expect(fixture.grant()).rejects.toThrow('journal is missing');
        expect(await ConnectorHostGrant.read(fixture.identity)).toEqual(grant);
        expect(await readdir(fixture.tasks)).toEqual(['retained-effect']);
    },
);
