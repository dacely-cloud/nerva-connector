// SPDX-FileCopyrightText: 2026 Dacely <business@dacely.com>
// SPDX-License-Identifier: LicenseRef-Proprietary

import { expect, it, vi, type MockInstance } from 'vitest';
import { HostDesktopWindows } from '../src/host/HostDesktopWindows.js';
import { HostDesktopCommand } from '../src/host/HostDesktopCommand.js';
import { HostDesktopTextFieldOptions } from '../src/host/HostDesktopTextFieldOptions.js';
import { HostDesktopError } from '../src/host/HostDesktopError.js';
import { ConnectorHostFailure } from '../src/runtime/ConnectorHostFailure.js';
import {
    ConnectorHostTool,
    ConnectorHostOutcome,
    ConnectorHostErrorCode,
} from 'nerva-connector-protocol/protocol/ConnectorHost.js';
import { ConnectorHostKeyAction } from 'nerva-connector-protocol/protocol/ConnectorHostArgumentChoices.js';

const target: string = 'win32:v1:00000000000000ff:0000002a:01dc000000000001:00000037';

it('field replacement requires the explicit closed contract instead of falling back to foreground input', (): void => {
    expect(HostDesktopTextFieldOptions.read(undefined, undefined)).toBeUndefined();
    expect(HostDesktopTextFieldOptions.read('exact-name', true)).toEqual({
        field: 'exact-name',
        replace: true,
    });
    for (const field of [undefined, null, '', 'x'.repeat(257), 'nul\0field']) {
        expect(() => HostDesktopTextFieldOptions.read(field, true)).toThrow(HostDesktopError);
    }
    for (const replace of [undefined, false, 'true', 1]) {
        expect(() => HostDesktopTextFieldOptions.read('exact-name', replace)).toThrow(
            HostDesktopError,
        );
    }
});

it('the app-scoped path pipes only text/target/exactfield/replace and is independent of owned foreground modifiers', async (): Promise<void> => {
    const run: MockInstance<typeof HostDesktopCommand.run> = vi
        .spyOn(HostDesktopCommand, 'run')
        .mockResolvedValue(Buffer.from('{"ok":true}'));
    try {
        const driver: HostDesktopWindows = new HostDesktopWindows('verified.exe', {});
        await driver.key({ key: 'Control', action: ConnectorHostKeyAction.Down, target });
        const other: string = target.replace('00000000ff', '00000000fe');
        await driver.text('private replacement', other, { field: 'exact-name', replace: true });
        expect(run).toHaveBeenCalledTimes(2);
        expect(run.mock.calls[1]).toEqual([
            'verified.exe',
            ['--desktop'],
            {},
            4096,
            JSON.stringify({
                operation: 'text',
                text: 'private replacement',
                target: other,
                field: 'exact-name',
                replace: true,
            }),
        ]);
        await driver.key({ key: 'Control', action: ConnectorHostKeyAction.Up });
        expect(run.mock.calls[2]?.[4]).toBe(
            JSON.stringify({ operation: 'key-release', key: 'Control' }),
        );
    } finally {
        run.mockRestore();
    }
});

it('unsupported field replacement never retries as global typing or issues any focus/key helper', async (): Promise<void> => {
    const failure: HostDesktopError = new HostDesktopError('text', 'keyboard-field-unsupported', 0);
    const run: MockInstance<typeof HostDesktopCommand.run> = vi
        .spyOn(HostDesktopCommand, 'run')
        .mockRejectedValue(failure);
    try {
        const driver: HostDesktopWindows = new HostDesktopWindows('verified.exe', {});
        await expect(
            driver.text('private replacement', target, { field: 'exact-id', replace: true }),
        ).rejects.toBe(failure);
        expect(run).toHaveBeenCalledExactlyOnceWith(
            'verified.exe',
            ['--desktop'],
            {},
            4096,
            JSON.stringify({
                operation: 'text',
                text: 'private replacement',
                target,
                field: 'exact-id',
                replace: true,
            }),
        );
    } finally {
        run.mockRestore();
    }
});

it('pre-provider failures are definitive, while setter/readback uncertainty never becomes a no-effect failure', (): void => {
    for (const reason of [
        'keyboard-field-invalid',
        'keyboard-field-unsupported',
        'keyboard-field-not-found',
        'keyboard-field-ambiguous',
        'keyboard-field-read-only',
        'keyboard-field-unavailable',
        'keyboard-field-search-limit',
    ]) {
        const error: HostDesktopError = HostDesktopError.read(
            Buffer.from(
                'private field/account/value\nNERVA_DESKTOP operation=text reason=' +
                    reason +
                    ' native=0\nprivate value',
            ),
            false,
        );
        expect(error.reason).toBe(reason);
        expect(error.definitive).toBe(true);
        expect(ConnectorHostFailure.response(ConnectorHostTool.DesktopText, error).outcome).toBe(
            ConnectorHostOutcome.Failed,
        );
        expect(JSON.stringify(error)).not.toContain('private');
    }
    const after: HostDesktopError = HostDesktopError.read(
        Buffer.from(
            'NERVA_DESKTOP operation=text reason=keyboard-field-write-unconfirmed native=2147942405\n',
        ),
        false,
    );
    expect(after.nativeCode).toBe(2147942405);
    expect(after.definitive).toBe(false);
    expect(ConnectorHostFailure.response(ConnectorHostTool.DesktopText, after)).toMatchObject({
        outcome: ConnectorHostOutcome.Indeterminate,
        errorCode: ConnectorHostErrorCode.PermissionDenied,
    });
    expect(
        ConnectorHostFailure.response(
            ConnectorHostTool.DesktopText,
            new HostDesktopError('text', 'keyboard-field-unsupported', 0),
        ).errorCode,
    ).toBe(ConnectorHostErrorCode.Unsupported);
    expect(
        ConnectorHostFailure.response(
            ConnectorHostTool.DesktopText,
            new HostDesktopError('text', 'keyboard-field-search-limit', 0),
        ).errorCode,
    ).toBe(ConnectorHostErrorCode.ResourceLimit);
});
