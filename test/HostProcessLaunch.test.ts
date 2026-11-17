// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

import { writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { expect, it, vi, type MockInstance } from 'vitest';
import { HostProcess } from '../src/host/HostProcess.js';
import { HostOperationError } from '../src/host/HostOperationError.js';
import type { HostProcessRequest, HostProcessSnapshot } from '../src/host/HostWorkspaceTypes.js';
import { ConnectorHostFailure } from '../src/runtime/ConnectorHostFailure.js';
import { ConnectorHostTool } from '../src/protocol/ConnectorHost.js';
import { HostWorkspaceFixture } from './support/HostWorkspaceFixture.js';

/** Captured fixture ownership remains accessible when a factory fails after registering a live child. */
interface FailedLaunchCapture {
    owner: HostProcess | null;
    cleanup: MockInstance<HostProcess[typeof Symbol.asyncDispose]> | null;
}

/** Only isolated console programs are launched; no application activation or user desktop is touched. */
function command(executable: string = process.execPath): HostProcessRequest {
    return {
        executable,
        arguments: ['-e', 'setInterval(()=>{},1000)'],
        shell: null,
        command: null,
        directory: null,
        environment: {},
        timeoutMs: 10000,
    };
}

it('a failure after factory registration retains the exact live owner when cleanup is unconfirmed', async (): Promise<void> => {
    await using fixture: HostWorkspaceFixture = await HostWorkspaceFixture.create();
    const capture: FailedLaunchCapture = { owner: null, cleanup: null };
    const original: typeof HostProcess.create = HostProcess.create.bind(HostProcess);
    const create: MockInstance<typeof HostProcess.create> = vi
        .spyOn(HostProcess, 'create')
        .mockImplementation(
            async (...args: Parameters<typeof HostProcess.create>): Promise<HostProcess> => {
                const owner: HostProcess = await original(...args);
                capture.owner = owner;
                capture.cleanup = vi
                    .spyOn(owner, Symbol.asyncDispose)
                    .mockRejectedValue(new Error('native shutdown remains unconfirmed'));
                throw new Error('native creation decision was lost');
            },
        );
    try {
        await expect(fixture.host.start(command())).rejects.toThrow('ownership was retained');
        const owner: HostProcess | null = capture.owner;
        if (owner === null) {
            throw new Error('Expected an actual registered process owner');
        }
        const retained: HostProcessSnapshot = await fixture.host.output(owner.id, 0n, 0n, 1);
        expect(retained.processId).toBe(owner.id);
        capture.cleanup?.mockRestore();
        await fixture.host.release(owner.id);
        expect(owner.snapshot(0n, 0n, 1).running).toBe(false);
    } finally {
        capture.cleanup?.mockRestore();
        create.mockRestore();
    }
});

it('a failed registered factory releases its cell only after the actual owner joins cleanup', async (): Promise<void> => {
    await using fixture: HostWorkspaceFixture = await HostWorkspaceFixture.create();
    const capture: FailedLaunchCapture = { owner: null, cleanup: null };
    const original: typeof HostProcess.create = HostProcess.create.bind(HostProcess);
    const create: MockInstance<typeof HostProcess.create> = vi
        .spyOn(HostProcess, 'create')
        .mockImplementation(
            async (...args: Parameters<typeof HostProcess.create>): Promise<HostProcess> => {
                capture.owner = await original(...args);
                throw new Error('native creation decision was lost');
            },
        );
    try {
        await expect(fixture.host.start(command())).rejects.toThrow('creation decision was lost');
        const owner: HostProcess | null = capture.owner;
        if (owner === null) {
            throw new Error('Expected an actual registered process owner');
        }
        expect(owner.snapshot(0n, 0n, 1).running).toBe(false);
        await expect(fixture.host.output(owner.id, 0n, 0n, 1)).rejects.toThrow('unavailable');
    } finally {
        create.mockRestore();
    }
});

/** Completion observes the same root, owned tree and exact EOF totals rather than its immutable spawn snapshot. */
async function completed(fixture: HostWorkspaceFixture, id: string): Promise<HostProcessSnapshot> {
    for (let attempt: number = 0; attempt < 200; attempt++) {
        const snapshot: HostProcessSnapshot = await fixture.host.output(id, 0n, 0n, 32768);
        if (!snapshot.running && snapshot.treeRunning === false && snapshot.outputComplete) {
            return snapshot;
        }
        await delay(20);
    }
    throw new Error('Original Windows console process did not complete');
}

it.skipIf(process.platform !== 'win32')(
    'Windows native creation acknowledges absolute and PATH executables and preserves literal arguments',
    async (): Promise<void> => {
        await using fixture: HostWorkspaceFixture = await HostWorkspaceFixture.create();
        const values: readonly string[] = ['a b', 'a"b', 'C:\\tail\\', '', '/c'];
        const pathKey: string =
            Object.keys(process.env).find((key: string): boolean => key.toLowerCase() === 'path') ??
            'PATH';
        for (const executable of [process.execPath, basename(process.execPath)]) {
            const started: HostProcessSnapshot = await fixture.host.start({
                ...command(executable),
                arguments: [
                    '-e',
                    'process.stdout.write(JSON.stringify(process.argv.slice(1)))',
                    ...values,
                ],
                environment: { [pathKey]: dirname(process.execPath) },
            });
            const result: HostProcessSnapshot = await completed(fixture, started.processId);
            expect(result.exitCode).toBe(0);
            expect(result.failure).toBeNull();
            expect(result.stdout.bytes.toString()).toBe(JSON.stringify(values));
            expect(result.stdoutFinalBytes).toBe(BigInt(Buffer.byteLength(JSON.stringify(values))));
            await fixture.host.release(started.processId);
        }
    },
);

it.skipIf(process.platform !== 'win32')(
    'Windows missing and invalid executable failures are definitive only after native no-create cleanup',
    async (): Promise<void> => {
        await using fixture: HostWorkspaceFixture = await HostWorkspaceFixture.create();
        const invalid: string = join(fixture.directory, 'not-an-executable.exe');
        await writeFile(invalid, 'fixture invalid image', { flag: 'wx' });
        for (const [executable, expected] of [
            [join(fixture.directory, 'missing.exe'), 'not-found'],
            [invalid, 'unsupported'],
        ]) {
            let failure: unknown = null;
            try {
                await fixture.host.start(command(executable));
            } catch (error: unknown) {
                failure = error;
            }
            expect(failure).toBeInstanceOf(HostOperationError);
            expect(ConnectorHostFailure.response(ConnectorHostTool.ProcessStart, failure)).toEqual({
                outcome: 'failed',
                errorCode: expected,
                resultJson: null,
            });
        }
    },
);
