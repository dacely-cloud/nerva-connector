// SPDX-FileCopyrightText: 2026 Dacely <business@dacely.com>
// SPDX-License-Identifier: LicenseRef-Proprietary

import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { ConnectorConnectionLog } from '../src/runtime/ConnectorConnectionLog.js';
import { ConnectorLogSummary } from '../src/cli/ConnectorLogSummary.js';

let directory: string = '';

beforeEach(async (): Promise<void> => {
    directory = await mkdtemp(join(tmpdir(), 'nerva-connector-log-'));
});

afterEach(async (): Promise<void> => {
    await rm(directory, { recursive: true, force: true });
});

it('writes one JSON line per event with control characters removed and long error text bounded', async (): Promise<void> => {
    const log: ConnectorConnectionLog = new ConnectorConnectionLog(
        join(directory, 'nested', 'connection.log'),
    );
    log.record('ending', {
        reason: 'host',
        error: ConnectorConnectionLog.error(new Error('Paired host\u0000 permit\u001b[31m denied')),
    });
    log.record('closed', { error: ConnectorConnectionLog.error(new Error('x'.repeat(5000))) });
    await log.flush();
    const lines: readonly Readonly<Record<string, unknown>>[] = await log.recent(5);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({ event: 'ending', reason: 'host' });
    expect(lines[0]?.['error']).not.toMatch(/[\p{Cc}\p{Cf}]/u);
    expect(lines[0]?.['error']).toContain('Paired host');
    expect(String(lines[1]?.['error']).length).toBeLessThanOrEqual(301);
    expect(ConnectorConnectionLog.error('not an error')).toBeNull();
    if (process.platform !== 'win32') {
        expect((await stat(log.path)).mode & 0o777).toBe(0o600);
        expect((await stat(join(directory, 'nested'))).mode & 0o777).toBe(0o700);
    }
});

it('describes a thrown error by name, message, errno code, system call and causes, cleaned and bounded', async (): Promise<void> => {
    const log: ConnectorConnectionLog = new ConnectorConnectionLog(
        join(directory, 'connection.log'),
    );
    const native: NodeJS.ErrnoException = new Error(
        "ENOENT: no such file or directory, lstat 'C:\\Users\\a\u001b[2Jb'",
    );
    native.code = 'ENOENT';
    native.syscall = 'lstat';
    const wrapped: Error = new Error('Host removal path could not be examined', { cause: native });
    wrapped.name = 'HostOperationError';
    log.record('host-operation-failed', {
        tool: 'file_remove',
        code: 'not-found',
        ...ConnectorConnectionLog.failure(wrapped),
    });
    log.record('host-operation-failed', {
        ...ConnectorConnectionLog.failure(
            new AggregateError(
                [new Error('x'.repeat(5000)), new TypeError('second')],
                'Terminal startup and owned cleanup are unconfirmed',
            ),
        ),
    });
    log.record('host-operation-failed', { ...ConnectorConnectionLog.failure('text') });
    const lines: readonly Readonly<Record<string, unknown>>[] = await log.recent(5);
    expect(lines[0]).toMatchObject({
        tool: 'file_remove',
        code: 'not-found',
        reason: 'Host removal path could not be examined',
        errorName: 'HostOperationError',
    });
    expect(lines[0]?.['cause']).toBe(
        "Error: ENOENT: no such file or directory, lstat 'C:\\Users\\a [2Jb' [ENOENT lstat]",
    );
    expect(lines[1]).toMatchObject({
        reason: 'Terminal startup and owned cleanup are unconfirmed',
        errorName: 'AggregateError',
    });
    expect(String(lines[1]?.['cause']).length).toBeLessThanOrEqual(301);
    expect(lines[2]).toEqual({
        time: lines[2]?.['time'],
        event: 'host-operation-failed',
        reason: 'A string was thrown instead of an error',
    });
    for (const line of lines) {
        expect(JSON.stringify(line)).not.toMatch(/\\u00[01]/u);
    }
});

it('rotates into a single predecessor so the log never holds more than two files', async (): Promise<void> => {
    const log: ConnectorConnectionLog = new ConnectorConnectionLog(
        join(directory, 'connection.log'),
    );
    const filler: string = 'y'.repeat(250);
    const count: number = Math.ceil((ConnectorConnectionLog.maximumBytes * 2.5) / 300);
    for (let index: number = 0; index < count; index++) {
        log.record('retry', { reason: filler, inMs: index });
    }
    await log.flush();
    expect((await stat(log.path)).size).toBeLessThanOrEqual(ConnectorConnectionLog.maximumBytes);
    expect((await stat(log.path + '.1')).size).toBeLessThanOrEqual(
        ConnectorConnectionLog.maximumBytes,
    );
    await expect(stat(log.path + '.2')).rejects.toThrow('ENOENT');
    const last: readonly Readonly<Record<string, unknown>>[] = await log.recent(1);
    expect(last[0]?.['inMs']).toBe(count - 1);
});

it('stops writing after a failed write instead of failing or delaying the connection', async (): Promise<void> => {
    const blocker: string = join(directory, 'file');
    const log: ConnectorConnectionLog = new ConnectorConnectionLog(join(blocker, 'connection.log'));
    await writeFile(blocker, 'not a directory');
    log.record('started');
    log.record('stopped');
    await expect(log.flush()).resolves.toBeUndefined();
    expect(await log.recent(5)).toEqual([]);
});

it('places the log in the per-user log directory of each platform', (): void => {
    expect(
        ConnectorConnectionLog.location(
            'win32',
            { LOCALAPPDATA: 'C:\\Users\\Ralph\\AppData\\Local' },
            'C:\\Users\\Ralph',
        ),
    ).toContain(join('Nerva Connector', 'Logs', 'connection.log'));
    expect(ConnectorConnectionLog.location('darwin', {}, '/Users/ralph')).toBe(
        join('/Users/ralph', 'Library', 'Logs', 'Nerva Connector', 'connection.log'),
    );
    expect(ConnectorConnectionLog.location('linux', { XDG_STATE_HOME: '/state' }, '/home/r')).toBe(
        join('/state', 'nerva-connector', 'connection.log'),
    );
    expect(
        ConnectorConnectionLog.location('linux', { XDG_STATE_HOME: 'relative' }, '/home/r'),
    ).toBe(join('/home/r', '.local', 'state', 'nerva-connector', 'connection.log'));
});

it('names a device with the same pseudonym the Nerva server journal logs', (): void => {
    expect(ConnectorConnectionLog.pseudonym('enr_8f2b8e0c4d1a', 0)).toBe('154dec8cfdf0');
    expect(ConnectorConnectionLog.pseudonym('enr_8f2b8e0c4d1a', 1)).not.toBe('154dec8cfdf0');
});

it('summarizes refusals, closes by Nerva and stalls for /log and skips routine or malformed lines', (): void => {
    const time: string = new Date().toISOString();
    const rows: readonly string[] = ConnectorLogSummary.rows(
        [
            { time, event: 'connecting', endpoint: 'nerva.example:443' },
            {
                time,
                event: 'ending',
                reason: 'host',
                frame: 'host-permit',
                error: 'Paired host permit denied',
            },
            { time, event: 'closed', reason: 'host', afterMs: 1040 },
            { time, event: 'closed', reason: 'closed', closeCode: 1006, afterMs: 900000 },
            { time, event: 'stall', blockedMs: 4200, after: 'signed-in' },
            { time, event: 'stall', blockedMs: 119047, cpuMs: 31, after: 'signed-in' },
            {
                time,
                event: 'host-consent-check-failed',
                check: 'unreadable',
                reason: 'Windows connector storage permissions could not be verified.',
                errorName: 'Error',
                errorCode: 'untrusted',
                storageCheck: 'connector-state/unexpected-permission',
            },
            { time: 'not a time', event: 'ending', reason: 'files' },
            { event: 'ending', reason: 'files' },
        ],
        10,
    );
    expect(rows).toHaveLength(5);
    expect(rows[0]).toContain('Disconnected: host (host-permit) · Paired host permit denied');
    expect(rows[1]).toContain(
        'Nerva or the network closed the connection (code 1006) after 900.0s',
    );
    expect(rows[2]).toContain('The connector was busy for 4.2s after signed-in');
    expect(rows[3]).toContain('The connector was paused for 119.0s after signed-in (0.0s of CPU)');
    expect(rows[4]).toContain(
        'Full-computer approval check: unreadable · Windows connector storage permissions could not be verified. [connector-state/unexpected-permission]',
    );
});

it('a stall line separates a computing event loop from one that was not running', async (): Promise<void> => {
    const log: ConnectorConnectionLog = new ConnectorConnectionLog(
        join(directory, 'connection.log'),
    );
    {
        using _stalls: Disposable = log.watchStalls();
        await delay(600);
        const started: number = performance.now();
        while (performance.now() - started < 2000) {
            Math.sqrt(started);
        }
        await delay(600);
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2000);
        await delay(600);
    }
    await log.flush();
    const stalls: readonly Readonly<Record<string, unknown>>[] = (await readFile(log.path, 'utf8'))
        .trim()
        .split('\n')
        .map((line: string): Readonly<Record<string, unknown>> => {
            const value: unknown = JSON.parse(line);
            if (typeof value !== 'object' || value === null) {
                throw new Error('Connection log line must be an object');
            }
            return Object.fromEntries(Object.entries(value));
        })
        .filter((line: Readonly<Record<string, unknown>>): boolean => line['event'] === 'stall');
    expect(stalls).toHaveLength(2);
    const [busy, paused]: readonly (Readonly<Record<string, unknown>> | undefined)[] = stalls;
    expect(busy?.['cpuMs']).toEqual(expect.any(Number));
    expect(Number(busy?.['cpuMs'])).toBeGreaterThan(Number(busy?.['blockedMs']) / 2);
    expect(Number(paused?.['cpuMs'])).toBeLessThan(Number(paused?.['blockedMs']) / 4);
}, 10000);
