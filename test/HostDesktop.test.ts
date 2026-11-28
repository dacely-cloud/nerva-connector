// SPDX-FileCopyrightText: 2026 Dacely <business@dacely.com>
// SPDX-License-Identifier: LicenseRef-Proprietary

import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout } from 'node:timers/promises';
import { expect, it } from 'vitest';
import { HostDesktopCommand } from '../src/host/HostDesktopCommand.js';
import { HostWorkspace } from '../src/host/HostWorkspace.js';
import { HostMcpWorkspaceTools } from '../src/host/HostMcpWorkspaceTools.js';
import {
    HostDesktopBackend,
    HostDesktopUnavailable,
    type HostDesktopScreenshot,
} from '../src/host/HostDesktopTypes.js';
import { HostDesktopFixture } from './support/HostDesktopFixture.js';
import { HostWorkspaceFixture } from './support/HostWorkspaceFixture.js';
import { ConnectorHostErrorCode } from 'nerva-connector-protocol/protocol/ConnectorHost.js';
import {
    ConnectorHostKeyAction,
    ConnectorHostPointerAction,
    ConnectorHostPointerButton,
    ConnectorHostWriteMode,
} from 'nerva-connector-protocol/protocol/ConnectorHostArgumentChoices.js';

/** GUI qualification is explicit: ordinary headless test environments need not install desktop applications. */
const x11Qualification: boolean =
    process.platform === 'linux' &&
    (
        await Promise.all(
            ['Xvfb', 'xev', 'xdotool', 'import'].map((program: string): Promise<boolean> =>
                HostDesktopCommand.installed(program, process.env),
            ),
        )
    ).every((available: boolean): boolean => available);

it.skipIf(!x11Qualification)(
    'an isolated real X11 desktop accepts pointer/key/text input and produces an intentional PNG file',
    async (): Promise<void> => {
        await using fixture: HostDesktopFixture = await HostDesktopFixture.create();
        const help: Awaited<ReturnType<typeof execFile.__promisify__>> = await promisify(execFile)(
            'xdotool',
            ['type', '--help'],
            { env: fixture.environment, timeout: 5000, maxBuffer: 4096 },
        );
        expect(help.stdout.toString() + help.stderr.toString()).toContain('--file');
        expect(await fixture.host.desktopInfo()).toMatchObject({
            available: true,
            backend: HostDesktopBackend.X11,
            width: 800,
            height: 600,
        });
        const tools: HostMcpWorkspaceTools = new HostMcpWorkspaceTools(
            fixture.host,
            new AbortController().signal,
        );
        await tools.call('desktop_pointer', {
            x: 60,
            y: 50,
            action: ConnectorHostPointerAction.Click,
            image: {
                width: 400,
                height: 300,
                sourceX: 0,
                sourceY: 0,
                sourceWidth: 800,
                sourceHeight: 600,
            },
        });
        const pointer: Awaited<ReturnType<typeof execFile.__promisify__>> = await promisify(
            execFile,
        )('xdotool', ['getmouselocation', '--shell'], {
            env: fixture.environment,
            timeout: 5000,
            maxBuffer: 4096,
        });
        expect(pointer.stdout.toString()).toContain('X=121\nY=101\n');
        await expect(
            tools.call('desktop_pointer', {
                x: 1,
                y: 1,
                action: ConnectorHostPointerAction.Click,
                image: {
                    width: 400,
                    height: 300,
                    sourceX: 0,
                    sourceY: 0,
                    sourceWidth: 801,
                    sourceHeight: 600,
                },
            }),
        ).rejects.toThrow('fresh screenshot');
        await fixture.host.desktopKey({ key: 'A', action: ConnectorHostKeyAction.Press });
        await tools.call('desktop_text', { text: 'hello' });
        for (
            let attempt: number = 0;
            attempt < 100 && !fixture.events.includes('keysym 0x6f, o');
            attempt += 1
        ) {
            await setTimeout(10);
        }
        expect(fixture.events).toContain('ButtonPress event');
        expect(fixture.events).toContain('ButtonRelease event');
        expect(fixture.events).toContain('keysym 0x41, A');
        expect(fixture.events).toContain('keysym 0x68, h');
        expect(fixture.events).toContain('keysym 0x6f, o');
        const captured: HostDesktopScreenshot = await fixture.host.desktopScreenshot(
            'desktop.png',
            ConnectorHostWriteMode.Create,
            400,
            300,
        );
        expect(captured).toMatchObject({
            path: join(fixture.files.directory, 'desktop.png'),
            width: 400,
            height: 300,
        });
        expect((await stat(captured.path, { bigint: true })).size).toBe(captured.sizeBytes);
        const bytes: Buffer = await readFile(captured.path);
        expect(bytes.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
        await expect(
            fixture.host.desktopScreenshot('desktop.png', ConnectorHostWriteMode.Create),
        ).rejects.toMatchObject({ code: ConnectorHostErrorCode.AlreadyExists, definitive: true });
        expect(await readFile(captured.path)).toEqual(bytes);
        fixture.files.allowed = false;
        await expect(
            fixture.host.desktopPointer({
                x: 10,
                y: 10,
                action: ConnectorHostPointerAction.Move,
                button: null,
            }),
        ).rejects.toThrow('revoked');
        await expect(
            fixture.host.desktopScreenshot('refused.png', ConnectorHostWriteMode.Create),
        ).rejects.toThrow('revoked');
        await expect(stat(join(fixture.files.directory, 'refused.png'))).rejects.toThrow();
    },
);

it.skipIf(!x11Qualification)(
    'session cleanup releases held modifiers in the owned display',
    async (): Promise<void> => {
        await using fixture: HostDesktopFixture = await HostDesktopFixture.create();
        await fixture.host.desktopKey({ key: 'Shift', action: ConnectorHostKeyAction.Down });
        await fixture.host.desktopPointer({
            x: 80,
            y: 80,
            action: ConnectorHostPointerAction.Down,
            button: ConnectorHostPointerButton.Left,
        });
        await fixture.host[Symbol.asyncDispose]();
        await promisify(execFile)('xdotool', ['key', 'a'], {
            env: fixture.environment,
            timeout: 5000,
            maxBuffer: 4096,
        });
        for (
            let attempt: number = 0;
            attempt < 100 && !fixture.events.includes('keysym 0x61, a');
            attempt += 1
        ) {
            await setTimeout(10);
        }
        expect(fixture.events).toContain('ButtonRelease event');
        expect(fixture.events).toContain('keysym 0x61, a');
    },
);

it.skipIf(process.platform !== 'linux')(
    'headless and mixed Wayland sessions never advertise X11 desktop control',
    async (): Promise<void> => {
        await using fixture: HostWorkspaceFixture = await HostWorkspaceFixture.create();
        await using headless: HostWorkspace = await HostWorkspace.create({
            directory: fixture.directory,
            authorization: fixture,
            desktopEnvironment: { DISPLAY: '', WAYLAND_DISPLAY: '' },
        });
        expect(await headless.desktopInfo()).toMatchObject({
            available: false,
            reason: HostDesktopUnavailable.NoDisplay,
        });
        await expect(headless.desktopText('no desktop')).rejects.toThrow('unavailable');
        await using wayland: HostWorkspace = await HostWorkspace.create({
            directory: fixture.directory,
            authorization: fixture,
            desktopEnvironment: {
                DISPLAY: '',
                WAYLAND_DISPLAY: 'wayland-0',
                DBUS_SESSION_BUS_ADDRESS: '',
            },
        });
        expect(await wayland.desktopInfo()).toMatchObject({
            available: false,
            backend: HostDesktopBackend.WaylandPortal,
        });
        await using mixed: HostWorkspace = await HostWorkspace.create({
            directory: fixture.directory,
            authorization: fixture,
            desktopEnvironment: {
                DISPLAY: ':1',
                WAYLAND_DISPLAY: 'wayland-0',
                DBUS_SESSION_BUS_ADDRESS: '',
            },
        });
        expect(await mixed.desktopInfo()).toMatchObject({
            available: false,
            backend: HostDesktopBackend.WaylandPortal,
        });
    },
);
