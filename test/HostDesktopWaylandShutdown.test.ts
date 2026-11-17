// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

import { stat } from 'node:fs/promises';
import { ChildProcess } from 'node:child_process';
import { expect, it, vi, type MockInstance } from 'vitest';
import { HostDesktopWaylandChannel } from '../src/host/HostDesktopWaylandChannel.js';
import { HostDesktopWaylandOperation } from '../src/host/HostDesktopWaylandProtocol.js';

it.skipIf(process.platform !== 'linux')(
    'a missing native close acknowledgment has a finite join deadline and never becomes successful disposal',
    async (): Promise<void> => {
        const channel: HostDesktopWaylandChannel = await HostDesktopWaylandChannel.create({
            ...process.env,
            DBUS_SESSION_BUS_ADDRESS: '',
        });
        await channel.request({ operation: HostDesktopWaylandOperation.Probe });
        const original: unknown = Reflect.get(ChildProcess.prototype, 'emit');
        if (typeof original !== 'function') {
            throw new Error('Expected native event emitter');
        }
        const closed: PromiseWithResolvers<ChildProcess> = Promise.withResolvers<ChildProcess>();
        const owned: Set<ChildProcess> = new Set();
        const events: MockInstance<typeof ChildProcess.prototype.emit> = vi
            .spyOn(ChildProcess.prototype, 'emit')
            .mockImplementation(function (
                this: ChildProcess,
                event: string | symbol,
                ...arguments_: readonly unknown[]
            ): boolean {
                owned.add(this);
                if (event === 'close') {
                    closed.resolve(this);
                    return true;
                }
                const result: unknown = Reflect.apply(original, this, [event, ...arguments_]);
                return result === true;
            });
        try {
            vi.useFakeTimers();
            const disposal: Promise<void> = channel[Symbol.asyncDispose]();
            const rejected: Promise<void> = expect(disposal).rejects.toThrow(
                'termination could not be confirmed',
            );
            await vi.advanceTimersByTimeAsync(10001);
            await rejected;
            await expect(channel[Symbol.asyncDispose]()).rejects.toThrow('ownership retained');
            expect((await stat(channel.cacheDirectory)).isDirectory()).toBe(true);
        } finally {
            vi.useRealTimers();
            for (const child of owned) {
                child.kill('SIGKILL');
            }
            const child: ChildProcess = await closed.promise;
            events.mockRestore();
            child.emit('close', child.exitCode, child.signalCode);
            await vi.waitFor(async (): Promise<void> => {
                await expect(stat(channel.cacheDirectory)).rejects.toMatchObject({
                    code: 'ENOENT',
                });
            });
        }
    },
);
