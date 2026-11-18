// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import {
    ConnectorHostTool,
    ConnectorHostOutcome,
    type ConnectorHostPermit,
    type ConnectorHostCompletion,
} from 'nerva-connector-protocol/protocol/ConnectorHost.js';
import type { ConnectorClientHost } from '../src/runtime/ConnectorClientHost.js';
import { ConnectorActivityFeed } from '../src/runtime/ConnectorActivityFeed.js';
import { ConnectorConsole } from '../src/cli/ConnectorConsole.js';
import { ConnectorConsoleModel } from '../src/cli/ConnectorConsoleModel.js';
import { ConnectorConsoleScreen, ConnectorConsoleView } from '../src/cli/ConnectorConsoleScreen.js';
import { ConnectorClientState } from '../src/runtime/ConnectorClientState.js';
import { ConnectorHostFixture } from './support/ConnectorHostFixture.js';

/** The fixture's signed local grant, named by what the fixture returns rather than where it is declared. */
type FixtureGrant = Awaited<ReturnType<ConnectorHostFixture['grant']>>;

/** The visible text of one console repaint, without escape sequences. */
function screen(
    model: ConnectorConsoleModel,
    feed: ConnectorActivityFeed,
    view: ConnectorConsoleView,
): string {
    return ConnectorConsoleScreen.frame(
        {
            model,
            activity: feed.snapshot(),
            view,
            scroll: 0,
            input: { text: '', cursor: 0, selected: 0 },
            choices: ConnectorConsole.choices('', model),
            tick: 0,
        },
        120,
        40,
        Date.now(),
        performance.now(),
    )
        .rows.join('\n')
        .replace(new RegExp(String.fromCharCode(27) + '\\[[0-9;?]*[A-Za-z]', 'gu'), '');
}

/** Runs one signed original through the real paired host owner and compacts it like the account would. */
async function run(
    fixture: ConnectorHostFixture,
    host: ConnectorClientHost,
    grant: FixtureGrant,
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
    'the console shows real host requests live, then their results and background programs, without file contents or typed input',
    async (): Promise<void> => {
        await using fixture: ConnectorHostFixture = await ConnectorHostFixture.create();
        const grant: FixtureGrant = await fixture.grant();
        await writeFile(join(fixture.tasks, 'notes.txt'), 'private notes');
        const feed: ConnectorActivityFeed = new ConnectorActivityFeed();
        const model: ConnectorConsoleModel = new ConnectorConsoleModel();
        model.connection(ConnectorClientState.Authenticated);
        model.computer = 'Live test computer';
        model.host = true;
        const repaints: string[] = [];
        const unsubscribe: () => void = feed.subscribe((): void => {
            repaints.push(screen(model, feed, ConnectorConsoleView.Home));
        });
        try {
            const host: ConnectorClientHost = await fixture.open(feed);
            const read: ConnectorHostCompletion = await run(
                fixture,
                host,
                grant,
                1n,
                ConnectorHostTool.FileRead,
                { path: 'notes.txt' },
            );
            expect(read.response.outcome).toBe(ConnectorHostOutcome.Succeeded);
            const live: string | undefined = repaints.find((text: string): boolean =>
                /Right now[^\n]*1 agent working\n[^\n]*Reading a file +notes\.txt +Agent 1 · \d+s/u.test(
                    text,
                ),
            );
            expect(live).toBeDefined();
            const started: ConnectorHostCompletion = await run(
                fixture,
                host,
                grant,
                2n,
                ConnectorHostTool.ProcessStart,
                {
                    executable: process.execPath,
                    arguments: ['-e', 'process.stdin.resume();'],
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
            await run(fixture, host, grant, 3n, ConnectorHostTool.ProcessWrite, {
                processId,
                data: 'typed secret\n',
                encoding: 'utf8',
                end: false,
            });
            await Promise.resolve();
            const busy: string = screen(model, feed, ConnectorConsoleView.Home);
            expect(busy).toContain('Live test computer');
            expect(busy).toContain('Nothing is running.');
            expect(busy).toMatch(
                /Programs running\n[^\n]*▸ Program +[^\n]*-e process\.stdin[^\n]*Agent 2 · started just now/u,
            );
            expect(busy).toMatch(
                /Recent[^\n]*\n[^\n]*✓ Typing into a program[^\n]*Agent 3 · just now/u,
            );
            expect(busy).toMatch(/✓ Reading a file +notes\.txt +Agent 1 · just now/u);
            const history: string = screen(model, feed, ConnectorConsoleView.Activity);
            expect(history).toContain('3 requests so far');
            expect(history).toMatch(/History\n[^\n]*✓ Typing into a program[^\n]*Agent 3/u);
            await run(fixture, host, grant, 4n, ConnectorHostTool.ProcessRelease, { processId });
            await Promise.resolve();
            const after: string = screen(model, feed, ConnectorConsoleView.Home);
            expect(after).not.toContain('Programs running');
            expect(after).toMatch(/✓ Closing a program[^\n]*Agent 4/u);
            for (const text of [...repaints, busy, history, after]) {
                expect(text).not.toContain('private notes');
                expect(text).not.toContain('typed secret');
            }
        } finally {
            unsubscribe();
        }
    },
    60000,
);
