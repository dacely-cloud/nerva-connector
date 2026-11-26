// SPDX-FileCopyrightText: 2026 Dacely <business@dacely.com>
// SPDX-License-Identifier: LicenseRef-Proprietary

import { expect, it, vi, type MockInstance } from 'vitest';
import { HostDesktopWindows } from '../src/host/HostDesktopWindows.js';
import { HostDesktopKeyAction } from '../src/host/HostDesktopTypes.js';
import { HostDesktopCommand } from '../src/host/HostDesktopCommand.js';
import { HostDesktopError } from '../src/host/HostDesktopError.js';
import { HostDesktopWindowTarget } from '../src/host/HostDesktopWindowTarget.js';
import { HostDesktopKeyChord } from '../src/host/HostDesktopKeyChord.js';
import { ConnectorHostFailure } from '../src/runtime/ConnectorHostFailure.js';
import {
    ConnectorHostTool,
    ConnectorHostOutcome,
    ConnectorHostErrorCode,
} from 'nerva-connector-protocol/protocol/ConnectorHost.js';

const target: string = 'win32:v1:00000000000000ff:0000002a:01dc000000000001:00000037';

it('rejects missing or malformed Windows targets and invalid chords before spawning any desktop helper', async (): Promise<void> => {
    const run: MockInstance<typeof HostDesktopCommand.run> = vi
        .spyOn(HostDesktopCommand, 'run')
        .mockResolvedValue(Buffer.from('{"ok":true}'));
    try {
        const driver: HostDesktopWindows = new HostDesktopWindows('verified.exe', {});
        await expect(driver.text('private')).rejects.toMatchObject({
            reason: 'keyboard-target-required',
            definitive: true,
        });
        await expect(
            driver.key({ key: 'Control+l', action: HostDesktopKeyAction.Press }),
        ).rejects.toMatchObject({ reason: 'keyboard-target-required', definitive: true });
        for (const invalid of [
            '',
            target + '\n',
            target.toUpperCase(),
            target.replace('0000002a', '00000000'),
        ]) {
            await expect(driver.text('private', invalid)).rejects.toMatchObject({
                reason: 'keyboard-target-invalid',
                definitive: true,
            });
        }
        for (const key of [
            'Control+Control+l',
            'Control+',
            'l+Control',
            'Control+Shift',
            'L\n',
            'F01',
            'Alt+Control+Shift+Meta+Control+l',
        ]) {
            await expect(
                driver.key({ key, action: HostDesktopKeyAction.Press, target }),
            ).rejects.toMatchObject({ reason: 'key-chord', definitive: true });
        }
        expect(run).not.toHaveBeenCalled();
    } finally {
        run.mockRestore();
    }
});

it('one guarded compound press is piped as data and never replayed or split into modifier helper processes', async (): Promise<void> => {
    const run: MockInstance<typeof HostDesktopCommand.run> = vi
        .spyOn(HostDesktopCommand, 'run')
        .mockResolvedValue(Buffer.from('{"ok":true}'));
    try {
        const driver: HostDesktopWindows = new HostDesktopWindows('verified.exe', {});
        await driver.key({ key: 'Control+l', action: HostDesktopKeyAction.Press, target });
        expect(run).toHaveBeenCalledExactlyOnceWith(
            'verified.exe',
            ['--desktop'],
            {},
            4096,
            JSON.stringify({
                operation: 'key',
                key: 'Control+l',
                action: 'press',
                target,
                held: '',
            }),
        );
        run.mockRejectedValueOnce(new HostDesktopError('key', 'keyboard-input-partial', 5));
        await expect(
            driver.key({ key: 'Control+l', action: HostDesktopKeyAction.Press, target }),
        ).rejects.toMatchObject({ reason: 'keyboard-input-partial' });
        expect(run).toHaveBeenCalledTimes(2);
    } finally {
        run.mockRestore();
    }
});

it('held keys borrow only this owner and target, and cleanup emits only the previously owned key-up', async (): Promise<void> => {
    const run: MockInstance<typeof HostDesktopCommand.run> = vi
        .spyOn(HostDesktopCommand, 'run')
        .mockResolvedValue(Buffer.from('{"ok":true}'));
    try {
        const driver: HostDesktopWindows = new HostDesktopWindows('verified.exe', {});
        await driver.key({ key: 'Control', action: HostDesktopKeyAction.Down, target });
        await driver.key({ key: 'Control+l', action: HostDesktopKeyAction.Press, target });
        expect(run.mock.calls[1]?.[4]).toBe(
            JSON.stringify({
                operation: 'key',
                key: 'Control+l',
                action: 'press',
                target,
                held: 'Control',
            }),
        );
        await expect(driver.text('private', target)).rejects.toMatchObject({
            reason: 'keyboard-key-active',
        });
        await expect(
            driver.key({
                key: 'L',
                action: HostDesktopKeyAction.Press,
                target: target.replace('00000000ff', '00000000fe'),
            }),
        ).rejects.toMatchObject({ reason: 'keyboard-owned-input-changed' });
        await driver.key({ key: 'Control', action: HostDesktopKeyAction.Up });
        expect(run.mock.calls[2]?.[4]).toBe(
            JSON.stringify({ operation: 'key-release', key: 'Control' }),
        );
        await expect(
            driver.key({ key: 'Control', action: HostDesktopKeyAction.Up }),
        ).rejects.toMatchObject({ reason: 'keyboard-owned-input-changed' });
        expect(run).toHaveBeenCalledTimes(3);
    } finally {
        run.mockRestore();
    }
});

it('definitive down rejection owns no release, while uncertain down retains its safe key-up cleanup', async (): Promise<void> => {
    const run: MockInstance<typeof HostDesktopCommand.run> = vi
        .spyOn(HostDesktopCommand, 'run')
        .mockResolvedValue(Buffer.from('{"ok":true}'));
    try {
        const driver: HostDesktopWindows = new HostDesktopWindows('verified.exe', {});
        run.mockRejectedValueOnce(new HostDesktopError('key', 'keyboard-focus-denied', 0));
        await expect(
            driver.key({ key: 'Shift', action: HostDesktopKeyAction.Down, target }),
        ).rejects.toThrow();
        await expect(
            driver.key({ key: 'Shift', action: HostDesktopKeyAction.Up }),
        ).rejects.toMatchObject({ reason: 'keyboard-owned-input-changed' });
        expect(run).toHaveBeenCalledTimes(1);
        run.mockRejectedValueOnce(new HostDesktopError('key', 'keyboard-input-partial', 5));
        await expect(
            driver.key({ key: 'Shift', action: HostDesktopKeyAction.Down, target }),
        ).rejects.toThrow();
        await driver.key({ key: 'Shift', action: HostDesktopKeyAction.Up });
        expect(run.mock.calls[2]?.[4]).toBe(
            JSON.stringify({ operation: 'key-release', key: 'Shift' }),
        );
    } finally {
        run.mockRestore();
    }
});

it('safe failure reasons preserve definitive rejection separately from partial input and redact arbitrary native stderr', (): void => {
    for (const reason of [
        'keyboard-target-required',
        'keyboard-target-invalid',
        'keyboard-target-stale',
        'keyboard-target-unavailable',
        'keyboard-focus-denied',
        'keyboard-modifiers-active',
        'keyboard-input-rejected',
        'key-chord',
    ]) {
        const failure: HostDesktopError = HostDesktopError.read(
            Buffer.from(
                'private text\nNERVA_DESKTOP operation=key reason=' +
                    reason +
                    ' native=0\nprivate target',
            ),
            false,
        );
        expect(failure.reason).toBe(reason);
        expect(ConnectorHostFailure.response(ConnectorHostTool.DesktopKey, failure).outcome).toBe(
            ConnectorHostOutcome.Failed,
        );
        expect(JSON.stringify(failure)).not.toContain('private');
    }
    for (const reason of [
        'keyboard-input-partial',
        'keyboard-focus-changed',
        'keyboard-release-unconfirmed',
    ]) {
        expect(
            ConnectorHostFailure.response(
                ConnectorHostTool.DesktopText,
                new HostDesktopError('text', reason, 0),
            ).outcome,
        ).toBe(ConnectorHostOutcome.Indeterminate);
    }
    expect(
        ConnectorHostFailure.response(
            ConnectorHostTool.DesktopText,
            new HostDesktopError('text', 'keyboard-target-required', 0),
        ).errorCode,
    ).toBe(ConnectorHostErrorCode.InvalidRequest);
    expect(
        ConnectorHostFailure.response(
            ConnectorHostTool.DesktopText,
            new HostDesktopError('text', 'keyboard-focus-denied', 0),
        ).errorCode,
    ).toBe(ConnectorHostErrorCode.PermissionDenied);
    expect(HostDesktopWindowTarget.read(target)).toBe(target);
    expect(HostDesktopKeyChord.read('Control+l', HostDesktopKeyAction.Press)).toBe('Control+l');
});
