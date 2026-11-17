// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, it } from 'vitest';
import { ConnectorConsole } from '../src/cli/ConnectorConsole.js';
import {
    ConnectorConsoleScreen,
    ConnectorConsoleView,
    type ConnectorConsoleFrame,
    type ConnectorConsoleScreenState,
} from '../src/cli/ConnectorConsoleScreen.js';
import { ConnectorLogo } from '../src/cli/ConnectorLogo.js';
import { ConnectorScreenPainter } from '../src/cli/ConnectorScreenPainter.js';
import { ConnectorTerminalText } from '../src/cli/ConnectorTerminalText.js';
import { ConnectorActivityFeed } from '../src/runtime/ConnectorActivityFeed.js';
import type { ConnectorActivitySnapshot } from '../src/runtime/ConnectorActivity.js';
import { ConnectorTheme } from '../src/cli/ConnectorTheme.js';
import { ConnectorFailure } from '../src/cli/ConnectorFailure.js';
import { ConnectorStartupStage } from '../src/runtime/ConnectorStartup.js';
import {
    ConnectorConsoleModel,
    ConnectorConsolePhase,
    ConnectorConsoleCommand,
} from '../src/cli/ConnectorConsoleModel.js';
import { ConnectorClientState } from '../src/runtime/ConnectorClientState.js';
import { ConnectorPairEventKind } from '../src/runtime/ConnectorPairClient.js';

it('only authenticated runtime state can show Connected; linking, loss, retries and failures stay distinct', (): void => {
    const model: ConnectorConsoleModel = new ConnectorConsoleModel();
    expect(model.phase).toBe(ConnectorConsolePhase.Starting);
    model.connecting();
    expect(model.phase).toBe(ConnectorConsolePhase.Connecting);
    model.pairing({
        state: ConnectorPairEventKind.Paired,
        configurationFile: '/private/device.json',
        enrollmentId: 'enrolled',
        publicKey: 'public',
    });
    expect(model.phase).toBe(ConnectorConsolePhase.Connecting);
    model.connection(ConnectorClientState.Connecting);
    expect(model.phase).toBe(ConnectorConsolePhase.Connecting);
    model.connection(ConnectorClientState.Authenticated);
    expect(model.phase).toBe(ConnectorConsolePhase.Connected);
    expect(model.message).toBe('Nexa can use this computer. Keep this window open.');
    model.connection(ConnectorClientState.Disconnected);
    expect(model.phase).toBe(ConnectorConsolePhase.Reconnecting);
    model.retrying(ConnectorFailure.retrying(ConnectorStartupStage.Tcp, null), 1000 + 5000);
    expect(model.phase).toBe(ConnectorConsolePhase.Reconnecting);
    expect(model.status(1000)).toBe(
        "Can't reach Nerva. Check your internet connection. Retrying in 5s…",
    );
    expect(model.status(5500)).toContain('Retrying in 1s…');
    model.connection(ConnectorClientState.Connecting);
    expect(model.retryAt).toBeNull();
    model.failure(
        ConnectorFailure.classify({
            error: new Error('Connector pairing was revoked'),
            stage: ConnectorStartupStage.Verification,
            httpStatus: null,
            event: ConnectorPairEventKind.Revoked,
            codeShown: false,
        }),
        null,
    );
    expect(model.phase).toBe(ConnectorConsolePhase.Unavailable);
    expect(model.message).toBe(
        'This computer was removed from your Nerva account. Start over to link it again. Use /logout to start over.',
    );
    model.notLinked();
    expect(model.phase).toBe(ConnectorConsolePhase.NotLinked);
    expect(model.message).toContain('/pair');
});

/** A connected model as the screen sees it. */
function connected(): ConnectorConsoleModel {
    const model: ConnectorConsoleModel = new ConnectorConsoleModel();
    model.connection(ConnectorClientState.Authenticated);
    model.computer = 'Studio PC';
    model.folder = '/home/me/Nexa Tasks';
    model.host = true;
    return model;
}

/** One rendered frame, its rows joined with styles, and its visible rows without escape sequences. */
interface ConnectorConsoleRender {
    readonly frame: ConnectorConsoleFrame;
    readonly text: string;
    readonly lines: readonly string[];
}

/** Renders one frame and returns its text plus the visible rows without escape sequences. */
function render(
    model: ConnectorConsoleModel,
    activity: ConnectorActivitySnapshot,
    options: Partial<ConnectorConsoleScreenState>,
    columns: number = 100,
    rows: number = 40,
    now: number = Date.now(),
): ConnectorConsoleRender {
    const typed: string = options.input?.text ?? '';
    const frame: ConnectorConsoleFrame = ConnectorConsoleScreen.frame(
        {
            model,
            activity,
            view: ConnectorConsoleView.Home,
            scroll: 0,
            input: { text: typed, cursor: typed.length, selected: 0 },
            choices: ConnectorConsole.choices(typed, model, 'linux'),
            tick: 0,
            ...options,
        },
        columns,
        rows,
        now,
        1000,
    );
    const text: string = frame.rows.join('\n');
    return {
        frame,
        text,
        lines: text
            .replace(new RegExp(String.fromCharCode(27) + '\\[[0-9;?]*[A-Za-z]', 'gu'), '')
            .split('\n'),
    };
}

it('the console shows the Nerva logo, the computer, its live state, the access level and the menu', (): void => {
    const model: ConnectorConsoleModel = connected();
    const feed: ConnectorActivityFeed = new ConnectorActivityFeed();
    const home: ConnectorConsoleRender = render(model, feed.snapshot(), {});
    expect(home.text).toContain(ConnectorTheme.background);
    expect(home.text).toContain(ConnectorLogo.rows()[0] ?? 'logo');
    expect(home.text).toContain('Nerva Connector');
    expect(home.text).toContain(' / Studio PC');
    expect(home.text).toContain('● Connected');
    expect(home.text).toContain('Full computer');
    expect(home.text).toContain('Nothing is running.');
    expect(home.text).not.toContain('56;189;248');
    const menu: ConnectorConsoleRender = render(model, feed.snapshot(), {
        input: { text: '/', cursor: 1, selected: 0 },
    });
    expect(menu.text).toContain(ConnectorTheme.selected + '› /activity');
    expect(menu.text).toContain('Turn off full computer access');
    expect(menu.frame.cursorColumn).toBe(6);
    model.failure(ConnectorFailure.retrying(ConnectorStartupStage.Dns, null), 10000);
    const failed: ConnectorConsoleRender = render(model, feed.snapshot(), {});
    expect(failed.text).toContain("● Can't connect");
    expect(failed.text).toContain('Retrying in 9s…');
});

it('repaints write only rows that changed, nothing when nothing changed, and clear the screen only on resize', (): void => {
    const painter: ConnectorScreenPainter = new ConnectorScreenPainter();
    const frame = (rows: readonly string[], column: number = 1) => ({
        rows,
        cursorRow: 3,
        cursorColumn: column,
        cursorVisible: true,
    });
    const first: string = painter.paint(frame(['one', 'two', 'three']), 80, 24);
    expect(first).toContain('\x1b[2J');
    expect(first).toContain('\x1b[1;1Hone');
    expect(first).toContain('\x1b[3;1Hthree');
    expect(painter.paint(frame(['one', 'two', 'three']), 80, 24)).toBe('');
    const changed: string = painter.paint(frame(['one', 'TWO', 'three']), 80, 24);
    expect(changed).toContain('\x1b[2;1HTWO');
    expect(changed).not.toContain('one');
    expect(changed).not.toContain('three');
    expect(changed).not.toContain('\x1b[2J');
    expect(painter.paint(frame(['one', 'TWO', 'three'], 4), 80, 24)).toBe('\x1b[3;4H\x1b[?25h');
    expect(painter.paint(frame(['one', 'TWO', 'three'], 4), 100, 24)).toContain('\x1b[2J');
    painter.reset();
    expect(painter.paint(frame(['one', 'TWO', 'three'], 4), 100, 24)).toContain('\x1b[2J');
});

it('finished activity stays still between ticks, so the user can select and copy it', (): void => {
    const model: ConnectorConsoleModel = connected();
    const feed: ConnectorActivityFeed = new ConnectorActivityFeed();
    feed.begin({
        jobId: 'job-a',
        toolName: 'file_read',
        argumentsJson: JSON.stringify({ path: '/home/me/notes.txt' }),
    }).finish(true, null);
    const painter: ConnectorScreenPainter = new ConnectorScreenPainter();
    const now: number = Date.now();
    for (const view of Object.values(ConnectorConsoleView)) {
        painter.reset();
        painter.paint(
            render(model, feed.snapshot(), { view, tick: 1 }, 100, 40, now).frame,
            100,
            40,
        );
        expect(
            painter.paint(
                render(model, feed.snapshot(), { view, tick: 2 }, 100, 40, now + 30000).frame,
                100,
                40,
            ),
        ).toBe('');
    }
});

it('activity shows the whole command line, wrapped under its title, instead of cutting it short', (): void => {
    const model: ConnectorConsoleModel = connected();
    const feed: ConnectorActivityFeed = new ConnectorActivityFeed();
    const words: readonly string[] = Array.from(
        { length: 40 },
        (_value: unknown, index: number): string => 'word' + index.toString(),
    );
    feed.begin({
        jobId: 'job-a',
        toolName: 'process_start',
        argumentsJson: JSON.stringify({
            shell: 'powershell',
            command: 'Write-Output ' + words.join(' '),
            timeoutMs: 30000,
        }),
    }).finish(true, null);
    for (const view of Object.values(ConnectorConsoleView)) {
        for (const columns of [100, 60]) {
            const { lines } = render(model, feed.snapshot(), { view }, columns, 40);
            const text: string = lines.map((line: string): string => line.trim()).join(' ');
            expect(text).toContain(words.join(' '));
            expect(text).not.toContain('…');
            for (const line of lines) {
                expect(ConnectorTerminalText.width(line)).toBeLessThanOrEqual(columns);
            }
        }
    }
});

it('the menu offers only what makes sense now and never interprets input as a host command', (): void => {
    const model: ConnectorConsoleModel = connected();
    const commands = (
        input: string,
        platform: NodeJS.Platform,
    ): readonly ConnectorConsoleCommand[] =>
        ConnectorConsole.choices(input, model, platform).map(
            (choice): ConnectorConsoleCommand => choice.command,
        );
    expect(commands('/PER', 'linux')).toEqual([ConnectorConsoleCommand.Permissions]);
    expect(commands('/per', 'win32')).toEqual([]);
    expect(commands('/pa', 'linux')).toEqual([]);
    expect(commands('/dis', 'win32')).toEqual([ConnectorConsoleCommand.DisableHost]);
    model.host = false;
    expect(commands('/dis', 'win32')).toEqual([]);
    model.notLinked();
    expect(commands('/pa', 'linux')).toEqual([ConnectorConsoleCommand.Pair]);
    expect(commands('/etc/passwd', 'linux')).toEqual([]);
    expect(commands('rm -rf', 'linux')).toEqual([]);
});

it('activity rows show agents and plain actions, hide secrets and control characters, and always fit the terminal', (): void => {
    const model: ConnectorConsoleModel = connected();
    const feed: ConnectorActivityFeed = new ConnectorActivityFeed();
    feed.begin({
        jobId: 'job-a',
        toolName: 'file_write',
        argumentsJson: JSON.stringify({
            path: '/home/me/project/\u001b[31mnotes.txt',
            data: 'top secret contents',
            mode: 'replace',
        }),
    }).finish(true, null);
    feed.begin({
        jobId: 'job-b',
        toolName: 'desktop_text',
        argumentsJson: JSON.stringify({ text: 'hunter2' }),
    });
    for (let index: number = 0; index < 30; index++) {
        feed.begin({
            jobId: 'job-a',
            toolName: 'file_read',
            argumentsJson: JSON.stringify({ path: '/home/me/project/file' + index.toString() }),
        }).finish(index % 7 !== 0, null);
    }
    for (const [columns, rows] of [
        [100, 40],
        [60, 24],
        [40, 16],
        [24, 10],
    ] as const) {
        for (const view of Object.values(ConnectorConsoleView)) {
            const { text, lines } = render(model, feed.snapshot(), { view }, columns, rows);
            expect(lines).toHaveLength(rows);
            for (const line of lines) {
                expect(ConnectorTerminalText.width(line)).toBeLessThanOrEqual(columns);
            }
            expect(text).not.toContain('top secret');
            expect(text).not.toContain('hunter2');
            expect(text).not.toContain('\u001b[31m');
        }
    }
    const { lines } = render(model, feed.snapshot(), {});
    const text: string = lines.join('\n');
    expect(text).toContain('Right now');
    expect(text).toContain('Agent 2');
    expect(text).toContain('Typing text');
    expect(text).toContain('Recent');
    expect(text).toContain('Reading a file');
    expect(text).toContain('/home/me/project/file29');
    const history: string = render(
        model,
        feed.snapshot(),
        {
            view: ConnectorConsoleView.Activity,
            scroll: 5,
        },
        100,
        24,
    ).lines.join('\n');
    expect(history).toContain('History');
    expect(history).toContain('32 requests so far');
    expect(history).toMatch(/6–\d+ of 31/u);
    expect(history).not.toContain('file29');
});

it.skipIf(process.platform !== 'linux')(
    'the real terminal supports successive slash actions, completion and quit without EOF, restoring terminal state',
    async (): Promise<void> => {
        const directory: string = await mkdtemp(join(homedir(), '.nerva-console-'));
        try {
            const result: Awaited<ReturnType<typeof execFile.__promisify__>> = await promisify(
                execFile,
            )(
                '/usr/bin/python3',
                [
                    '-I',
                    '-B',
                    resolve('test/support/ConnectorConsoleTerminalProbe.py'),
                    process.execPath,
                    resolve('build/nerva-connector.mjs'),
                    directory,
                ],
                { env: { PATH: process.env['PATH'] }, timeout: 20000, maxBuffer: 16384 },
            );
            expect(result.stdout).toContain('terminal-verified');
            expect(await readdir(directory)).toEqual([]);
        } finally {
            await rm(directory, { recursive: true, force: true });
        }
    },
    25000,
);

it('draining a closed channel cannot retain Connected or overwrite a final Stopped state', (): void => {
    const model: ConnectorConsoleModel = new ConnectorConsoleModel();
    model.closing();
    expect(model.phase).toBe(ConnectorConsolePhase.Connecting);
    model.connection(ConnectorClientState.Authenticated);
    model.closing();
    expect(model.phase).toBe(ConnectorConsolePhase.Reconnecting);
    expect(model.message).toContain('previous connection');
    model.connection(ConnectorClientState.Stopped);
    model.closing();
    expect(model.phase).toBe(ConnectorConsolePhase.Stopped);
    expect(model.message).toBe('Connection stopped.');
});
