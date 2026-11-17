// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

import { setTimeout } from 'node:timers/promises';
import { expect, it } from 'vitest';
import { HostProcessOutputState } from '../src/host/HostProcessOutputState.js';
import { HostProcessReportCodec, type HostProcessReport } from '../src/host/HostProcessReport.js';
import {
    HostWorkspaceLimits,
    type HostProcessRequest,
    type HostProcessSnapshot,
} from '../src/host/HostWorkspaceTypes.js';
import { HostWorkspaceFixture } from './support/HostWorkspaceFixture.js';

/** Run a real child without shell interpretation so byte totals can be checked exactly. */
function command(source: string): HostProcessRequest {
    return {
        executable: process.execPath,
        arguments: ['-e', source],
        shell: null,
        command: null,
        directory: null,
        environment: {},
        timeoutMs: 10000,
    };
}

/** Completion requires the same retained process and exact EOF totals, independently of initial target exit. */
async function completed(
    fixture: HostWorkspaceFixture,
    processId: string,
): Promise<HostProcessSnapshot> {
    for (let attempt: number = 0; attempt < 200; attempt += 1) {
        const result: HostProcessSnapshot = await fixture.host.output(
            processId,
            0n,
            0n,
            HostWorkspaceLimits.chunkBytes,
        );
        if (result.outputComplete) {
            return result;
        }
        await setTimeout(20);
    }
    throw new Error('Original host process output did not reach a verified EOF');
}

it('EOF report delivery before bytes never becomes premature output completion', (): void => {
    const state: HostProcessOutputState = new HostProcessOutputState();
    const report: HostProcessReport = {
        exitCode: 0,
        signal: null,
        launchFailed: false,
        treeRunning: null,
        stdoutFinalBytes: 3n,
        stderrFinalBytes: 2n,
    };
    state.accept(report);
    expect(state.complete).toBe(false);
    state.appendStderr(Buffer.from('xy'));
    expect(state.complete).toBe(false);
    state.appendStdout(Buffer.from('abc'));
    expect(state.complete).toBe(true);
    expect(state.stdout(0n, 3).bytes.toString()).toBe('abc');
    expect(state.stderr(0n, 2).bytes.toString()).toBe('xy');
    expect((): void => {
        state.accept({ ...report, stdoutFinalBytes: 4n });
    }).toThrow('EOF evidence changed');
    expect((): void => {
        state.accept({ ...report, exitCode: 7 });
    }).toThrow('exit observation changed');
    state.appendStdout(Buffer.from('unreported'));
    expect(state.complete).toBe(false);
});

it('private output reports reject missing, partial, rounded and out-of-range EOF evidence', (): void => {
    const valid: HostProcessReport = {
        exitCode: 0,
        signal: null,
        launchFailed: false,
        treeRunning: null,
        stdoutFinalBytes: 9007199254740993n,
        stderrFinalBytes: 0n,
    };
    expect(HostProcessReportCodec.decode(HostProcessReportCodec.encode(valid))).toEqual(valid);
    const base: Readonly<Record<string, unknown>> = {
        exitCode: 0,
        signal: null,
        launchFailed: false,
        treeRunning: null,
        stdoutFinalBytes: null,
        stderrFinalBytes: null,
    };
    for (const value of [
        { ...base, stdoutFinalBytes: '3' },
        { ...base, stdoutFinalBytes: 9007199254740992, stderrFinalBytes: '0' },
        { ...base, stdoutFinalBytes: '9223372036854775808', stderrFinalBytes: '0' },
        { exitCode: 0, signal: null, launchFailed: false },
    ]) {
        expect((): void => {
            HostProcessReportCodec.decode(value);
        }).toThrow();
    }
});

it('large output reports exact final totals and explicitly identifies overwritten bytes', async (): Promise<void> => {
    await using fixture: HostWorkspaceFixture = await HostWorkspaceFixture.create();
    const stdoutBytes: number = HostWorkspaceLimits.streamBytes + 17;
    const stderrBytes: number = 1024 * 1024 + 13;
    const started: HostProcessSnapshot = await fixture.host.start(
        command(
            'process.stdout.write(Buffer.alloc(' +
                stdoutBytes.toString() +
                ', 97)); process.stderr.write(Buffer.alloc(' +
                stderrBytes.toString() +
                ', 98));',
        ),
    );
    const result: HostProcessSnapshot = await completed(fixture, started.processId);
    expect(result.running).toBe(false);
    expect(result.exitCode).toBe(0);
    expect(result.stdoutFinalBytes).toBe(BigInt(stdoutBytes));
    expect(result.stderrFinalBytes).toBe(BigInt(stderrBytes));
    expect(result.stdout).toMatchObject({
        offset: 17n,
        endOffset: BigInt(stdoutBytes),
        truncated: true,
    });
    expect(result.stdout.bytes).toEqual(Buffer.alloc(HostWorkspaceLimits.chunkBytes, 97));
    expect(result.stderr.truncated).toBe(false);
    expect(result.stderr.bytes).toEqual(Buffer.alloc(HostWorkspaceLimits.chunkBytes, 98));
    const stderrTail: HostProcessSnapshot = await fixture.host.output(
        started.processId,
        result.stdout.nextOffset,
        result.stderr.nextOffset,
        HostWorkspaceLimits.chunkBytes,
    );
    expect(stderrTail.stderr.bytes).toEqual(Buffer.alloc(13, 98));
    expect(stderrTail.stderr.nextOffset).toBe(result.stderrFinalBytes);
});

it('descendant-held output stays incomplete after original exit and captures late bytes before EOF', async (): Promise<void> => {
    await using fixture: HostWorkspaceFixture = await HostWorkspaceFixture.create();
    const descendant: string = "setTimeout(() => process.stdout.write('late\\n'), 500)";
    const started: HostProcessSnapshot = await fixture.host.start(
        command(
            "const c = require('node:child_process').spawn(process.execPath, ['-e', " +
                JSON.stringify(descendant) +
                "], { stdio: 'inherit' }); process.stdout.write('early\\n'); c.unref();",
        ),
    );
    let exited: HostProcessSnapshot = await fixture.host.output(started.processId, 0n, 0n, 1024);
    for (let attempt: number = 0; exited.running && attempt < 100; attempt += 1) {
        await setTimeout(10);
        exited = await fixture.host.output(started.processId, 0n, 0n, 1024);
    }
    expect(exited.running).toBe(false);
    expect(exited.outputComplete).toBe(false);
    expect(exited.stdoutFinalBytes).toBeNull();
    const result: HostProcessSnapshot = await completed(fixture, started.processId);
    expect(result.stdout.bytes.toString()).toBe('early\nlate\n');
    expect(result.stdoutFinalBytes).toBe(11n);
    expect(result.stderrFinalBytes).toBe(0n);
});
