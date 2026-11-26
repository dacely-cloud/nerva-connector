// SPDX-FileCopyrightText: 2026 Dacely <business@dacely.com>
// SPDX-License-Identifier: LicenseRef-Proprietary

import { expect, it, vi } from 'vitest';
import { ExecutionOutputCapture } from '../src/execution/ExecutionOutputCapture.js';
import type { ExecutionOutput } from 'nerva-connector-protocol/execution/ExecutionOutput.js';
import { ExecutionOutputRetentionError } from '../src/execution/ExecutionOutputRetentionError.js';

it('coalesces pipe activity into one owned write and joins the final binary tail without a backlog', async (): Promise<void> => {
    vi.useFakeTimers();
    try {
        let current: ExecutionOutput = { stdoutBase64: 'AA==', stderrBase64: '' };
        const saved: ExecutionOutput[] = [];
        const release: PromiseWithResolvers<undefined> = Promise.withResolvers<undefined>();
        const capture: ExecutionOutputCapture = new ExecutionOutputCapture(
            {
                retain: async (output: ExecutionOutput): Promise<void> => {
                    saved.push(output);
                    if (saved.length === 1) {
                        await release.promise;
                    }
                },
            },
            (): ExecutionOutput => current,
            (): void => {
                throw new Error('Unexpected retention failure');
            },
        );
        for (let index: number = 0; index < 1000; index++) {
            capture.changed();
        }
        await vi.advanceTimersByTimeAsync(249);
        expect(saved).toHaveLength(0);
        await vi.advanceTimersByTimeAsync(1);
        expect(saved).toEqual([current]);
        current = { stdoutBase64: 'AP8=', stderrBase64: '77u/AA==' };
        for (let index: number = 0; index < 1000; index++) {
            capture.changed();
        }
        await vi.advanceTimersByTimeAsync(2000);
        expect(saved).toHaveLength(1);
        let finished: boolean = false;
        const joined: Promise<void> = (async (): Promise<void> => {
            await capture.finish();
            finished = true;
        })();
        await Promise.resolve();
        expect(finished).toBe(false);
        release.resolve(undefined);
        await joined;
        expect(saved).toEqual([{ stdoutBase64: 'AA==', stderrBase64: '' }, current]);
        capture.changed();
        await vi.advanceTimersByTimeAsync(1000);
        expect(saved).toHaveLength(2);
        expect(vi.getTimerCount()).toBe(0);
    } finally {
        vi.useRealTimers();
    }
});

it('an empty readiness notification cannot block later output or retain setup diagnostics', async (): Promise<void> => {
    vi.useFakeTimers();
    try {
        let current: ExecutionOutput = { stdoutBase64: '', stderrBase64: '' };
        const saved: ExecutionOutput[] = [];
        const capture: ExecutionOutputCapture = new ExecutionOutputCapture(
            {
                retain: (output: ExecutionOutput): Promise<void> => {
                    saved.push(output);
                    return Promise.resolve();
                },
            },
            (): ExecutionOutput => current,
            (): void => {
                throw new Error('Unexpected retention failure');
            },
        );
        capture.changed();
        await vi.advanceTimersByTimeAsync(250);
        expect(saved).toHaveLength(0);
        current = { stdoutBase64: 'AA==', stderrBase64: '' };
        capture.changed();
        await vi.advanceTimersByTimeAsync(250);
        expect(saved).toEqual([current]);
        await capture.finish();
        expect(vi.getTimerCount()).toBe(0);
    } finally {
        vi.useRealTimers();
    }
});

it('durability failure stops native work once and is joined rather than converted to empty success', async (): Promise<void> => {
    vi.useFakeTimers();
    try {
        let stopped: number = 0;
        let attempts: number = 0;
        const capture: ExecutionOutputCapture = new ExecutionOutputCapture(
            {
                retain: (_output: ExecutionOutput): Promise<void> => {
                    attempts++;
                    return Promise.reject(new Error('Owned storage failed'));
                },
            },
            (): ExecutionOutput => ({ stdoutBase64: 'AA==', stderrBase64: '' }),
            (): void => {
                stopped++;
            },
        );
        capture.changed();
        await vi.advanceTimersByTimeAsync(250);
        expect(stopped).toBe(1);
        capture.changed();
        await expect(capture.finish()).rejects.toBeInstanceOf(ExecutionOutputRetentionError);
        await vi.advanceTimersByTimeAsync(1000);
        expect(attempts).toBe(1);
        expect(vi.getTimerCount()).toBe(0);
    } finally {
        vi.useRealTimers();
    }
});
