// SPDX-FileCopyrightText: 2026 Dacely <business@dacely.com>
// SPDX-License-Identifier: LicenseRef-Proprietary

import { expect, it } from 'vitest';
import type { HostDesktopFrame } from '../src/host/HostApplication.js';
import { HostDesktopCommand } from '../src/host/HostDesktopCommand.js';
import { HostDesktopX11Frame } from '../src/host/HostDesktopX11Frame.js';
import { HostMcpWorkspaceTools } from '../src/host/HostMcpWorkspaceTools.js';
import { HostDesktopFixture } from './support/HostDesktopFixture.js';

/** Real X11 checks run only where an isolated Xvfb display and the desktop tools are installed. */
const x11Qualification: boolean =
    process.platform === 'linux' &&
    (
        await Promise.all(
            ['Xvfb', 'xev', 'xdotool', 'import'].map((program: string): Promise<boolean> =>
                HostDesktopCommand.installed(program, process.env),
            ),
        )
    ).every((available: boolean): boolean => available);

it('reads JPEG start-of-frame dimensions and rejects truncated or foreign headers', (): void => {
    const header: Buffer = Buffer.from([
        0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xff, 0xc2, 0x00, 0x0b, 0x08, 0x02,
        0x58, 0x03, 0x20, 0x01, 0x01, 0x11, 0x00,
    ]);
    expect(HostDesktopX11Frame.size(header)).toEqual([800, 600]);
    expect(HostDesktopX11Frame.size(header.subarray(0, 12))).toBeNull();
    expect(HostDesktopX11Frame.size(Buffer.from([0x89, 0x50, 0x4e, 0x47]))).toBeNull();
    expect(
        HostDesktopX11Frame.size(Buffer.from([0xff, 0xd8, 0xff, 0xda, 0x00, 0x02, 0xff, 0xd9])),
    ).toBeNull();
});

it.skipIf(!x11Qualification)(
    'an isolated X11 desktop returns one inline JPEG of its full geometry',
    async (): Promise<void> => {
        await using fixture: HostDesktopFixture = await HostDesktopFixture.create();
        const frame: HostDesktopFrame = await fixture.host.desktopSnapshot();
        const bytes: Buffer = Buffer.from(frame.data, 'base64');
        expect(frame).toMatchObject({
            mimeType: 'image/jpeg',
            width: 800,
            height: 600,
            sourceX: 0,
            sourceY: 0,
            sourceWidth: 800,
            sourceHeight: 600,
        });
        expect(HostDesktopX11Frame.size(bytes)).toEqual([800, 600]);
        expect(bytes.length).toBeLessThanOrEqual(640000);
        expect(bytes.toString('base64')).toBe(frame.data);
        const tools: HostMcpWorkspaceTools = new HostMcpWorkspaceTools(
            fixture.host,
            new AbortController().signal,
        );
        const reply: unknown = await tools.call('desktop_snapshot', {});
        expect(JSON.stringify(reply)).toContain('image/jpeg');
    },
);
