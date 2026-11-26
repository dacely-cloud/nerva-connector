// SPDX-FileCopyrightText: 2026 Dacely <business@dacely.com>
// SPDX-License-Identifier: LicenseRef-Proprietary

import { expect, it, vi, type MockInstance } from 'vitest';
import { mkdir, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
    HostApplication,
    HostApplicationStatus,
    type HostApplicationResult,
} from '../src/host/HostApplication.js';
import { HostDesktopWindows } from '../src/host/HostDesktopWindows.js';
import { HostDesktopCommand } from '../src/host/HostDesktopCommand.js';
import { HostWorkspaceFixture } from './support/HostWorkspaceFixture.js';

it('admits regular workspace HTML and rejects symlinks to documents outside the workspace', async (): Promise<void> => {
    await using fixture: HostWorkspaceFixture = await HostWorkspaceFixture.create();
    const parent: string = fixture.host.directory;
    const workspace: string = join(parent, 'workspace');
    const page: string = join(workspace, 'color #2.html');
    const outside: string = join(parent, 'outside.html');
    await mkdir(workspace);
    await Promise.all([
        writeFile(page, '<title>workspace</title>'),
        writeFile(outside, '<title>outside</title>'),
    ]);
    expect(await HostApplication.workspaceDocument(page, workspace)).toBe(page);
    await expect(HostApplication.workspaceDocument(outside, workspace)).rejects.toMatchObject({
        code: 'invalid-request',
        definitive: true,
    });
    await expect(
        HostApplication.workspaceDocument(join(workspace, 'missing.html'), workspace),
    ).rejects.toMatchObject({
        code: 'not-found',
        definitive: true,
    });
    // Windows file symlinks require a developer-mode or privileged test account.
    if (process.platform !== 'win32') {
        const link: string = join(workspace, 'linked.html');
        await symlink(outside, link);
        await expect(HostApplication.workspaceDocument(link, workspace)).rejects.toMatchObject({
            code: 'invalid-request',
            definitive: true,
        });
    }
});

it('retains missing and ambiguous names as non-launching outcomes', (): void => {
    expect(
        HostApplication.result({ status: 'not-found', candidates: [], windowObserved: false }),
    ).toEqual({
        status: HostApplicationStatus.NotFound,
        candidates: [],
        windowObserved: false,
        screenshot: null,
    });
    expect(
        HostApplication.result({
            status: 'ambiguous',
            candidates: [
                { name: 'Editor One', id: 'first' },
                { name: 'Editor Two', id: 'second' },
            ],
            windowObserved: false,
        }).status,
    ).toBe(HostApplicationStatus.Ambiguous);
    expect((): HostApplicationResult =>
        HostApplication.result({ status: 'launched', candidates: [], windowObserved: true }),
    ).toThrow();
    expect((): HostApplicationResult =>
        HostApplication.result({
            status: 'ambiguous',
            candidates: [{ name: 'Editor', id: 'first' }],
            windowObserved: false,
        }),
    ).toThrow();
    expect((): HostApplicationResult =>
        HostApplication.result({ status: 'not-found', candidates: [], windowObserved: true }),
    ).toThrow();
});

it('returns an accepted launch with unavailable screen evidence without invoking a second operation', async (): Promise<void> => {
    const result: HostApplicationResult = {
        status: HostApplicationStatus.Launched,
        candidates: [{ name: 'Calculator', id: 'installed-app' }],
        windowObserved: false,
        screenshot: null,
    };
    const run: MockInstance<typeof HostDesktopCommand.run> = vi
        .spyOn(HostDesktopCommand, 'run')
        .mockResolvedValue(Buffer.from(JSON.stringify(result)));
    try {
        const driver: HostDesktopWindows = new HostDesktopWindows('verified-helper.exe', {});
        expect(await driver.openApplication('Calculator')).toEqual(result);
        expect(run).toHaveBeenCalledExactlyOnceWith(
            'verified-helper.exe',
            ['--desktop'],
            {},
            1048576,
            JSON.stringify({ operation: 'application-open', name: 'Calculator' }),
        );
    } finally {
        run.mockRestore();
    }
});

it('bounds native application metadata and rejects images on non-launching outcomes', (): void => {
    expect((): HostApplicationResult =>
        HostApplication.result({
            status: 'launched',
            candidates: [{ name: 'x'.repeat(513), id: 'id' }],
            windowObserved: false,
        }),
    ).toThrow();
    expect((): HostApplicationResult =>
        HostApplication.result({
            status: 'not-found',
            candidates: [],
            windowObserved: false,
            screenshot: {},
        }),
    ).toThrow();
    expect((): HostApplicationResult =>
        HostApplication.result({
            status: 'launched',
            candidates: [{ name: 'Calculator', id: 'id' }],
            windowObserved: true,
            screenshot: {
                mimeType: 'image/jpeg',
                data: 'x'.repeat(853337),
                width: 1280,
                height: 720,
                sourceX: 0,
                sourceY: 0,
                sourceWidth: 1280,
                sourceHeight: 800,
            },
        }),
    ).toThrow();
});

it('passes only a canonical HTTP address as a single native browser argument', async (): Promise<void> => {
    const result: HostApplicationResult = {
        status: HostApplicationStatus.Launched,
        candidates: [{ name: 'Google Chrome', id: 'installed-browser' }],
        windowObserved: true,
        screenshot: null,
        windowTarget: 'win32:v1:0000000000123456:00000022:01dc000000000000:00000033',
    };
    const run: MockInstance<typeof HostDesktopCommand.run> = vi
        .spyOn(HostDesktopCommand, 'run')
        .mockResolvedValue(Buffer.from(JSON.stringify(result)));
    try {
        const driver: HostDesktopWindows = new HostDesktopWindows('verified-helper.exe', {});
        for (const invalid of [
            'file:///test',
            'https://user:password@example.com/',
            'https://example.com/" --new-window',
            'https://example.com/\\test',
        ]) {
            await expect(driver.openApplication('Chrome', invalid)).rejects.toMatchObject({
                reason: 'application-browser-url',
                definitive: true,
            });
        }
        expect(run).not.toHaveBeenCalled();
        expect(await driver.openApplication('Chrome', 'HTTPS://Example.COM')).toEqual(result);
        expect(run).toHaveBeenCalledExactlyOnceWith(
            'verified-helper.exe',
            ['--desktop'],
            {},
            1048576,
            JSON.stringify({
                operation: 'application-open',
                name: 'Chrome',
                url: 'https://example.com/',
            }),
        );
    } finally {
        run.mockRestore();
    }
});
