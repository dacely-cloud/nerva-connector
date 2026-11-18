// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

import { setImmediate } from 'node:timers/promises';
import { expect, it, vi } from 'vitest';
import { HostProcessStartup } from '../src/host/HostProcessStartup.js';
import { HostOperationError } from '../src/host/HostOperationError.js';
import { HostProcessWindowsProtocol } from '../src/host/HostProcessWindowsProtocol.js';
import { ConnectorHostFailure } from '../src/runtime/ConnectorHostFailure.js';
import {
    ConnectorHostErrorCode,
    ConnectorHostTool,
} from 'nerva-connector-protocol/protocol/ConnectorHost.js';

it('authenticated broker readiness alone never settles native creation', async (): Promise<void> => {
    const startup: HostProcessStartup = new HostProcessStartup(true);
    const waiting: Promise<void> = startup.wait();
    let finished: boolean = false;
    const observed: Promise<void> = (async (): Promise<void> => {
        await waiting;
        finished = true;
    })();
    await setImmediate();
    expect(finished).toBe(false);
    expect(startup.confirmed).toBe(false);
    startup.started();
    await observed;
    expect(startup.confirmed).toBe(true);
    expect((): void => startup.started()).toThrow('decision changed');
});

it('rejection before wait is immediately observed and retains the same definitive failure', async (): Promise<void> => {
    const unhandled: unknown[] = [];
    const record: (error: unknown) => void = (error: unknown): void => {
        unhandled.push(error);
    };
    process.on('unhandledRejection', record);
    try {
        const startup: HostProcessStartup = new HostProcessStartup(true);
        const error: HostOperationError = new HostOperationError(
            ConnectorHostErrorCode.NotFound,
            'Private Win32 2',
            true,
        );
        startup.failed(error);
        await setImmediate();
        await expect(startup.wait()).rejects.toBe(error);
        await setImmediate();
        expect(unhandled).toEqual([]);
        expect(ConnectorHostFailure.response(ConnectorHostTool.ProcessStart, error)).toEqual({
            outcome: 'failed',
            errorCode: 'not-found',
            resultJson: null,
        });
    } finally {
        process.off('unhandledRejection', record);
    }
});

it('native creation timeout stays indeterminate and cannot later become a new launch', async (): Promise<void> => {
    vi.useFakeTimers();
    try {
        const startup: HostProcessStartup = new HostProcessStartup(true);
        const waiting: Promise<PromiseSettledResult<void>[]> = Promise.allSettled([startup.wait()]);
        await vi.advanceTimersByTimeAsync(15000);
        const result: PromiseSettledResult<void> | undefined = (await waiting)[0];
        if (result === undefined || result.status !== 'rejected') {
            throw new Error('Expected an unconfirmed native launch');
        }
        expect(
            ConnectorHostFailure.response(ConnectorHostTool.ProcessStart, result.reason),
        ).toEqual({
            outcome: 'indeterminate',
            errorCode: 'operation-failed',
            resultJson: null,
        });
        expect((): void => startup.started()).toThrow('decision changed');
        expect(vi.getTimerCount()).toBe(0);
    } finally {
        vi.useRealTimers();
    }
});

it('launch decisions reject private diagnostics, unknown categories and unsafe native integers', (): void => {
    const token: string = '00000000-0000-0000-0000-000000000000';
    const valid: Readonly<Record<string, unknown>> = {
        token,
        kind: 'launch-rejected',
        errorCode: 'not-found',
        nativeError: 2,
    };
    expect(HostProcessWindowsProtocol.decode({ token, kind: 'started' }, token)).toEqual({
        kind: 'started',
    });
    expect(HostProcessWindowsProtocol.decode(valid, token)).toMatchObject({
        errorCode: 'not-found',
    });
    for (const raw of [
        { ...valid, errorCode: 'already-exists' },
        { ...valid, nativeError: -1 },
        { ...valid, nativeError: 1.5 },
        { ...valid, nativeError: 4294967296 },
        { ...valid, nativeError: undefined },
        { ...valid, diagnostic: 'private/path' },
        { ...valid, token: 'wrong' },
        { token, kind: 'started', nativeError: 0 },
    ]) {
        expect((): void => {
            HostProcessWindowsProtocol.decode(raw, token);
        }).toThrow();
    }
});
