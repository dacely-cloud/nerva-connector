// SPDX-FileCopyrightText: 2026 Dacely <business@dacely.com>
// SPDX-License-Identifier: LicenseRef-Proprietary

import { existsSync } from 'node:fs';
import { afterEach, expect, it, vi, type MockInstance } from 'vitest';
import { HostWorkspaceFixture as Fixture } from './support/HostWorkspaceFixture.js';
import {
    HostReadObservationKind as Kind,
    type HostReadObservationSource,
    type HostReadObservationState,
} from '../src/host/HostReadObservation.js';
import { HostProcess } from '../src/host/HostProcess.js';
import { HostTerminal } from '../src/host/HostTerminal.js';
import { HostLinuxBuild } from '../src/host/HostLinuxBuild.js';
import {
    HostOperation,
    type HostProcessRequest,
    type HostProcessSnapshot,
} from '../src/host/HostWorkspaceTypes.js';
import type { HostTerminalRequest, HostTerminalSnapshot } from '../src/host/HostTerminalTypes.js';

afterEach((): void => {
    vi.restoreAllMocks();
});

/** The real fixture child echoes exact bytes without involving a shell or a remote host. */
function request(): HostProcessRequest {
    return {
        executable: process.execPath,
        arguments: [
            '-e',
            "process.stdin.on('data', b => { process.stdout.write(b); process.stderr.write(b); });",
        ],
        shell: null,
        command: null,
        directory: null,
        environment: {},
        timeoutMs: 10000,
    };
}

/** A revision is captured before each native read; changes during the read cannot be lost by the subsequent wait. */
async function processOutput(
    fixture: Fixture,
    source: HostReadObservationSource,
    complete: boolean,
    bytes: bigint,
): Promise<HostProcessSnapshot> {
    const deadline: AbortController = new AbortController();
    const timer: NodeJS.Timeout = setTimeout(
        (): void => deadline.abort(new Error('Local process fixture observation timed out')),
        5000,
    );
    try {
        for (;;) {
            const revision: bigint = source.state().revision;
            const snapshot: HostProcessSnapshot = await fixture.host.output(
                source.state().processId,
                0n,
                0n,
                32768,
            );
            if (
                snapshot.stdout.endOffset === bytes &&
                snapshot.stderr.endOffset === bytes &&
                (!complete || snapshot.outputComplete)
            ) {
                return snapshot;
            }
            await source.wait(revision, deadline.signal, 5000);
        }
    } finally {
        clearTimeout(timer);
    }
}

it('wakes exact process observers without consuming bytes or blocking input, then preserves native EOF and release semantics', async (): Promise<void> => {
    await using fixture: Fixture = await Fixture.create();
    const started: HostProcessSnapshot = await fixture.host.start(request());
    const source: HostReadObservationSource = await fixture.host.observe(started.processId);
    const metadata: HostReadObservationState = source.state();
    expect(metadata).toMatchObject({ processId: started.processId, kind: Kind.Process });
    expect(fixture.checks.at(-1)).toMatchObject({
        operation: HostOperation.Output,
        processId: started.processId,
    });
    const controllers: readonly AbortController[] = Array.from(
        { length: 32 },
        (): AbortController => new AbortController(),
    );
    const pending: readonly Promise<HostReadObservationState>[] = controllers.map(
        (controller: AbortController): Promise<HostReadObservationState> =>
            source.wait(metadata.revision, controller.signal, 5000),
    );
    const data: Buffer = Buffer.from([0, 255, 65, 13, 10, 195, 169]);
    await fixture.host.input(started.processId, data, false);
    expect(
        (await Promise.all(pending)).every(
            (state: HostReadObservationState): boolean => state.revision > metadata.revision,
        ),
    ).toBe(true);
    const snapshot: HostProcessSnapshot = await processOutput(
        fixture,
        source,
        false,
        BigInt(data.length),
    );
    expect(snapshot.stdout.bytes).toEqual(data);
    expect(snapshot.stderr.bytes).toEqual(data);
    expect(snapshot.stdout).toMatchObject({
        offset: 0n,
        nextOffset: BigInt(data.length),
        truncated: false,
    });
    expect(snapshot.stderr.truncated).toBe(false);
    expect(snapshot.running).toBe(true);
    expect(snapshot.outputComplete).toBe(false);
    await fixture.host.input(started.processId, Buffer.alloc(0), true);
    const completed: HostProcessSnapshot = await processOutput(
        fixture,
        source,
        true,
        BigInt(data.length),
    );
    expect(completed.running).toBe(false);
    expect(completed.exitCode).toBe(0);
    expect(completed.stdoutFinalBytes).toBe(BigInt(data.length));
    expect(completed.stderrFinalBytes).toBe(BigInt(data.length));
    expect(completed.treeRunning).toBe(process.platform === 'win32' ? false : null);
    const revision: bigint = source.state().revision;
    expect(await fixture.host.output(started.processId, 0n, 0n, 32768)).toEqual(completed);
    expect(source.state().revision).toBe(revision);
    await fixture.host.release(started.processId);
    expect((): HostReadObservationState => source.state()).toThrow('unavailable');
    await expect(fixture.host.observe(started.processId)).rejects.toThrow('unavailable');
});

it('authorizes captures and byte reads against the exact local grant instead of exposing another family or unknown ID', async (): Promise<void> => {
    await using fixture: Fixture = await Fixture.create();
    const started: HostProcessSnapshot = await fixture.host.start(request());
    await expect(fixture.host.terminals.observe(started.processId)).rejects.toThrow('unavailable');
    await expect(fixture.host.observe('unknown-process')).rejects.toThrow('unavailable');
    fixture.allowed = false;
    await expect(fixture.host.observe(started.processId)).rejects.toThrow('revoked');
    await expect(fixture.host.output(started.processId, 0n, 0n, 32)).rejects.toThrow('revoked');
    fixture.allowed = true;
});

it('retains the same observation cell after uncertain cleanup and never turns failure into false quiescence', async (): Promise<void> => {
    await using fixture: Fixture = await Fixture.create();
    const started: HostProcessSnapshot = await fixture.host.start(request());
    const source: HostReadObservationSource = await fixture.host.observe(started.processId);
    const before: HostReadObservationState = source.state();
    const stop: MockInstance<HostProcess['stop']> = vi
        .spyOn(HostProcess.prototype, 'stop')
        .mockRejectedValue(new Error('native cleanup unconfirmed'));
    try {
        await expect(fixture.host.release(started.processId)).rejects.toThrow(
            'cleanup unconfirmed',
        );
        expect(source.state()).toEqual(before);
        expect((await fixture.host.output(started.processId, 0n, 0n, 32)).running).toBe(true);
    } finally {
        stop.mockRestore();
    }
    await fixture.host.release(started.processId);
    expect((): HostReadObservationState => source.state()).toThrow('unavailable');
});

it('joins pending workspace metadata waits on shutdown and uses a new runtime pin after replacement', async (): Promise<void> => {
    await using fixture: Fixture = await Fixture.create();
    await using replacement: Fixture = await Fixture.create();
    const started: HostProcessSnapshot = await fixture.host.start(request());
    const source: HostReadObservationSource = await fixture.host.observe(started.processId);
    const state: HostReadObservationState = source.state();
    const pending: Promise<HostReadObservationState> = source.wait(
        state.revision,
        new AbortController().signal,
    );
    const rejected: Promise<void> = expect(pending).rejects.toThrow('unavailable');
    await fixture.host[Symbol.asyncDispose]();
    await rejected;
    const next: HostProcessSnapshot = await replacement.host.start(request());
    const other: HostReadObservationSource = await replacement.host.observe(next.processId);
    expect(other.state().runtimeId).not.toBe(state.runtimeId);
    expect(other.state().processId).not.toBe(state.processId);
    expect((): HostReadObservationState => source.state()).toThrow('unavailable');
});

const nativeTerminal: boolean =
    process.platform === 'linux' &&
    existsSync(HostLinuxBuild.executable()) &&
    existsSync(new URL('../build/nerva-connector-exec.json', import.meta.url));

it.skipIf(!nativeTerminal)(
    'terminal-pool shutdown invalidates and joins hints even when native cleanup remains uncertain',
    async (): Promise<void> => {
        await using fixture: Fixture = await Fixture.create();
        const terminalRequest: HostTerminalRequest = {
            executable: '/usr/bin/python3',
            arguments: ['-I', '-B', '-c', 'import time; time.sleep(30)'],
            shell: null,
            command: null,
            directory: null,
            environment: {},
            timeoutMs: 10000,
            cols: 80,
            rows: 24,
        };
        const terminal: HostTerminalSnapshot = await fixture.host.terminals.start(terminalRequest);
        const source: HostReadObservationSource = await fixture.host.terminals.observe(
            terminal.processId,
        );
        const pending: Promise<HostReadObservationState> = source.wait(
            source.state().revision,
            new AbortController().signal,
        );
        const rejected: Promise<void> = expect(pending).rejects.toThrow('unavailable');
        const stop: MockInstance<HostTerminal['stop']> = vi
            .spyOn(HostTerminal.prototype, 'stop')
            .mockRejectedValue(new Error('native cleanup unconfirmed'));
        try {
            await expect(fixture.host.terminals[Symbol.asyncDispose]()).rejects.toThrow(
                'could not all be released',
            );
            await rejected;
            expect(fixture.host.terminals.size).toBe(1);
            expect((): HostReadObservationState => source.state()).toThrow('unavailable');
        } finally {
            stop.mockRestore();
        }
    },
);

it.skipIf(!nativeTerminal)(
    'observes the actual native terminal output owner with unchanged binary data, EOF totals and workspace identity',
    async (): Promise<void> => {
        await using fixture: Fixture = await Fixture.create();
        const pipe: HostProcessSnapshot = await fixture.host.start(request());
        const processSource: HostReadObservationSource = await fixture.host.observe(pipe.processId);
        const terminalRequest: HostTerminalRequest = {
            executable: '/usr/bin/python3',
            arguments: [
                '-I',
                '-B',
                '-c',
                "import os,tty; tty.setraw(0); os.write(1,b'READY'); b=os.read(0,7); os.write(1,b)",
            ],
            shell: null,
            command: null,
            directory: null,
            environment: {},
            timeoutMs: 10000,
            cols: 80,
            rows: 24,
        };
        const started: HostTerminalSnapshot = await fixture.host.terminals.start(terminalRequest);
        const source: HostReadObservationSource = await fixture.host.terminals.observe(
            started.processId,
        );
        expect(source.state().runtimeId).toBe(processSource.state().runtimeId);
        expect(source.state().kind).toBe(Kind.Terminal);
        await expect(fixture.host.observe(started.processId)).rejects.toThrow('unavailable');
        const deadline: AbortController = new AbortController();
        const timer: NodeJS.Timeout = setTimeout(
            (): void => deadline.abort(new Error('Local terminal fixture timed out')),
            5000,
        );
        try {
            for (;;) {
                const revision: bigint = source.state().revision;
                const state: HostTerminalSnapshot = await fixture.host.terminals.output(
                    started.processId,
                    0n,
                    32768,
                );
                if (state.output.bytes.toString() === 'READY') {
                    break;
                }
                await source.wait(revision, deadline.signal, 5000);
            }
            const bytes: Buffer = Buffer.from([0, 255, 65, 13, 10, 195, 169]);
            const revision: bigint = source.state().revision;
            const changed: Promise<HostReadObservationState> = source.wait(
                revision,
                deadline.signal,
                5000,
            );
            await fixture.host.terminals.input(started.processId, bytes);
            expect((await changed).revision).toBeGreaterThan(revision);
            for (;;) {
                const beforeRead: bigint = source.state().revision;
                const state: HostTerminalSnapshot = await fixture.host.terminals.output(
                    started.processId,
                    0n,
                    32768,
                );
                if (state.outputComplete) {
                    expect(state.running).toBe(false);
                    expect(state.treeRunning).toBeNull();
                    expect(state.exitCode).toBe(0);
                    expect(state.finalOutputBytes).toBe(12n);
                    expect(state.output.bytes).toEqual(
                        Buffer.concat([Buffer.from('READY'), bytes]),
                    );
                    expect(state.output.truncated).toBe(false);
                    break;
                }
                await source.wait(beforeRead, deadline.signal, 5000);
            }
            await fixture.host.terminals.release(started.processId);
            expect((): HostReadObservationState => source.state()).toThrow('unavailable');
        } finally {
            clearTimeout(timer);
        }
    },
);
