// SPDX-FileCopyrightText: 2026 Dacely <business@dacely.com>
// SPDX-License-Identifier: LicenseRef-Proprietary

import { expect, it, vi, type MockInstance } from 'vitest';
import { ConnectorStartupDisplay } from '../src/cli/ConnectorStartupDisplay.js';
import { ConnectorStartupStage } from '../src/runtime/ConnectorStartup.js';

it.each([
    ConnectorStartupStage.Dns,
    ConnectorStartupStage.Tcp,
    ConnectorStartupStage.Tls,
    ConnectorStartupStage.Upgrade,
    ConnectorStartupStage.Authentication,
    ConnectorStartupStage.Confirmation,
])(
    'a two-minute wait at %s keeps its exact stage, moving bar and elapsed time',
    (stage: ConnectorStartupStage): void => {
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
        const lines: string[] = [];
        try {
            using display: ConnectorStartupDisplay = new ConnectorStartupDisplay(
                (text: string): void => {
                    lines.push(text);
                },
                true,
            );
            display.update({ stage });
            vi.advanceTimersByTime(120000);
            expect(lines.at(-1)).toBe('[==      ] ' + stage + ' · 120s · still waiting');
            expect(lines).toHaveLength(121);
            expect(new Set(lines.map((line: string): string => line.slice(0, 10))).size).toBe(7);
            expect(lines.every((line: string): boolean => /^\[ {0,6}== {0,6}\] /.test(line))).toBe(
                true,
            );
            expect(
                lines.every((line: string): boolean => line.includes(stage) && !line.includes('%')),
            ).toBe(true);
            display.update({ stage: ConnectorStartupStage.Ready });
            expect(lines.at(-1)).toBe('');
            expect(vi.getTimerCount()).toBe(0);
        } finally {
            vi.useRealTimers();
        }
    },
);

it('total connection time survives stage changes and retries until authenticated readiness', (): void => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    const lines: string[] = [];
    try {
        using display: ConnectorStartupDisplay = new ConnectorStartupDisplay(
            (text: string): void => {
                lines.push(text);
            },
            true,
        );
        display.update({ stage: ConnectorStartupStage.LocalSecurity });
        vi.advanceTimersByTime(2000);
        display.update({ stage: ConnectorStartupStage.Dns });
        vi.advanceTimersByTime(8000);
        display.update({ stage: ConnectorStartupStage.Rejected, httpStatus: 502 });
        display.update({ stage: ConnectorStartupStage.Closing });
        display.update({ stage: ConnectorStartupStage.Retry, retryAfterMs: 3000 });
        expect(lines.at(-1)).toContain('after: Server rejected tunnel (HTTP 502) · total 10s');
        vi.advanceTimersByTime(3000);
        display.update({ stage: ConnectorStartupStage.Confirmation });
        vi.advanceTimersByTime(107000);
        expect(lines.at(-1)).toContain(
            'Waiting for signed confirmation · 107s · attempt 2 · total 120s · still waiting',
        );
        display.update({ stage: ConnectorStartupStage.Ready });
        expect(lines.at(-1)).toBe('');
        expect(vi.getTimerCount()).toBe(0);
        vi.advanceTimersByTime(60000);
        display.update({ stage: ConnectorStartupStage.Dns });
        expect(lines.at(-1)).toBe('[==      ] Resolving server address · 0s');
        vi.advanceTimersByTime(5000);
        display.update({ stage: ConnectorStartupStage.LocalSecurity });
        expect(lines.at(-1)).toBe('[==      ] Checking secure local storage · 0s');
    } finally {
        vi.useRealTimers();
    }
});

it('waiting for user approval stays explicit without marking normal approval time as a stalled connection', (): void => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    const lines: string[] = [];
    try {
        using display: ConnectorStartupDisplay = new ConnectorStartupDisplay(
            (text: string): void => {
                lines.push(text);
            },
            false,
        );
        display.update({ stage: ConnectorStartupStage.Approval });
        vi.advanceTimersByTime(120000);
        expect(lines.at(-1)).toBe('Waiting for your approval · 120s');
    } finally {
        vi.useRealTimers();
    }
});

it('TTY stages show elapsed activity without resetting the clock on repeated notifications and release all timers', (): void => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    const lines: string[] = [];
    try {
        using display: ConnectorStartupDisplay = new ConnectorStartupDisplay(
            (text: string): void => {
                lines.push(text);
            },
            true,
        );
        display.update({ stage: ConnectorStartupStage.LocalSecurity });
        expect(lines.at(-1)).toContain('Checking secure local storage · 0s');
        vi.advanceTimersByTime(2000);
        display.update({ stage: ConnectorStartupStage.LocalSecurity });
        vi.advanceTimersByTime(1000);
        expect(lines.at(-1)).toContain('Checking secure local storage · 3s');
        expect(lines.at(-1)?.slice(0, 10)).not.toBe(lines[0]?.slice(0, 10));
        display.update({ stage: ConnectorStartupStage.Tls });
        expect(lines.at(-1)).toContain('Verifying TLS certificate · 0s');
        expect(vi.getTimerCount()).toBe(1);
        display.update({ stage: ConnectorStartupStage.Ready });
        expect(lines.at(-1)).toBe('');
        expect(vi.getTimerCount()).toBe(0);
        display.update({ stage: ConnectorStartupStage.Dns });
        expect(vi.getTimerCount()).toBe(1);
        display[Symbol.dispose]();
        const count: number = lines.length;
        vi.advanceTimersByTime(60000);
        display.update({ stage: ConnectorStartupStage.Tcp });
        expect(lines).toHaveLength(count);
        expect(vi.getTimerCount()).toBe(0);
    } finally {
        vi.useRealTimers();
    }
});

it('plain output is finite-rate and keeps its last real failed stage visible without a heartbeat', (): void => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    const lines: string[] = [];
    try {
        using display: ConnectorStartupDisplay = new ConnectorStartupDisplay(
            (text: string): void => {
                lines.push(text);
            },
            false,
        );
        display.update({ stage: ConnectorStartupStage.Identity });
        vi.advanceTimersByTime(9000);
        expect(lines).toHaveLength(1);
        vi.advanceTimersByTime(1000);
        expect(lines.at(-1)).toBe('Preparing device identity · 10s');
        display.pause();
        expect(vi.getTimerCount()).toBe(0);
        const count: number = lines.length;
        vi.advanceTimersByTime(60000);
        expect(lines).toHaveLength(count);
        expect(lines.every((line: string): boolean => !line.includes('%'))).toBe(true);
    } finally {
        vi.useRealTimers();
    }
});

it('retry countdowns distinguish the next attempt and retain it across actual transport phases', (): void => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    const lines: string[] = [];
    try {
        using display: ConnectorStartupDisplay = new ConnectorStartupDisplay(
            (text: string): void => {
                lines.push(text);
            },
            true,
        );
        display.update({ stage: ConnectorStartupStage.Retry, retryAfterMs: 3000 });
        expect(lines.at(-1)).toContain('attempt 2 · retry in 3s');
        vi.advanceTimersByTime(2000);
        expect(lines.at(-1)).toContain('retry in 1s');
        display.update({ stage: ConnectorStartupStage.Tcp });
        expect(lines.at(-1)).toContain('Connecting to server · 0s · attempt 2');
        display.update({ stage: ConnectorStartupStage.Retry, attempt: 3, retryAfterMs: 500 });
        expect(lines.at(-1)).toContain('attempt 3 · retry in 1s');
        display.update({ stage: ConnectorStartupStage.Stopped });
        expect(vi.getTimerCount()).toBe(0);
    } finally {
        vi.useRealTimers();
    }
});

it('a new phase owns its heartbeat clock instead of inheriting the previous stage interval', (): void => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    const lines: string[] = [];
    try {
        using display: ConnectorStartupDisplay = new ConnectorStartupDisplay(
            (text: string): void => {
                lines.push(text);
            },
            true,
        );
        display.update({ stage: ConnectorStartupStage.Dns });
        vi.advanceTimersByTime(750);
        display.update({ stage: ConnectorStartupStage.Upgrade });
        vi.advanceTimersByTime(1000);
        expect(lines.at(-1)).toContain('Opening secure tunnel · 1s');
        expect(vi.getTimerCount()).toBe(1);
    } finally {
        vi.useRealTimers();
    }
});

it('retry backoff retains the actual failed stage across socket cleanup, then replaces it on the next attempt', (): void => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    const lines: string[] = [];
    try {
        using display: ConnectorStartupDisplay = new ConnectorStartupDisplay(
            (text: string): void => {
                lines.push(text);
            },
            true,
        );
        display.update({ stage: ConnectorStartupStage.Confirmation });
        vi.advanceTimersByTime(120000);
        display.update({ stage: ConnectorStartupStage.Closing });
        display.update({ stage: ConnectorStartupStage.Retry, retryAfterMs: 3000 });
        expect(lines.at(-1)).toContain(
            'attempt 2 · retry in 3s · after: Waiting for signed confirmation',
        );
        vi.advanceTimersByTime(1000);
        display.update({ stage: ConnectorStartupStage.Retry, attempt: 2, retryAfterMs: 3000 });
        expect(lines.at(-1)).toContain('after: Waiting for signed confirmation');
        display.update({ stage: ConnectorStartupStage.Dns });
        expect(lines.at(-1)).not.toContain('after:');
        display.update({ stage: ConnectorStartupStage.Retry, retryAfterMs: 1000 });
        expect(lines.at(-1)).toContain('attempt 3 · retry in 1s · after: Resolving server address');
        display.update({ stage: ConnectorStartupStage.Ready });
        display.update({ stage: ConnectorStartupStage.Retry, retryAfterMs: 1000 });
        expect(lines.at(-1)).not.toContain('after:');
    } finally {
        vi.useRealTimers();
    }
});

it('an early native timer rechecks the next elapsed boundary instead of showing zero for another full second', (): void => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    let now: number = 0;
    const clock: MockInstance<typeof performance.now> = vi
        .spyOn(performance, 'now')
        .mockImplementation((): number => now);
    const lines: string[] = [];
    try {
        using display: ConnectorStartupDisplay = new ConnectorStartupDisplay(
            (text: string): void => {
                lines.push(text);
            },
            true,
        );
        display.update({ stage: ConnectorStartupStage.Upgrade });
        now = 999.5;
        vi.advanceTimersByTime(1000);
        expect(lines.at(-1)).toContain('Opening secure tunnel · 0s');
        now = 1000.5;
        vi.advanceTimersByTime(1);
        expect(lines.at(-1)).toContain('Opening secure tunnel · 1s');
        expect(vi.getTimerCount()).toBe(1);
        display.pause();
        expect(vi.getTimerCount()).toBe(0);
    } finally {
        clock.mockRestore();
        vi.useRealTimers();
    }
});
