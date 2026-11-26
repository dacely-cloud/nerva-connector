// SPDX-FileCopyrightText: 2026 Dacely <business@dacely.com>
// SPDX-License-Identifier: LicenseRef-Proprietary

import { expect, it } from 'vitest';
import { HostDesktopError } from '../src/host/HostDesktopError.js';
import { ConnectorLogSummary } from '../src/cli/ConnectorLogSummary.js';

it('retains native input rejection details without logging arbitrary stderr or typed text', (): void => {
    const error: HostDesktopError = HostDesktopError.read(
        Buffer.from(
            'private typed password\nNERVA_DESKTOP operation=pointer reason=input-not-delivered native=5\nprivate screenshot bytes',
        ),
        false,
    );
    expect(error.operation).toBe('pointer');
    expect(error.reason).toBe('input-not-delivered');
    expect(error.nativeCode).toBe(5);
    expect(error.code).toBe('EACCES');
    expect(error.message).toContain('Windows rejected');
    expect(JSON.stringify(error)).not.toContain('private');
    const unknown: HostDesktopError = HostDesktopError.read(
        Buffer.from('NERVA_DESKTOP operation=secret reason=another-secret native=0\n'),
        false,
    );
    expect(unknown.operation).toBe('unknown');
    expect(unknown.reason).toBe('operation-failed');
    expect(HostDesktopError.read(Buffer.from('private text only'), true).reason).toBe('timeout');
});

it('the /log summary includes the failed operation, safe reason and native code', (): void => {
    const rows: readonly string[] = ConnectorLogSummary.rows(
        [
            {
                event: 'host-operation-failed',
                time: '2026-11-17T00:00:00Z',
                tool: 'desktop_text',
                reason: 'Windows rejected keyboard input',
                nativeReason: 'input-not-delivered',
                nativeCode: 5,
            },
        ],
        6,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toContain('desktop_text');
    expect(rows[0]).toContain('input-not-delivered');
    expect(rows[0]).toContain('native code 5');
});
