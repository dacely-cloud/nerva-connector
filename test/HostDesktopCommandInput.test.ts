// SPDX-FileCopyrightText: 2026 Dacely <business@dacely.com>
// SPDX-License-Identifier: LicenseRef-Proprietary

import type {
    ChildProcess,
    ExecException,
    ExecFileOptionsWithBufferEncoding,
} from 'node:child_process';
import { expect, it, vi } from 'vitest';
import { HostDesktopCommand } from '../src/host/HostDesktopCommand.js';

/** The production desktop runner uses only this exact buffered four-argument subprocess contract. */
interface DesktopChildProcessModule {
    readonly execFile: (
        program: string,
        arguments_: readonly string[] | null | undefined,
        options: ExecFileOptionsWithBufferEncoding,
        callback: (error: ExecException | null, stdout: Buffer) => void,
    ) => ChildProcess;
}

/** A scheduling pause preserves actual OS pipes while making a fast child's close win the race. */
vi.mock('node:child_process', async (importOriginal): Promise<DesktopChildProcessModule> => {
    const original: typeof import('node:child_process') =
        await importOriginal<typeof import('node:child_process')>();
    const filesystem: typeof import('node:fs') = await import('node:fs');
    return {
        execFile: (
            program: string,
            arguments_: readonly string[] | null | undefined,
            options: ExecFileOptionsWithBufferEncoding,
            callback: (error: ExecException | null, stdout: Buffer) => void,
        ): ChildProcess => {
            const child: ChildProcess = original.execFile(program, arguments_, options, callback);
            const deadline: number = performance.now() + 1000;
            while (child.pid !== undefined && performance.now() < deadline) {
                const status: string = filesystem.readFileSync(
                    '/proc/' + child.pid.toString() + '/stat',
                    'utf8',
                );
                if (status.includes(') Z ') || status.includes(') X ')) {
                    break;
                }
            }
            return child;
        },
    };
});

it.skipIf(process.platform !== 'linux')(
    'inputless fast desktop commands close stdin without issuing an empty write after the child exits',
    async (): Promise<void> => {
        for (let attempt: number = 0; attempt < 32; attempt += 1) {
            expect(await HostDesktopCommand.run('/bin/true', [], process.env, 4096)).toEqual(
                Buffer.alloc(0),
            );
        }
    },
);

it.skipIf(process.platform !== 'linux')(
    'supplied input still rejects exact delivery failure after the child closes its pipe',
    async (): Promise<void> => {
        for (let attempt: number = 0; attempt < 8; attempt += 1) {
            await expect(
                HostDesktopCommand.run('/bin/true', [], process.env, 4096, 'must reach the child'),
            ).rejects.toMatchObject({
                message: 'Desktop input pipe failed; effect may be partial',
                cause: { code: 'EPIPE' },
            });
        }
    },
);

it.skipIf(process.platform !== 'linux')(
    'inputless execution still reports the actual command exit failure',
    async (): Promise<void> => {
        await expect(
            HostDesktopCommand.run('/bin/sh', ['-c', 'exit 7'], process.env, 4096),
        ).rejects.toMatchObject({ code: 7 });
    },
);
