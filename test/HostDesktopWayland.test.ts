// SPDX-FileCopyrightText: 2026 Dacely <business@dacely.com>
// SPDX-License-Identifier: LicenseRef-Proprietary

import { execFile, type ChildProcess } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { expect, it } from 'vitest';
import { HostDesktop } from '../src/host/HostDesktop.js';
import { HostDesktopWaylandScript } from '../src/host/HostDesktopWaylandScript.js';
import { HostDesktopWaylandFrames } from '../src/host/HostDesktopWaylandFrames.js';
import { HostDesktopWaylandPortal } from '../src/host/HostDesktopWaylandPortal.js';
import { HostDesktopWaylandChannel } from '../src/host/HostDesktopWaylandChannel.js';
import { HostDesktopWaylandOperation } from '../src/host/HostDesktopWaylandProtocol.js';

/** The fixture runs a new isolated bus; it never connects to the user's session or desktop. */
async function python(arguments_: readonly string[], input: string): Promise<string> {
    return await new Promise<string>(
        (resolve: (output: string) => void, reject: (error: Error) => void): void => {
            const child: ChildProcess = execFile(
                'dbus-run-session',
                ['--', 'python3', '-I', '-B', ...arguments_],
                { timeout: 15000, maxBuffer: 65536 },
                (error: Error | null, stdout: string, stderr: string): void => {
                    if (error !== null) {
                        reject(new Error(stderr, { cause: error }));
                    } else {
                        resolve(stdout);
                    }
                },
            );
            child.stdin?.on('error', reject);
            child.stdin?.end(input);
        },
    );
}

it.skipIf(process.platform !== 'linux')(
    'the fixed helper parses without writing code, bytecode or intermediate image files',
    async (): Promise<void> => {
        const result: string = await python(
            ['-c', 'import ast,sys;ast.parse(sys.stdin.read());print("valid")'],
            HostDesktopWaylandScript.source,
        );
        expect(result.trim()).toBe('valid');
    },
);

it.skipIf(process.platform !== 'linux')(
    'an isolated real D-Bus portal preserves consent generation, selected-monitor mapping, revocation and canceled request cleanup',
    async (): Promise<void> => {
        const fixture: string = await readFile(
            new URL('./support/HostDesktopWaylandPortalFixture.py', import.meta.url),
            'utf8',
        );
        const output: string = await python(
            ['-c', fixture],
            JSON.stringify({
                portal: HostDesktopWaylandPortal.source,
                runtime: HostDesktopWaylandScript.source,
            }),
        );
        const result: unknown = JSON.parse(output.trim());
        expect(result).toMatchObject({ ok: true, canceledRequests: 2 });
    },
    20000,
);

it.skipIf(process.platform !== 'linux')(
    'availability reports exact installed prerequisite failures without opening consent or using XWayland',
    async (): Promise<void> => {
        await using desktop: HostDesktop = new HostDesktop({
            environment: {
                WAYLAND_DISPLAY: 'wayland-fixture',
                DISPLAY: ':999',
                DBUS_SESSION_BUS_ADDRESS: '',
            },
        });
        const info: Awaited<ReturnType<HostDesktop['info']>> = await desktop.info();
        expect(info).toMatchObject({
            backend: 'wayland-portal',
            scope: 'selected-monitor',
            available: false,
            reason: 'missing-tools',
            width: 0,
            height: 0,
        });
        expect(info.prerequisites).toContain('Interactive user DBUS_SESSION_BUS_ADDRESS');
        await expect(desktop.text('must not prompt')).rejects.toThrow('unavailable');
    },
);

it.skipIf(process.platform !== 'linux')(
    'the retained helper observes EOF/close and joins its private process after a probe',
    async (): Promise<void> => {
        const channel: HostDesktopWaylandChannel = await HostDesktopWaylandChannel.create({
            ...process.env,
            DBUS_SESSION_BUS_ADDRESS: '',
        });
        try {
            expect(
                await channel.request({ operation: HostDesktopWaylandOperation.Probe }),
            ).toMatchObject({ kind: 'info', ready: false, reason: 'missing-tools' });
        } finally {
            await channel[Symbol.asyncDispose]();
        }
        await expect(
            channel.request({ operation: HostDesktopWaylandOperation.Probe }),
        ).rejects.toThrow('closed');
    },
);

it.skipIf(process.platform !== 'linux')(
    'stable stream serials and bounded fixed physical caps are checked before native capture allocation',
    async (): Promise<void> => {
        const fixture: string = await readFile(
            new URL('./support/HostDesktopWaylandFramesFixture.py', import.meta.url),
            'utf8',
        );
        const output: string = await python(['-c', fixture], HostDesktopWaylandFrames.source);
        const result: unknown = JSON.parse(output.trim());
        expect(result).toEqual({ ok: true, serialExact: true, boundedBeforeCapture: true });
    },
);
