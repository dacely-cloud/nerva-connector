// SPDX-FileCopyrightText: 2026 Dacely <business@dacely.com>
// SPDX-License-Identifier: LicenseRef-Proprietary

import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { expect, it } from 'vitest';
import {
    ConnectorHostTool,
    ConnectorHostOutcome,
    ConnectorHostErrorCode,
    type ConnectorHostPermit,
    type ConnectorHostCompletion,
} from 'nerva-connector-protocol/protocol/ConnectorHost.js';
import type { ConnectorClientHost } from '../src/runtime/ConnectorClientHost.js';
import type { ConnectorHostLocalGrant } from '../src/runtime/ConnectorHostGrantTypes.js';
import {
    ConnectorActivityKind,
    ConnectorActivityState,
    type ConnectorActivityEntry,
    type ConnectorActivityHandle,
    type ConnectorActivitySink,
    type ConnectorActivitySnapshot,
    type ConnectorActivitySource,
} from '../src/runtime/ConnectorActivity.js';
import { ConnectorActivityFeed } from '../src/runtime/ConnectorActivityFeed.js';
import { ConnectorHostFixture } from './support/ConnectorHostFixture.js';

/** Records what the real host lane reports, in order, beside the feed it forwards to. */
class RecordingSink implements ConnectorActivitySink {
    /** The real feed every report is forwarded to. */
    public readonly feed: ConnectorActivityFeed = new ConnectorActivityFeed();
    /** Every source the lane began, in order. */
    public readonly sources: ConnectorActivitySource[] = [];
    /** The result JSON of each successful finish, or `null` for a failed one, in order. */
    public readonly outcomes: (string | null)[] = [];
    /** Every program ID the host reported as ended, in order. */
    public readonly ends: string[] = [];

    /** Keeps the source and the outcome the lane reports, then forwards both to the real feed. */
    public begin(source: ConnectorActivitySource): ConnectorActivityHandle {
        this.sources.push(source);
        const handle: ConnectorActivityHandle = this.feed.begin(source);
        return {
            finish: (succeeded: boolean, resultJson: string | null): void => {
                this.outcomes.push(succeeded ? resultJson : null);
                handle.finish(succeeded, resultJson);
            },
        };
    }

    /** Keeps the ended program and forwards it to the real feed. */
    public ended(processId: string): void {
        this.ends.push(processId);
        this.feed.ended(processId);
    }
}

/** Runs one exact signed original through the paired host owner and compacts it like the account would. */
async function run(
    fixture: ConnectorHostFixture,
    host: ConnectorClientHost,
    grant: ConnectorHostLocalGrant,
    sequence: bigint,
    toolName: ConnectorHostTool,
    args: Readonly<Record<string, unknown>>,
): Promise<ConnectorHostCompletion> {
    const permit: ConnectorHostPermit = fixture.permit(
        grant,
        sequence,
        toolName,
        JSON.stringify(args),
    );
    const completion: ConnectorHostCompletion = await host.execute(
        permit,
        permit.leaseId,
        permit.expiresAtMs,
    );
    await host.acknowledge(fixture.acknowledgment(completion), permit.leaseId);
    return completion;
}

it.skipIf(process.platform !== 'linux')(
    'the paired host lane reports each authorized tool call and its outcome to the activity sink',
    async (): Promise<void> => {
        await using fixture: ConnectorHostFixture = await ConnectorHostFixture.create();
        const grant: ConnectorHostLocalGrant = await fixture.grant();
        await writeFile(join(fixture.tasks, 'notes.txt'), 'private notes');
        const sink: RecordingSink = new RecordingSink();
        const host: ConnectorClientHost = await fixture.open(sink);
        const command: string = `${process.execPath} -e process.stdin.resume();`;

        const read: ConnectorHostCompletion = await run(
            fixture,
            host,
            grant,
            1n,
            ConnectorHostTool.FileRead,
            { path: 'notes.txt' },
        );
        expect(read.response.outcome).toBe(ConnectorHostOutcome.Succeeded);
        const missing: ConnectorHostCompletion = await run(
            fixture,
            host,
            grant,
            2n,
            ConnectorHostTool.FileRead,
            { path: 'missing.txt' },
        );
        expect(missing.response.outcome).toBe(ConnectorHostOutcome.Failed);
        const started: ConnectorHostCompletion = await run(
            fixture,
            host,
            grant,
            3n,
            ConnectorHostTool.ProcessStart,
            {
                executable: process.execPath,
                arguments: ['-e', 'process.stdin.resume();'],
                environment: { NERVA_ACTIVITY_SECRET: 'environment-value' },
                timeoutMs: 30000,
            },
        );
        expect(started.response.outcome).toBe(ConnectorHostOutcome.Succeeded);
        const raw: unknown = JSON.parse(started.response.resultJson ?? 'null');
        const processId: unknown =
            typeof raw === 'object' && raw !== null ? Reflect.get(raw, 'processId') : null;
        if (typeof processId !== 'string') {
            throw new Error('Owned process identifier required');
        }
        const running: ConnectorActivitySnapshot = sink.feed.snapshot();
        expect(running.programs).toHaveLength(1);
        expect(running.programs[0]).toMatchObject({
            id: processId,
            agent: 3,
            terminal: false,
            subject: command,
        });
        const typed: ConnectorHostCompletion = await run(
            fixture,
            host,
            grant,
            4n,
            ConnectorHostTool.ProcessWrite,
            { processId, data: 'typed secret\n', encoding: 'utf8', end: false },
        );
        expect(typed.response.outcome).toBe(ConnectorHostOutcome.Succeeded);
        const released: ConnectorHostCompletion = await run(
            fixture,
            host,
            grant,
            5n,
            ConnectorHostTool.ProcessRelease,
            { processId },
        );
        expect(released.response.outcome).toBe(ConnectorHostOutcome.Succeeded);

        expect(sink.sources.map((source: ConnectorActivitySource): string => source.jobId)).toEqual(
            ['host-job-1', 'host-job-2', 'host-job-3', 'host-job-4', 'host-job-5'],
        );
        expect(sink.outcomes[0]).toBe(read.response.resultJson);
        expect(sink.outcomes[1]).toBeNull();
        const snapshot: ConnectorActivitySnapshot = sink.feed.snapshot();
        expect(snapshot.running).toEqual([]);
        expect(snapshot.programs).toEqual([]);
        expect(snapshot.total).toBe(5);
        expect(
            snapshot.recent.map(
                (
                    entry: ConnectorActivityEntry,
                ): readonly [ConnectorActivityKind, string, string, ConnectorActivityState] => [
                    entry.kind,
                    entry.title,
                    entry.subject,
                    entry.state,
                ],
            ),
        ).toEqual([
            [
                ConnectorActivityKind.RunCommand,
                'Closing a program',
                command,
                ConnectorActivityState.Done,
            ],
            [
                ConnectorActivityKind.RunCommand,
                'Typing into a program',
                command,
                ConnectorActivityState.Done,
            ],
            [
                ConnectorActivityKind.RunCommand,
                'Starting a program',
                command,
                ConnectorActivityState.Done,
            ],
            [
                ConnectorActivityKind.ReadFile,
                'Reading a file',
                'missing.txt',
                ConnectorActivityState.Failed,
            ],
            [
                ConnectorActivityKind.ReadFile,
                'Reading a file',
                'notes.txt',
                ConnectorActivityState.Done,
            ],
        ]);
        const shown: string = JSON.stringify(snapshot);
        expect(shown).not.toContain('private notes');
        expect(shown).not.toContain('environment-value');
        expect(shown).not.toContain('typed secret');
    },
);

it.skipIf(process.platform !== 'linux')(
    'a request refused by changed local consent appears as a failed request without running',
    async (): Promise<void> => {
        await using fixture: ConnectorHostFixture = await ConnectorHostFixture.create();
        const original: ConnectorHostLocalGrant = await fixture.grant();
        await fixture.grant(false);
        const sink: RecordingSink = new RecordingSink();
        const host: ConnectorClientHost = await fixture.open(sink);
        const result: ConnectorHostCompletion = await run(
            fixture,
            host,
            original,
            1n,
            ConnectorHostTool.ComputerInfo,
            {},
        );
        expect(result.response.outcome).toBe(ConnectorHostOutcome.Failed);
        expect(result.response.errorCode).toBe(ConnectorHostErrorCode.AdmissionDenied);
        expect(
            sink.sources.map((source: ConnectorActivitySource): string => source.toolName),
        ).toEqual([ConnectorHostTool.ComputerInfo]);
        expect(sink.outcomes).toEqual([null]);
        const snapshot: ConnectorActivitySnapshot = sink.feed.snapshot();
        expect(snapshot.total).toBe(1);
        expect(snapshot.running).toEqual([]);
        expect(snapshot.recent[0]).toMatchObject({
            kind: ConnectorActivityKind.System,
            title: 'Reading computer details',
            state: ConnectorActivityState.Failed,
        });
    },
);

it.skipIf(process.platform !== 'linux')(
    'a program that exits on its own leaves the running list without any later read',
    async (): Promise<void> => {
        await using fixture: ConnectorHostFixture = await ConnectorHostFixture.create();
        const grant: ConnectorHostLocalGrant = await fixture.grant();
        const sink: RecordingSink = new RecordingSink();
        const host: ConnectorClientHost = await fixture.open(sink);
        const started: ConnectorHostCompletion = await run(
            fixture,
            host,
            grant,
            1n,
            ConnectorHostTool.ProcessStart,
            {
                executable: process.execPath,
                arguments: ['-e', 'setTimeout(() => {}, 400);'],
                timeoutMs: 30000,
            },
        );
        expect(started.response.outcome).toBe(ConnectorHostOutcome.Succeeded);
        expect(sink.feed.snapshot().programs).toHaveLength(1);
        const deadline: number = performance.now() + 10000;
        while (sink.feed.snapshot().programs.length > 0 && performance.now() < deadline) {
            await delay(50);
        }
        expect(sink.feed.snapshot().programs).toEqual([]);
        expect(sink.ends).toHaveLength(1);
    },
    20000,
);
