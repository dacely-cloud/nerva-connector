// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

import { expect, it, vi, type MockInstance } from 'vitest';
import {
    HostApplication,
    HostApplicationStatus,
    type HostApplicationResult,
} from '../src/host/HostApplication.js';
import { HostDesktopWindows } from '../src/host/HostDesktopWindows.js';
import { HostDesktopCommand } from '../src/host/HostDesktopCommand.js';

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
            131072,
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
                data: 'x'.repeat(120001),
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
