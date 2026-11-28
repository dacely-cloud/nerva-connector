// SPDX-FileCopyrightText: 2026 Dacely <business@dacely.com>
// SPDX-License-Identifier: LicenseRef-Proprietary

import { getEventListeners } from 'node:events';
import { afterEach, expect, it, vi } from 'vitest';
import { HostReadRevision } from '../src/host/HostReadRevision.js';
import {
    HostReadObservation,
    HostReadObservationKind as Kind,
    type HostReadObservationSource,
    type HostReadObservationState,
} from '../src/host/HostReadObservation.js';
import { HostProcessOutputState } from '../src/host/HostProcessOutputState.js';
import type { HostProcessReport } from '../src/host/HostProcessReport.js';

afterEach((): void => {
    vi.useRealTimers();
});

it('wakes on actual changes and remembers changes between revision capture and waiter registration', async (): Promise<void> => {
    using revision: HostReadRevision = new HostReadRevision();
    const controller: AbortController = new AbortController();
    expect(revision.current).toBe(0n);
    const pending: Promise<bigint> = revision.wait(0n, controller.signal);
    revision.advance();
    expect(await pending).toBe(1n);
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
    const beforeRead: bigint = revision.current;
    revision.advance();
    expect(await revision.wait(beforeRead, controller.signal)).toBe(2n);
    expect(revision.current).toBe(2n);
});

it('admits any number of waiters and reclaims listeners on cancellation, timeout and exact owner disposal', async (): Promise<void> => {
    vi.useFakeTimers();
    using revision: HostReadRevision = new HostReadRevision();
    const controllers: readonly AbortController[] = Array.from(
        { length: 48 },
        (): AbortController => new AbortController(),
    );
    const pending: readonly Promise<bigint>[] = controllers.map(
        (controller: AbortController): Promise<bigint> => revision.wait(0n, controller.signal),
    );
    const joined: Promise<readonly PromiseSettledResult<bigint>[]> = Promise.allSettled(pending);
    const first: AbortController | undefined = controllers[0];
    if (first === undefined) {
        throw new Error('Expected waiter');
    }
    first.abort(new Error('caller canceled'));
    await Promise.allSettled(pending.slice(0, 1));
    const deadline: AbortController = new AbortController();
    const timed: Promise<bigint> = revision.wait(0n, deadline.signal, 10);
    await vi.advanceTimersByTimeAsync(10);
    expect(await timed).toBe(0n);
    expect(getEventListeners(deadline.signal, 'abort')).toHaveLength(0);
    revision[Symbol.dispose]();
    expect(
        (await joined).every(
            (result: PromiseSettledResult<bigint>): boolean => result.status === 'rejected',
        ),
    ).toBe(true);
    expect(
        controllers.every(
            (controller: AbortController): boolean =>
                getEventListeners(controller.signal, 'abort').length === 0,
        ),
    ).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    expect((): bigint => revision.current).toThrow('unavailable');
    await expect(revision.wait(0n, deadline.signal)).rejects.toThrow('unavailable');
});

it('rejects future, negative and unbounded waits without retaining listeners', async (): Promise<void> => {
    using revision: HostReadRevision = new HostReadRevision();
    const controller: AbortController = new AbortController();
    for (const after of [-1n, 1n, 9223372036854775808n]) {
        await expect(revision.wait(after, controller.signal)).rejects.toThrow('Invalid');
    }
    for (const maximumMs of [0, -1, 0.5, 25001, Infinity, NaN]) {
        await expect(revision.wait(0n, controller.signal, maximumMs)).rejects.toThrow('Invalid');
    }
    controller.abort(new Error('canceled before registration'));
    await expect(revision.wait(0n, controller.signal)).rejects.toThrow('canceled before');
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
});

it('keeps exact rings and EOF/tree evidence unchanged while ignoring empty bytes, duplicate reports and reads', (): void => {
    using changes: HostReadRevision = new HostReadRevision();
    const output: HostProcessOutputState = new HostProcessOutputState(changes);
    output.appendStdout(Buffer.alloc(0));
    output.appendStderr(Buffer.alloc(0));
    expect(changes.current).toBe(0n);
    const exited: HostProcessReport = {
        exitCode: 0,
        signal: null,
        launchFailed: false,
        treeRunning: true,
        stdoutFinalBytes: null,
        stderrFinalBytes: null,
    };
    output.accept(exited);
    expect(changes.current).toBe(1n);
    output.accept(exited);
    expect(changes.current).toBe(1n);
    const eof: HostProcessReport = { ...exited, stdoutFinalBytes: 3n, stderrFinalBytes: 2n };
    output.accept(eof);
    expect(changes.current).toBe(2n);
    expect(output.complete).toBe(false);
    output.appendStdout(Buffer.from([0, 255, 1]));
    output.appendStderr(Buffer.from('xy'));
    expect(changes.current).toBe(4n);
    expect(output.complete).toBe(true);
    expect(output.stdout(0n, 3).bytes).toEqual(Buffer.from([0, 255, 1]));
    expect(output.stderr(0n, 2).bytes.toString()).toBe('xy');
    expect(changes.current).toBe(4n);
    output.accept({ ...eof, treeRunning: false });
    expect(changes.current).toBe(5n);
    expect((): void => output.accept(eof)).toThrow('quiescence');
    expect(changes.current).toBe(5n);
});

it('shares a bounded runtime across process families and never attaches a released source to another owner', async (): Promise<void> => {
    await using observations: HostReadObservation = new HostReadObservation();
    await using other: HostReadObservation = new HostReadObservation();
    using process: HostReadRevision = new HostReadRevision();
    using terminal: HostReadRevision = new HostReadRevision();
    const source: HostReadObservationSource = observations.capture(
        'process-one',
        Kind.Process,
        process,
    );
    const tty: HostReadObservationSource = observations.capture(
        'terminal-one',
        Kind.Terminal,
        terminal,
    );
    expect(source.state().runtimeId).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(tty.state().runtimeId).toBe(source.state().runtimeId);
    expect(other.capture('process-one', Kind.Process, process).state().runtimeId).not.toBe(
        source.state().runtimeId,
    );
    expect(tty.state().kind).toBe(Kind.Terminal);
    process[Symbol.dispose]();
    using replacement: HostReadRevision = new HostReadRevision();
    expect(observations.capture('process-one', Kind.Process, replacement).state().revision).toBe(
        0n,
    );
    expect((): bigint => source.state().revision).toThrow('unavailable');
});

it('returns an unchanged idle heartbeat with one native deadline and detaches it before returning', async (): Promise<void> => {
    vi.useFakeTimers();
    await using observations: HostReadObservation = new HostReadObservation();
    using revision: HostReadRevision = new HostReadRevision();
    const source: HostReadObservationSource = observations.capture(
        'idle-process',
        Kind.Process,
        revision,
    );
    const initial: HostReadObservationState = source.state();
    const controller: AbortController = new AbortController();
    const pending: Promise<HostReadObservationState> = source.wait(
        initial.revision,
        controller.signal,
        25,
    );
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(25);
    expect(await pending).toEqual(initial);
    expect(vi.getTimerCount()).toBe(0);
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
});

it('admits any number of workspace waiters and joins their cancellation before shutdown returns', async (): Promise<void> => {
    vi.useFakeTimers();
    await using observations: HostReadObservation = new HostReadObservation();
    const revisions: readonly HostReadRevision[] = Array.from(
        { length: 48 },
        (): HostReadRevision => new HostReadRevision(),
    );
    const controllers: readonly AbortController[] = revisions.map(
        (): AbortController => new AbortController(),
    );
    const pending: Promise<HostReadObservationState>[] = [];
    try {
        for (let index: number = 0; index < revisions.length; index++) {
            const revision: HostReadRevision | undefined = revisions[index];
            const controller: AbortController | undefined = controllers[index];
            if (revision === undefined || controller === undefined) {
                throw new Error('Missing waiter');
            }
            pending.push(
                observations
                    .capture('process-' + index.toString(), Kind.Process, revision)
                    .wait(0n, controller.signal),
            );
        }
        const joined: Promise<readonly PromiseSettledResult<Awaited<(typeof pending)[number]>>[]> =
            Promise.allSettled(pending);
        await observations[Symbol.asyncDispose]();
        expect((await joined).every((result): boolean => result.status === 'rejected')).toBe(true);
        expect(
            controllers.every(
                (controller: AbortController): boolean =>
                    getEventListeners(controller.signal, 'abort').length === 0,
            ),
        ).toBe(true);
        expect(vi.getTimerCount()).toBe(0);
    } finally {
        for (const revision of revisions) {
            revision[Symbol.dispose]();
        }
    }
});
