// SPDX-FileCopyrightText: 2026 Dacely <business@dacely.com>
// SPDX-License-Identifier: LicenseRef-Proprietary

import { setTimeout as delay } from 'node:timers/promises';
import { expect, it, vi, type MockInstance } from 'vitest';
import { HostProcess } from '../src/host/HostProcess.js';
import { HostProcessOutputState } from '../src/host/HostProcessOutputState.js';
import type { HostProcessReport } from '../src/host/HostProcessReport.js';
import { HostProcessWindowsProtocol } from '../src/host/HostProcessWindowsProtocol.js';
import { HostWindowsBuild } from '../src/host/HostWindowsBuild.js';
import { HostWorkspace } from '../src/host/HostWorkspace.js';
import {
    HostWorkspaceLimits,
    type HostProcessRequest,
    type HostProcessSnapshot,
} from '../src/host/HostWorkspaceTypes.js';
import { HostWorkspaceFixture } from './support/HostWorkspaceFixture.js';

/** The creation seam retains actual owned resources while its return is deliberately paused. */
interface LateProcessCapture {
    owner: HostProcess | null;
    cleanup: MockInstance<HostProcess[typeof Symbol.asyncDispose]> | null;
}

/** Independent finite programs exercise actual ownership and retained-cell behavior. */
function command(source: string, timeoutMs: number = 10000): HostProcessRequest {
    return {
        executable: process.execPath,
        arguments: ['-e', source],
        shell: null,
        command: null,
        directory: null,
        environment: {},
        timeoutMs,
    };
}

/** Polling never admits replacement work or mistakes root exit for descendant completion. */
async function rootExited(host: HostWorkspace, id: string): Promise<HostProcessSnapshot> {
    for (let attempt: number = 0; attempt < 200; attempt++) {
        const snapshot: HostProcessSnapshot = await host.output(id, 0n, 0n, 1024);
        if (!snapshot.running) {
            return snapshot;
        }
        await delay(20);
    }
    throw new Error('Owned root did not exit');
}

it('root exit and complete output remain independent from a still-running owned tree', (): void => {
    const state: HostProcessOutputState = new HostProcessOutputState();
    const root: HostProcessReport = {
        exitCode: 0,
        signal: null,
        launchFailed: false,
        treeRunning: true,
        stdoutFinalBytes: 3n,
        stderrFinalBytes: 0n,
    };
    state.accept(root);
    state.appendStdout(Buffer.from('gui'));
    expect(state.complete).toBe(true);
    state.accept({ ...root, treeRunning: false });
    expect(state.complete).toBe(true);
    expect((): void => {
        state.accept({ ...root, treeRunning: null });
    }).toThrow('tree quiescence');
    expect((): void => {
        state.accept({ ...root, treeRunning: true });
    }).toThrow('tree quiescence');
    expect((): void => {
        state.accept({ ...root, treeRunning: false, exitCode: 7 });
    }).toThrow('exit observation');
});

it('private Windows readiness and stop failure cannot substitute for authenticated tree and EOF reports', (): void => {
    const token: string = '12345678-1234-1234-1234-123456789abc';
    const report: Readonly<Record<string, unknown>> = {
        token,
        kind: 'report',
        exitCode: 0,
        signal: null,
        launchFailed: false,
        treeRunning: true,
        stdoutFinalBytes: '0',
        stderrFinalBytes: '0',
    };
    expect(HostProcessWindowsProtocol.decode({ token, kind: 'ready' }, token)).toEqual({
        kind: 'ready',
    });
    expect(HostProcessWindowsProtocol.decode({ token, kind: 'stop-failed' }, token)).toEqual({
        kind: 'stop-failed',
    });
    expect(HostProcessWindowsProtocol.decode(report, token)).toMatchObject({
        kind: 'report',
        report: { treeRunning: true, stdoutFinalBytes: 0n },
    });
    for (const invalid of [
        { ...report, token: 'untrusted' },
        { ...report, treeRunning: undefined },
        { ...report, treeRunning: 0 },
        { ...report, exitCode: null },
        { ...report, signal: 'SIGKILL' },
        { ...report, kind: 'ready' },
        { token, kind: 'stop-failed', treeRunning: false },
    ]) {
        expect((): void => {
            HostProcessWindowsProtocol.decode(invalid, token);
        }).toThrow();
    }
});

it('only an opted-in cell expires after its whole lifetime and retained-output deadline', async (): Promise<void> => {
    await using fixture: HostWorkspaceFixture = await HostWorkspaceFixture.create();
    const entered: PromiseWithResolvers<undefined> = Promise.withResolvers<undefined>();
    const allowed: PromiseWithResolvers<undefined> = Promise.withResolvers<undefined>();
    const joined: PromiseWithResolvers<undefined> = Promise.withResolvers<undefined>();
    const capture: LateProcessCapture = { owner: null, cleanup: null };
    const original: typeof HostProcess.create = HostProcess.create.bind(HostProcess);
    const create: MockInstance<typeof HostProcess.create> = vi
        .spyOn(HostProcess, 'create')
        .mockImplementation(
            async (...args: Parameters<typeof HostProcess.create>): Promise<HostProcess> => {
                const process: HostProcess = await original(...args);
                if (args[1].retentionAfterTimeoutMs !== undefined) {
                    capture.owner = process;
                    const dispose: () => Promise<void> = process[Symbol.asyncDispose].bind(process);
                    capture.cleanup = vi
                        .spyOn(process, Symbol.asyncDispose)
                        .mockImplementation(async (): Promise<void> => {
                            entered.resolve(undefined);
                            await allowed.promise;
                            try {
                                await dispose();
                            } finally {
                                joined.resolve(undefined);
                            }
                        });
                }
                return process;
            },
        );
    try {
        const retained: HostProcessSnapshot = await fixture.host.start(
            command('setInterval(()=>{},1000)', 50),
        );
        const expiring: HostProcessSnapshot = await fixture.host.start({
            ...command('setInterval(()=>{},1000)', 50),
            retentionAfterTimeoutMs: 1000,
        });
        await entered.promise;
        expect((await fixture.host.output(expiring.processId, 0n, 0n, 1)).processId).toBe(
            expiring.processId,
        );
        allowed.resolve(undefined);
        await joined.promise;
        let unavailable: boolean = false;
        for (let attempt: number = 0; attempt < 100 && !unavailable; attempt++) {
            try {
                await fixture.host.output(expiring.processId, 0n, 0n, 1);
            } catch (caught: unknown) {
                if (!(caught instanceof Error) || !caught.message.includes('unavailable')) {
                    throw caught;
                }
                unavailable = true;
            }
            if (!unavailable) {
                await delay(10);
            }
        }
        expect(unavailable).toBe(true);
        expect((await fixture.host.output(retained.processId, 0n, 0n, 1)).running).toBe(false);
        await fixture.host.release(retained.processId);
        for (const value of [0, 999, HostWorkspaceLimits.retentionAfterTimeoutMs + 1, Number.NaN]) {
            await expect(
                fixture.host.start({ ...command(''), retentionAfterTimeoutMs: value }),
            ).rejects.toMatchObject({
                message:
                    'Host launch retentionAfterTimeoutMs must be an integer from 1000 to 86400000',
                code: 'invalid-request',
                definitive: true,
            });
        }
    } finally {
        allowed.resolve(undefined);
        create.mockRestore();
        capture.cleanup?.mockRestore();
    }
});

it('a late-created owner with unconfirmed cleanup remains retained until a later close joins that exact process', async (): Promise<void> => {
    await using fixture: HostWorkspaceFixture = await HostWorkspaceFixture.create();
    const workspace: HostWorkspace = await HostWorkspace.create({
        directory: fixture.directory,
        authorization: fixture,
        windowsLauncher:
            process.platform === 'win32' ? await HostWindowsBuild.verifiedExecutable() : undefined,
    });
    const entered: PromiseWithResolvers<undefined> = Promise.withResolvers<undefined>();
    const admitted: PromiseWithResolvers<undefined> = Promise.withResolvers<undefined>();
    const original: typeof HostProcess.create = HostProcess.create.bind(HostProcess);
    const capture: LateProcessCapture = { owner: null, cleanup: null };
    const create: MockInstance<typeof HostProcess.create> = vi
        .spyOn(HostProcess, 'create')
        .mockImplementation(
            async (...args: Parameters<typeof HostProcess.create>): Promise<HostProcess> => {
                let process: HostProcess;
                try {
                    process = await original(...args);
                } catch (caught: unknown) {
                    entered.reject(caught);
                    throw caught;
                }
                capture.owner = process;
                const dispose: () => Promise<void> = process[Symbol.asyncDispose].bind(process);
                capture.cleanup = vi
                    .spyOn(process, Symbol.asyncDispose)
                    .mockRejectedValueOnce(new Error('tree shutdown unconfirmed'))
                    .mockImplementation(dispose);
                entered.resolve(undefined);
                await admitted.promise;
                return process;
            },
        );
    const starting: Promise<PromiseSettledResult<HostProcessSnapshot>[]> = Promise.allSettled([
        workspace.start(command('setInterval(()=>{},1000)')),
    ]);
    let closing: Promise<PromiseSettledResult<void>[]> | null = null;
    try {
        await entered.promise;
        closing = Promise.allSettled([workspace[Symbol.asyncDispose]()]);
        admitted.resolve(undefined);
        expect((await starting)[0].status).toBe('rejected');
        expect((await closing)[0].status).toBe('rejected');
        await workspace[Symbol.asyncDispose]();
        const process: HostProcess | null = capture.owner;
        if (process === null) {
            throw new Error('Expected an actual late-created process');
        }
        expect(process.snapshot(0n, 0n, 1).running).toBe(false);
    } finally {
        admitted.resolve(undefined);
        create.mockRestore();
        const dispose: MockInstance<HostProcess[typeof Symbol.asyncDispose]> | null =
            capture.cleanup;
        if (dispose !== null) {
            dispose.mockRestore();
        }
        await starting;
        if (closing !== null) {
            await closing;
        }
        await workspace[Symbol.asyncDispose]();
    }
});

/**
 * Windows launcher descendants are detached children.
 *
 * @remarks
 * Node's default Windows spawn also places the child in libuv's kill-on-close Job, which
 * terminates it when its parent exits; only a detached launcher descendant can outlive its root.
 */
it.skipIf(process.platform !== 'win32')(
    'Windows keeps a launcher-descendant job alive after root exit and observes its eventual empty state',
    async (): Promise<void> => {
        await using fixture: HostWorkspaceFixture = await HostWorkspaceFixture.create();
        const launched: HostProcessSnapshot = await fixture.host.start(
            command(
                "const child=require('node:child_process').spawn(process.execPath,['-e','setTimeout(()=>{},1200)'],{detached:true,stdio:'ignore'}); process.stdout.write(String(child.pid)); child.unref();",
            ),
        );
        const root: HostProcessSnapshot = await rootExited(fixture.host, launched.processId);
        expect(root.exitCode).toBe(0);
        expect(root.treeRunning).toBe(true);
        const pid: number = Number(root.stdout.bytes.toString());
        expect(Number.isSafeInteger(pid)).toBe(true);
        expect((): void => {
            process.kill(pid, 0);
        }).not.toThrow();
        let final: HostProcessSnapshot = root;
        for (let attempt: number = 0; attempt < 200 && final.treeRunning !== false; attempt++) {
            await delay(20);
            final = await fixture.host.output(launched.processId, 0n, 0n, 1024);
        }
        expect(final.treeRunning).toBe(false);
        expect(final.exitCode).toBe(0);
        await fixture.host.release(launched.processId);
    },
);

it.skipIf(process.platform !== 'win32')(
    'Windows stop confirms the remaining GUI-style descendant job is empty while preserving the root exit',
    async (): Promise<void> => {
        await using fixture: HostWorkspaceFixture = await HostWorkspaceFixture.create();
        const launched: HostProcessSnapshot = await fixture.host.start(
            command(
                "const child=require('node:child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'ignore'}); process.stdout.write(String(child.pid)); child.unref();",
            ),
        );
        const root: HostProcessSnapshot = await rootExited(fixture.host, launched.processId);
        expect(root.treeRunning).toBe(true);
        await fixture.host.stop(launched.processId);
        const final: HostProcessSnapshot = await fixture.host.output(
            launched.processId,
            0n,
            0n,
            1024,
        );
        expect(final.treeRunning).toBe(false);
        expect(final.exitCode).toBe(0);
        expect((): void => {
            process.kill(Number(root.stdout.bytes.toString()), 0);
        }).toThrow();
        await fixture.host.release(launched.processId);
    },
);
