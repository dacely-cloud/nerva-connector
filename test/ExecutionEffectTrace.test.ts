// SPDX-FileCopyrightText: 2026 Dacely <business@dacely.com>
// SPDX-License-Identifier: LicenseRef-Proprietary

import { spawn, type ChildProcess } from 'node:child_process';
import { expect, it } from 'vitest';
import {
    ExecutionEffectTrace,
    ExecutionTraceErrno,
    ExecutionTraceStderr,
} from './support/ExecutionEffectTrace.js';

/** Every real local child is bounded and joined; the observer owns no process signal or stream control. */
async function child(file: string, arguments_: readonly string[]): Promise<ChildProcess> {
    const process_: ChildProcess = spawn(file, arguments_, {
        timeout: 2000,
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    const done: PromiseWithResolvers<undefined> = Promise.withResolvers<undefined>();
    process_.once('error', (): void => {});
    process_.once('close', (): void => {
        done.resolve(undefined);
    });
    await done.promise;
    return process_;
}
it('passive launch observation preserves actual output and removes its own listeners', async (): Promise<void> => {
    using trace: ExecutionEffectTrace = new ExecutionEffectTrace();
    const process_: ChildProcess = await child('/bin/echo', ['--launch']);
    expect(trace.snapshot()).toMatchObject({
        observed: true,
        spawned: true,
        exitCode: 0,
        stdoutSeen: true,
        stderrClass: ExecutionTraceStderr.None,
        truncated: false,
    });
    expect(process_.listenerCount('spawn')).toBe(0);
    expect(process_.listenerCount('close')).toBe(0);
});
it('native spawn failures project only the allowlisted errno, and unrelated commands stay unobserved', async (): Promise<void> => {
    using unrelated: ExecutionEffectTrace = new ExecutionEffectTrace();
    await child('/bin/echo', ['not-the-launch-mode']);
    expect(unrelated.snapshot().observed).toBe(false);
    using trace: ExecutionEffectTrace = new ExecutionEffectTrace();
    await child('/nerva-fixed-nonexistent-qualification-helper', ['--launch']);
    expect(trace.snapshot()).toMatchObject({
        observed: true,
        spawned: false,
        spawnError: ExecutionTraceErrno.Missing,
    });
});
it('actual stderr is classified privately and never exposes its executable path or raw diagnostic', async (): Promise<void> => {
    using trace: ExecutionEffectTrace = new ExecutionEffectTrace();
    await child(process.execPath, ['--launch']);
    expect(trace.snapshot().stderrBytes).toBeGreaterThan(0);
    expect(trace.snapshot().stderrClass).toBe(ExecutionTraceStderr.Other);
    const output: string = JSON.stringify(trace.snapshot());
    expect(output).not.toContain(process.execPath);
    expect(output).not.toContain('bad option');
});
