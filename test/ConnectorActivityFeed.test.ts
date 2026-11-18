// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

import { expect, it } from 'vitest';
import { ConnectorHostTool } from 'nerva-connector-protocol/protocol/ConnectorHost.js';
import {
    ConnectorFileAction,
    ConnectorWriteMode,
} from 'nerva-connector-protocol/protocol/ConnectorFileTypes.js';
import type { ConnectorFileWrite } from 'nerva-connector-protocol/protocol/ConnectorFiles.js';
import type { ExecutionRequest } from 'nerva-connector-protocol/execution/ExecutionJobs.js';
import type { ConnectorOperationDispatch } from 'nerva-connector-protocol/protocol/ConnectorOperationDispatch.js';
import { ConnectorAuthorizationKind } from 'nerva-connector-protocol/protocol/ConnectorAuthorization.js';
import {
    ConnectorActivityKind,
    ConnectorActivityState,
    type ConnectorActivityEntry,
    type ConnectorActivityHandle,
    type ConnectorActivityProgram,
    type ConnectorActivitySnapshot,
    type ConnectorActivitySource,
} from '../src/runtime/ConnectorActivity.js';
import { ConnectorActivityArguments } from '../src/runtime/ConnectorActivityArguments.js';
import {
    ConnectorActivityDescription,
    type ConnectorActivityDescribed,
} from '../src/runtime/ConnectorActivityDescription.js';
import { ConnectorActivityFeed } from '../src/runtime/ConnectorActivityFeed.js';
import {
    ConnectorActivityLane,
    ConnectorActivityLaneOperation,
} from '../src/runtime/ConnectorActivityLane.js';

/** Describes one request from literal JSON arguments. */
function describe(
    toolName: string,
    args: Readonly<Record<string, unknown>>,
): ConnectorActivityDescribed {
    return ConnectorActivityDescription.describe(
        toolName,
        ConnectorActivityArguments.parse(JSON.stringify(args)),
    );
}

/** Builds a host source for one agent. */
function source(
    toolName: string,
    args: Readonly<Record<string, unknown>>,
    jobId: string = 'job-a',
): ConnectorActivitySource {
    return { jobId, toolName, argumentsJson: JSON.stringify(args) };
}

/** Lets the feed's coalesced notification microtask run. */
async function settle(): Promise<void> {
    await new Promise<void>((resolve: () => void): void => {
        setImmediate(resolve);
    });
}

/** A command dispatch carries only fields the projection reads; signatures are irrelevant here. */
function dispatch(
    programId: string,
    args: readonly string[],
): ConnectorOperationDispatch<ExecutionRequest> {
    return {
        jobId: 'command-job',
        sequence: 1n,
        dispatchId: 'dispatch',
        requestHash: 'hash',
        authorization: { kind: ConnectorAuthorizationKind.Independent },
        admissionHash: 'admission',
        request: {
            requestId: 'request',
            policySha256: 'a'.repeat(64),
            programId,
            rootId: 'workspace',
            arguments: args,
        },
    };
}

const kinds: readonly string[] = Object.values(ConnectorActivityKind);

it('describes every host tool and lane operation with a kind and a specific plain title', (): void => {
    const generic: ConnectorActivityDescribed = describe('not_a_tool', {});
    expect(generic).toEqual({
        kind: ConnectorActivityKind.System,
        title: 'Working on this computer',
        subject: '',
    });
    const names: readonly string[] = [
        ...Object.values(ConnectorHostTool),
        ...Object.values(ConnectorActivityLaneOperation),
    ];
    expect(Object.values(ConnectorHostTool)).toHaveLength(34);
    for (const name of names) {
        const described: ConnectorActivityDescribed = describe(name, {});
        expect(kinds).toContain(described.kind);
        expect(described.title.length).toBeGreaterThan(0);
        expect(described.title).not.toBe(generic.title);
        expect(described.subject).toBe(described.subject.trim());
    }
});

it('groups host tools into the expected kinds and names their subjects', (): void => {
    const expected: Readonly<Record<ConnectorHostTool, ConnectorActivityKind>> = {
        file_read: ConnectorActivityKind.ReadFile,
        file_digest: ConnectorActivityKind.ReadFile,
        file_stat: ConnectorActivityKind.ReadFile,
        directory_list: ConnectorActivityKind.ReadFile,
        file_write: ConnectorActivityKind.ChangeFile,
        file_publish: ConnectorActivityKind.ChangeFile,
        file_rename: ConnectorActivityKind.ChangeFile,
        file_chmod: ConnectorActivityKind.ChangeFile,
        directory_create: ConnectorActivityKind.ChangeFile,
        file_remove: ConnectorActivityKind.ChangeFile,
        process_start: ConnectorActivityKind.RunCommand,
        process_read: ConnectorActivityKind.RunCommand,
        process_write: ConnectorActivityKind.RunCommand,
        process_stop: ConnectorActivityKind.RunCommand,
        process_release: ConnectorActivityKind.RunCommand,
        terminal_start: ConnectorActivityKind.Terminal,
        terminal_read: ConnectorActivityKind.Terminal,
        terminal_write: ConnectorActivityKind.Terminal,
        terminal_resize: ConnectorActivityKind.Terminal,
        terminal_stop: ConnectorActivityKind.Terminal,
        terminal_release: ConnectorActivityKind.Terminal,
        desktop_info: ConnectorActivityKind.Screen,
        application_open: ConnectorActivityKind.RunCommand,
        desktop_snapshot: ConnectorActivityKind.Screen,
        desktop_screenshot: ConnectorActivityKind.Screen,
        desktop_pointer: ConnectorActivityKind.Control,
        desktop_key: ConnectorActivityKind.Control,
        desktop_text: ConnectorActivityKind.Control,
        network_resolve: ConnectorActivityKind.Web,
        http_open: ConnectorActivityKind.Web,
        http_read: ConnectorActivityKind.Web,
        http_close: ConnectorActivityKind.Web,
        computer_info: ConnectorActivityKind.System,
        environment_inspect: ConnectorActivityKind.System,
    };
    for (const tool of Object.values(ConnectorHostTool)) {
        expect(describe(tool, {}).kind).toBe(expected[tool]);
    }
    expect(describe(ConnectorHostTool.ApplicationOpen, { name: 'Firefox' })).toEqual({
        kind: ConnectorActivityKind.RunCommand,
        title: 'Opening an application',
        subject: 'Firefox',
    });
    expect(describe(ConnectorHostTool.DesktopSnapshot, {})).toEqual({
        kind: ConnectorActivityKind.Screen,
        title: 'Looking at the screen',
        subject: '',
    });
    expect(describe(ConnectorHostTool.FileRead, { path: '/home/me/notes.txt' })).toEqual({
        kind: ConnectorActivityKind.ReadFile,
        title: 'Reading a file',
        subject: '/home/me/notes.txt',
    });
    expect(describe(ConnectorHostTool.DirectoryList, { path: 'C:\\Users' }).title).toBe(
        'Listing a folder',
    );
    expect(describe(ConnectorHostTool.FileWrite, { path: 'a', mode: 'create' }).title).toBe(
        'Creating a file',
    );
    expect(describe(ConnectorHostTool.FileWrite, { path: 'a', mode: 'append' }).title).toBe(
        'Adding to a file',
    );
    expect(describe(ConnectorHostTool.FileWrite, { path: 'a', mode: 'replace' }).title).toBe(
        'Changing a file',
    );
    expect(describe(ConnectorHostTool.FileRemove, { path: 'a', recursive: false }).title).toBe(
        'Deleting a file',
    );
    expect(describe(ConnectorHostTool.FileRemove, { path: 'a', recursive: true }).title).toBe(
        'Deleting a folder',
    );
    expect(
        describe(ConnectorHostTool.FileRename, { source: 'a.txt', destination: 'b.txt' }),
    ).toEqual({
        kind: ConnectorActivityKind.ChangeFile,
        title: 'Renaming a file',
        subject: 'a.txt → b.txt',
    });
    expect(
        describe(ConnectorHostTool.ProcessStart, {
            executable: 'npm',
            arguments: ['run', 'dev'],
            timeoutMs: 1000,
        }),
    ).toEqual({
        kind: ConnectorActivityKind.RunCommand,
        title: 'Starting a program',
        subject: 'npm run dev',
    });
    expect(
        describe(ConnectorHostTool.TerminalStart, {
            shell: 'bash',
            command: 'ls -la',
            cols: 80,
            rows: 24,
        }).subject,
    ).toBe('ls -la');
    expect(describe(ConnectorHostTool.DesktopPointer, { x: 10, y: 20, action: 'click' })).toEqual({
        kind: ConnectorActivityKind.Control,
        title: 'Clicking',
        subject: 'at 10, 20',
    });
    expect(describe(ConnectorHostTool.DesktopPointer, { x: 1, y: 2, action: 'move' }).title).toBe(
        'Moving the mouse',
    );
    expect(describe(ConnectorHostTool.DesktopKey, { key: 'Enter', action: 'press' })).toEqual({
        kind: ConnectorActivityKind.Control,
        title: 'Pressing keys',
        subject: 'Enter',
    });
    expect(describe(ConnectorHostTool.DesktopKey, { key: 'q', action: 'press' }).subject).toBe(
        'a letter or number',
    );
    expect(describe(ConnectorHostTool.NetworkResolve, { hostname: 'example.com' })).toEqual({
        kind: ConnectorActivityKind.Web,
        title: 'Looking up a web address',
        subject: 'example.com',
    });
    expect(
        describe(ConnectorHostTool.EnvironmentInspect, {
            programs: ['git', 'node'],
            variables: ['HOME'],
        }),
    ).toEqual({
        kind: ConnectorActivityKind.System,
        title: 'Checking installed programs',
        subject: 'git, node',
    });
    expect(describe(ConnectorHostTool.ComputerInfo, {}).title).toBe('Reading computer details');
    expect(describe(ConnectorHostTool.DesktopScreenshot, { path: 'shot.png' }).title).toBe(
        'Taking a screenshot',
    );
});

it('never puts written data, typed text, input, environment values, headers or URL secrets in a subject', (): void => {
    const marker: string = 'S3CRET';
    const feed: ConnectorActivityFeed = new ConnectorActivityFeed();
    const sources: readonly ConnectorActivitySource[] = [
        source(ConnectorHostTool.FileWrite, {
            path: 'notes.txt',
            data: `${marker}-file`,
            encoding: 'utf8',
            mode: 'replace',
        }),
        source(ConnectorHostTool.DesktopText, { text: `${marker}-typed` }),
        source(ConnectorHostTool.ProcessWrite, {
            processId: 'p',
            data: `${marker}-stdin`,
            encoding: 'utf8',
            end: false,
        }),
        source(ConnectorHostTool.TerminalWrite, {
            processId: 'p',
            data: `${marker}-tty`,
            encoding: 'utf8',
        }),
        source(ConnectorHostTool.ProcessStart, {
            executable: 'tool',
            arguments: ['--quiet'],
            environment: { TOKEN: `${marker}-environment` },
            timeoutMs: 1000,
        }),
        source(ConnectorHostTool.TerminalStart, {
            shell: 'bash',
            command: 'make',
            environment: { PASSWORD: `${marker}-environment` },
            timeoutMs: 1000,
            cols: 80,
            rows: 24,
        }),
        source(ConnectorHostTool.HttpOpen, {
            url: `https://user:${marker}-password@example.com:8443/docs/page?token=${marker}-query#${marker}-fragment`,
            address: '93.184.216.34',
            method: 'GET',
            headers: { Authorization: `Bearer ${marker}-header` },
            maximumBytes: '1000',
            timeoutMs: 1000,
            idleTimeoutMs: 1000,
        }),
        ConnectorActivityLane.folder('job-f', {
            action: ConnectorFileAction.Write,
            requestId: 'request',
            policySha256: 'a'.repeat(64),
            rootId: 'projects',
            path: 'app/main.ts',
            mode: ConnectorWriteMode.Create,
            dataBase64: Buffer.from(`${marker}-folder`).toString('base64'),
        } satisfies ConnectorFileWrite),
    ];
    for (const item of sources) {
        expect(
            item.argumentsJson.includes(Buffer.from(`${marker}-folder`).toString('base64')),
        ).toBe(false);
        feed.begin(item).finish(true, null);
    }
    const snapshot: ConnectorActivitySnapshot = feed.snapshot();
    expect(JSON.stringify(snapshot)).not.toContain(marker);
    const subjects: readonly string[] = snapshot.recent.map(
        (entry: ConnectorActivityEntry): string => entry.subject,
    );
    expect(subjects).toEqual([
        'projects/app/main.ts',
        'example.com:8443/docs/page',
        'make',
        'tool --quiet',
        '',
        '',
        '12 characters',
        'notes.txt',
    ]);
    expect(snapshot.recent[0]?.title).toBe('Creating a file');
    expect(snapshot.recent[6]?.title).toBe('Typing text');
});

it('sanitizes subjects to one bounded printable line', (): void => {
    expect(ConnectorActivityDescription.sanitize('  a\n\tb\r\nc  ')).toBe('a b c');
    expect(ConnectorActivityDescription.sanitize('safe\u202Eexe.txt\u200B\u0000\u0007')).toBe(
        'safeexe.txt',
    );
    expect(ConnectorActivityDescription.sanitize('x\u0007\ty')).toBe('x y');
    expect(ConnectorActivityDescription.sanitize('lone \uD800 surrogate')).toBe(
        'lone \uFFFD surrogate',
    );
    const limit: number = ConnectorActivityDescription.subjectLimit;
    const exact: string = 'a'.repeat(limit);
    expect(ConnectorActivityDescription.sanitize(exact)).toBe(exact);
    const long: string = ConnectorActivityDescription.sanitize('b'.repeat(limit + 1));
    expect(long).toHaveLength(limit);
    expect(long.endsWith('…')).toBe(true);
    const huge: string = ConnectorActivityDescription.sanitize('c'.repeat(1000000));
    expect(huge).toHaveLength(limit);
    const emoji: string = ConnectorActivityDescription.sanitize(
        'd'.repeat(limit - 2) + '😀'.repeat(5),
    );
    expect(emoji.length).toBeLessThanOrEqual(limit);
    expect(emoji.isWellFormed()).toBe(true);
    expect(emoji.endsWith('…')).toBe(true);
    const path: ConnectorActivityDescribed = describe(ConnectorHostTool.FileRead, {
        path: `dir/\u001b[31mred\u001b[0m\n${'e'.repeat(limit + 100)}`,
    });
    expect(path.subject).toHaveLength(limit);
    expect(path.subject).not.toMatch(/[\p{Cc}\p{Cf}]/u);
    expect(path.subject.startsWith('dir/[31mred[0m e')).toBe(true);
});

it('reads malformed arguments as empty and never throws for odd input', (): void => {
    const feed: ConnectorActivityFeed = new ConnectorActivityFeed();
    const odd: readonly ConnectorActivitySource[] = [
        { jobId: 'a', toolName: ConnectorHostTool.FileRead, argumentsJson: '{not json' },
        { jobId: 'a', toolName: ConnectorHostTool.FileRead, argumentsJson: '[1,2,3]' },
        { jobId: 'a', toolName: ConnectorHostTool.FileRead, argumentsJson: 'null' },
        { jobId: 'a', toolName: ConnectorHostTool.ProcessStart, argumentsJson: '{"arguments":7}' },
        {
            jobId: 'a',
            toolName: ConnectorHostTool.HttpOpen,
            argumentsJson: '{"url":"::not a url"}',
        },
        { jobId: 'a', toolName: ConnectorHostTool.DesktopPointer, argumentsJson: '{"x":"1"}' },
        { jobId: 'a', toolName: '__proto__', argumentsJson: '{"__proto__":{"path":"x"}}' },
        { jobId: 'a', toolName: 'constructor', argumentsJson: '{}' },
    ];
    for (const item of odd) {
        const handle: ConnectorActivityHandle = feed.begin(item);
        handle.finish(true, '{broken');
    }
    const recent: readonly ConnectorActivityEntry[] = feed.snapshot().recent;
    expect(recent).toHaveLength(odd.length);
    expect(recent.map((entry: ConnectorActivityEntry): string => entry.subject)).toEqual([
        '',
        '',
        '',
        '',
        '',
        '',
        '',
        '',
    ]);
    expect(recent[0]?.title).toBe('Working on this computer');
    expect(recent[1]?.title).toBe('Working on this computer');
    expect(feed.snapshot().programs).toEqual([]);
});

it('numbers agents by first appearance and keeps running requests oldest first', (): void => {
    const feed: ConnectorActivityFeed = new ConnectorActivityFeed();
    const first: ConnectorActivityHandle = feed.begin(
        source(ConnectorHostTool.ComputerInfo, {}, 'a'),
    );
    const second: ConnectorActivityHandle = feed.begin(
        source(ConnectorHostTool.ComputerInfo, {}, 'b'),
    );
    feed.begin(source(ConnectorHostTool.ComputerInfo, {}, 'a'));
    feed.begin(source(ConnectorHostTool.ComputerInfo, {}, 'c'));
    const running: readonly ConnectorActivityEntry[] = feed.snapshot().running;
    expect(running.map((entry: ConnectorActivityEntry): number => entry.agent)).toEqual([
        1, 2, 1, 3,
    ]);
    expect(running.map((entry: ConnectorActivityEntry): number => entry.id)).toEqual([1, 2, 3, 4]);
    expect(
        running.every((entry: ConnectorActivityEntry): boolean => entry.endedAtMs === null),
    ).toBe(true);
    second.finish(false, null);
    first.finish(true, null);
    const after: ConnectorActivitySnapshot = feed.snapshot();
    expect(after.running.map((entry: ConnectorActivityEntry): number => entry.id)).toEqual([3, 4]);
    expect(after.recent.map((entry: ConnectorActivityEntry): string => entry.state)).toEqual([
        ConnectorActivityState.Done,
        ConnectorActivityState.Failed,
    ]);
    expect(after.recent[0]?.endedAtMs).toBeGreaterThanOrEqual(after.recent[0]?.startedAtMs ?? 0);
    expect(after.total).toBe(4);
});

it('forgets the least recently active agent beyond its bound', (): void => {
    const feed: ConnectorActivityFeed = new ConnectorActivityFeed();
    for (let index: number = 0; index < ConnectorActivityFeed.agentLimit; index++) {
        feed.begin(source(ConnectorHostTool.ComputerInfo, {}, `job-${index}`)).finish(true, null);
    }
    feed.begin(source(ConnectorHostTool.ComputerInfo, {}, 'job-0')).finish(true, null);
    feed.begin(source(ConnectorHostTool.ComputerInfo, {}, 'newcomer')).finish(true, null);
    feed.begin(source(ConnectorHostTool.ComputerInfo, {}, 'job-1')).finish(true, null);
    feed.begin(source(ConnectorHostTool.ComputerInfo, {}, 'job-0')).finish(true, null);
    expect(
        feed
            .snapshot()
            .recent.slice(0, 4)
            .map((entry: ConnectorActivityEntry): number => entry.agent),
    ).toEqual([1, ConnectorActivityFeed.agentLimit + 2, ConnectorActivityFeed.agentLimit + 1, 1]);
});

it('keeps the newest 100 finished requests, newest first, and counts every request', (): void => {
    const feed: ConnectorActivityFeed = new ConnectorActivityFeed();
    for (let index: number = 0; index < 250; index++) {
        feed.begin(source(ConnectorHostTool.FileStat, { path: `file-${index + 1}` })).finish(
            true,
            null,
        );
    }
    const snapshot: ConnectorActivitySnapshot = feed.snapshot();
    expect(snapshot.recent).toHaveLength(ConnectorActivityFeed.recentLimit);
    expect(snapshot.recent[0]?.id).toBe(250);
    expect(snapshot.recent[0]?.subject).toBe('file-250');
    expect(snapshot.recent[99]?.id).toBe(151);
    expect(snapshot.running).toEqual([]);
    expect(snapshot.total).toBe(250);
    expect(Object.isFrozen(snapshot.recent)).toBe(true);
    expect(Object.isFrozen(snapshot.recent[0])).toBe(true);
});

it('bounds running requests that are never finished', (): void => {
    const feed: ConnectorActivityFeed = new ConnectorActivityFeed();
    const first: ConnectorActivityHandle = feed.begin(source(ConnectorHostTool.ComputerInfo, {}));
    for (let index: number = 0; index < ConnectorActivityFeed.runningLimit + 10; index++) {
        feed.begin(source(ConnectorHostTool.ComputerInfo, {}));
    }
    expect(feed.snapshot().running).toHaveLength(ConnectorActivityFeed.runningLimit);
    first.finish(true, null);
    expect(feed.snapshot().recent).toEqual([]);
});

it('finishes each request at most once', (): void => {
    const feed: ConnectorActivityFeed = new ConnectorActivityFeed();
    const handle: ConnectorActivityHandle = feed.begin(source(ConnectorHostTool.DesktopInfo, {}));
    handle.finish(true, null);
    handle.finish(false, null);
    const snapshot: ConnectorActivitySnapshot = feed.snapshot();
    expect(snapshot.recent).toHaveLength(1);
    expect(snapshot.recent[0]?.state).toBe(ConnectorActivityState.Done);
    expect(snapshot.running).toEqual([]);
});

it('tracks background programs and terminals from start, read, stop and release results', (): void => {
    const feed: ConnectorActivityFeed = new ConnectorActivityFeed();
    feed.begin(
        source(ConnectorHostTool.ProcessStart, { executable: 'node', arguments: ['server.js'] }),
    ).finish(true, JSON.stringify({ processId: 'p1', running: true, stdout: { data: 'x' } }));
    feed.begin(
        source(ConnectorHostTool.TerminalStart, { shell: 'bash', command: 'top' }, 'job-b'),
    ).finish(true, JSON.stringify({ processId: 't1', running: true }));
    feed.begin(source(ConnectorHostTool.ProcessStart, { executable: 'true' })).finish(
        true,
        JSON.stringify({ processId: 'p2', running: false }),
    );
    feed.begin(source(ConnectorHostTool.ProcessStart, { executable: 'denied' })).finish(
        false,
        null,
    );
    const started: readonly ConnectorActivityProgram[] = feed.snapshot().programs;
    expect(
        started.map(
            (program: ConnectorActivityProgram): readonly [string, number, boolean, string] => [
                program.id,
                program.agent,
                program.terminal,
                program.subject,
            ],
        ),
    ).toEqual([
        ['p1', 1, false, 'node server.js'],
        ['t1', 2, true, 'top'],
    ]);

    const reading: ConnectorActivityHandle = feed.begin(
        source(ConnectorHostTool.ProcessRead, { processId: 'p1' }),
    );
    expect(feed.snapshot().running[0]?.subject).toBe('node server.js');
    reading.finish(true, JSON.stringify({ processId: 'p1', running: true }));
    feed.begin(source(ConnectorHostTool.ProcessRead, { processId: 'p1' })).finish(
        true,
        JSON.stringify({ processId: 'other', running: false }),
    );
    feed.begin(source(ConnectorHostTool.ProcessRead, { processId: 'p1' })).finish(true, '{broken');
    feed.begin(source(ConnectorHostTool.TerminalStop, { processId: 't1' })).finish(false, null);
    expect(
        feed.snapshot().programs.map((program: ConnectorActivityProgram): string => program.id),
    ).toEqual(['p1', 't1']);

    feed.begin(source(ConnectorHostTool.TerminalStop, { processId: 't1' })).finish(
        true,
        '{"stopped":true}',
    );
    feed.begin(source(ConnectorHostTool.ProcessRead, { processId: 'p1' })).finish(
        true,
        JSON.stringify({ processId: 'p1', running: false, exitCode: 0 }),
    );
    expect(feed.snapshot().programs).toEqual([]);

    feed.begin(source(ConnectorHostTool.TerminalStart, { executable: 'htop' })).finish(
        true,
        JSON.stringify({ processId: 't2', running: true }),
    );
    feed.begin(source(ConnectorHostTool.TerminalRead, { processId: 't2' })).finish(
        true,
        JSON.stringify({ processId: 't2', running: false }),
    );
    feed.begin(source(ConnectorHostTool.ProcessStart, { executable: 'sleep' })).finish(
        true,
        JSON.stringify({ processId: 'p3', running: true }),
    );
    const typing: ConnectorActivityHandle = feed.begin(
        source(ConnectorHostTool.ProcessWrite, {
            processId: 'p3',
            data: 'hidden',
            encoding: 'utf8',
        }),
    );
    expect(feed.snapshot().running[0]?.subject).toBe('sleep');
    typing.finish(true, '{"accepted":true}');
    feed.begin(source(ConnectorHostTool.ProcessRelease, { processId: 'p3' })).finish(
        true,
        '{"released":true}',
    );
    expect(feed.snapshot().programs).toEqual([]);
});

it('keeps at most the newest 64 background programs', (): void => {
    const feed: ConnectorActivityFeed = new ConnectorActivityFeed();
    for (let index: number = 0; index < ConnectorActivityFeed.programLimit + 6; index++) {
        feed.begin(source(ConnectorHostTool.ProcessStart, { executable: `tool-${index}` })).finish(
            true,
            JSON.stringify({ processId: `p${index}`, running: true }),
        );
    }
    const programs: readonly ConnectorActivityProgram[] = feed.snapshot().programs;
    expect(programs).toHaveLength(ConnectorActivityFeed.programLimit);
    expect(programs[0]?.id).toBe('p6');
    expect(programs.at(-1)?.id).toBe(`p${ConnectorActivityFeed.programLimit + 5}`);
});

it('isolates listener failures from the lane and coalesces each burst into one notification', async (): Promise<void> => {
    const feed: ConnectorActivityFeed = new ConnectorActivityFeed();
    let calls: number = 0;
    let seen: number = -1;
    const failure: Error = new Error('screen failed');
    feed.subscribe((): void => {
        throw failure;
    });
    const stop: () => void = feed.subscribe((): void => {
        calls += 1;
        seen = feed.snapshot().total;
    });
    feed.subscribe((): void => {
        throw 'not an error';
    });
    const handle: ConnectorActivityHandle = feed.begin(
        source(ConnectorHostTool.FileRead, { path: 'a' }),
    );
    expect((): void => {
        feed.begin(source(ConnectorHostTool.FileRead, { path: 'b' })).finish(true, null);
    }).not.toThrow();
    expect(calls).toBe(0);
    await settle();
    expect(calls).toBe(1);
    expect(seen).toBe(2);
    expect(feed.listenerFailure?.message).toBe('Activity listener failed');
    expect(feed.listenerFailure?.cause).toBe('not an error');
    expect((): void => {
        handle.finish(true, null);
    }).not.toThrow();
    await settle();
    expect(calls).toBe(2);
    stop();
    feed.begin(source(ConnectorHostTool.FileRead, { path: 'c' })).finish(true, null);
    await settle();
    expect(calls).toBe(2);
    expect(feed.snapshot().recent).toHaveLength(3);
});

it('projects folder and command lane requests without file bytes', (): void => {
    const write: ConnectorActivitySource = ConnectorActivityLane.folder('job-f', {
        action: ConnectorFileAction.Write,
        requestId: 'request',
        policySha256: 'a'.repeat(64),
        rootId: 'docs',
        path: 'plan.md',
        mode: ConnectorWriteMode.Replace,
        dataBase64: Buffer.from('private words').toString('base64'),
    });
    expect(write.toolName).toBe(ConnectorActivityLaneOperation.FolderWrite);
    expect(write.argumentsJson).not.toContain(Buffer.from('private words').toString('base64'));
    const feed: ConnectorActivityFeed = new ConnectorActivityFeed();
    feed.begin(write).finish(true, null);
    feed.begin(
        ConnectorActivityLane.folder('job-f', {
            action: ConnectorFileAction.Rename,
            requestId: 'request',
            policySha256: 'a'.repeat(64),
            rootId: 'docs',
            path: 'old.md',
            destination: 'new.md',
            mode: ConnectorWriteMode.Create,
        }),
    ).finish(true, null);
    feed.begin(
        ConnectorActivityLane.folder('job-f', {
            action: ConnectorFileAction.List,
            requestId: 'request',
            policySha256: 'a'.repeat(64),
            rootId: 'docs',
            path: '.',
            cursor: 0n,
        }),
    ).finish(true, null);
    feed.begin(ConnectorActivityLane.command(dispatch('cargo', ['test', '--release']))).finish(
        false,
        null,
    );
    feed.begin(ConnectorActivityLane.commandStop(dispatch('cargo', ['test']))).finish(true, null);
    const recent: readonly ConnectorActivityEntry[] = feed.snapshot().recent;
    expect(
        recent.map((entry: ConnectorActivityEntry): readonly [string, string, string] => [
            entry.kind,
            entry.title,
            entry.subject,
        ]),
    ).toEqual([
        [ConnectorActivityKind.RunCommand, 'Stopping a program', 'cargo test'],
        [ConnectorActivityKind.RunCommand, 'Running a program', 'cargo test --release'],
        [ConnectorActivityKind.ReadFile, 'Listing a folder', 'docs'],
        [ConnectorActivityKind.ChangeFile, 'Renaming a file', 'docs/old.md → docs/new.md'],
        [ConnectorActivityKind.ChangeFile, 'Changing a file', 'docs/plan.md'],
    ]);
    expect(recent.map((entry: ConnectorActivityEntry): number => entry.agent)).toEqual([
        2, 2, 1, 1, 1,
    ]);
});
