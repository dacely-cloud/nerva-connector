// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

import { expect, it } from 'vitest';
import {
    ConnectorFailure,
    ConnectorFailureKind,
    ConnectorFailureRecovery,
    type ConnectorFailureContext,
    type ConnectorFailureReason,
} from '../src/cli/ConnectorFailure.js';
import { ConnectorDisconnect } from '../src/runtime/ConnectorDisconnect.js';
import { ConnectorStartupStage } from '../src/runtime/ConnectorStartup.js';
import { ConnectorPairEventKind } from '../src/runtime/ConnectorPairClient.js';
import { ConnectorLoggedOut } from '../src/runtime/ConnectorLogout.js';
import { ConnectorJournalFormatError } from '../src/runtime/ConnectorJournalFormatError.js';
import { WindowsStateError, WindowsStateFailure } from '../src/windows/WindowsStateProtocol.js';
import { ConnectorRuntimeUnsupported } from '../src/networking/ConnectorNodeRuntime.js';

/** Builds a context with only the facts a case cares about. */
function context(overrides: Partial<ConnectorFailureContext>): ConnectorFailureContext {
    return {
        error: new Error('opaque'),
        stage: null,
        httpStatus: null,
        event: null,
        codeShown: false,
        ...overrides,
    };
}

/** Node-style system errors carry only a code; their message is never consulted. */
function systemError(code: string): Error {
    return Object.assign(new Error('unused message ' + code), { code });
}

it('classifies from typed evidence: pairing events, local error classes, system codes and startup stages', (): void => {
    const cases: readonly (readonly [
        ConnectorFailureContext,
        ConnectorFailureKind,
        ConnectorFailureRecovery,
    ])[] = [
        [
            context({ event: ConnectorPairEventKind.Expired }),
            ConnectorFailureKind.CodeExpired,
            ConnectorFailureRecovery.NewCode,
        ],
        [
            context({ event: ConnectorPairEventKind.Denied }),
            ConnectorFailureKind.Declined,
            ConnectorFailureRecovery.StartOver,
        ],
        [
            context({ event: ConnectorPairEventKind.Revoked }),
            ConnectorFailureKind.Removed,
            ConnectorFailureRecovery.StartOver,
        ],
        [
            context({ error: new ConnectorLoggedOut() }),
            ConnectorFailureKind.LoggedOut,
            ConnectorFailureRecovery.StartOver,
        ],
        [
            context({ error: new WindowsStateError(WindowsStateFailure.Busy) }),
            ConnectorFailureKind.AlreadyRunning,
            ConnectorFailureRecovery.Manual,
        ],
        [
            context({ error: new WindowsStateError(WindowsStateFailure.Untrusted) }),
            ConnectorFailureKind.FolderPermissions,
            ConnectorFailureRecovery.Manual,
        ],
        [
            context({
                error: new ConnectorRuntimeUnsupported('22.20.0', '6.21.3'),
                stage: ConnectorStartupStage.PairingState,
            }),
            ConnectorFailureKind.RuntimeUnsupported,
            ConnectorFailureRecovery.Manual,
        ],
        [
            context({ error: systemError('EADDRINUSE'), stage: ConnectorStartupStage.Identity }),
            ConnectorFailureKind.AlreadyRunning,
            ConnectorFailureRecovery.Manual,
        ],
        [
            context({ error: systemError('EACCES') }),
            ConnectorFailureKind.StoragePermission,
            ConnectorFailureRecovery.Manual,
        ],
        [
            context({ error: systemError('ENOSPC') }),
            ConnectorFailureKind.DiskFull,
            ConnectorFailureRecovery.Manual,
        ],
        [
            context({ error: systemError('ENOTFOUND') }),
            ConnectorFailureKind.Offline,
            ConnectorFailureRecovery.Automatic,
        ],
        [
            context({ error: new DOMException('late', 'TimeoutError') }),
            ConnectorFailureKind.TimedOut,
            ConnectorFailureRecovery.Automatic,
        ],
        [
            context({ error: new DOMException('late', 'TimeoutError'), codeShown: true }),
            ConnectorFailureKind.CodeExpired,
            ConnectorFailureRecovery.NewCode,
        ],
        [
            context({ stage: ConnectorStartupStage.Tls }),
            ConnectorFailureKind.Offline,
            ConnectorFailureRecovery.Automatic,
        ],
        [
            context({ stage: ConnectorStartupStage.Rejected, httpStatus: 503 }),
            ConnectorFailureKind.Refused,
            ConnectorFailureRecovery.Automatic,
        ],
        [
            context({ stage: ConnectorStartupStage.Verification }),
            ConnectorFailureKind.PairingRejected,
            ConnectorFailureRecovery.Manual,
        ],
        [
            context({ stage: ConnectorStartupStage.LocalSecurity }),
            ConnectorFailureKind.LocalState,
            ConnectorFailureRecovery.Manual,
        ],
        [context({}), ConnectorFailureKind.Unknown, ConnectorFailureRecovery.Manual],
    ];
    for (const [input, kind, recovery] of cases) {
        const reason: ConnectorFailureReason = ConnectorFailure.classify(input);
        expect([reason.kind, reason.recovery]).toEqual([kind, recovery]);
        expect(reason.title.length).toBeGreaterThan(0);
        const copy: string = reason.detail.split(' Details: ')[0] ?? '';
        expect(reason.title.length + copy.length).toBeLessThan(160);
    }
    expect(
        ConnectorFailure.classify(
            context({ stage: ConnectorStartupStage.Rejected, httpStatus: 503 }),
        ).title,
    ).toBe('Nerva turned the connection away (HTTP 503)');
    expect(
        ConnectorFailure.classify(
            context({
                error: new ConnectorRuntimeUnsupported('22.20.0', '6.21.3'),
                stage: ConnectorStartupStage.PairingState,
            }),
        ),
    ).toMatchObject({
        title: 'This computer needs a newer Node.js',
        detail: 'Install Node.js 26 LTS from nodejs.org (this computer has Node.js 22.20.0), then try again.',
    });
    expect(
        ConnectorFailure.classify(context({ error: systemError('ECONNREFUSED') })),
    ).toMatchObject({
        title: "Can't reach Nerva",
        detail: 'Check your internet connection.',
    });
});

it('never repeats raw error text except fixed local messages, which are bounded and stripped of controls', (): void => {
    const secret: string =
        'token=abc /home/user/.local/share/nerva-connector/state/device-key.json';
    const reason: ConnectorFailureReason = ConnectorFailure.classify(
        context({ error: new Error(secret), stage: ConnectorStartupStage.Verification }),
    );
    expect(reason.title + reason.detail).not.toContain('token');
    expect(reason.title + reason.detail).not.toContain('device-key');
    const local: ConnectorFailureReason = ConnectorFailure.classify(
        context({ error: new ConnectorJournalFormatError() }),
    );
    expect(local.kind).toBe(ConnectorFailureKind.LocalState);
    expect(local.detail).toBe(new ConnectorJournalFormatError().message);
    expect(local.detail).not.toMatch(/[\p{Cc}\p{Cf}]/u);
    expect(
        ConnectorFailure.classify(
            context({ stage: ConnectorStartupStage.Rejected, httpStatus: 99999 }),
        ).title,
    ).toBe('Nerva turned the connection away');
});

it('names the interrupted local step and its own bounded error text for unrecognized local failures', (): void => {
    const restore: ConnectorFailureReason = ConnectorFailure.classify(
        context({
            error: new Error('Saved pairing state\u0000 does not match\u001b[31m'),
            stage: ConnectorStartupStage.PairingState,
        }),
    );
    expect(restore.kind).toBe(ConnectorFailureKind.LocalState);
    expect(restore.detail).toContain(
        'Details: ' + ConnectorStartupStage.PairingState + ': Saved pairing state',
    );
    expect(restore.detail).not.toMatch(/[\p{Cc}\p{Cf}]/u);
    const long: ConnectorFailureReason = ConnectorFailure.classify(
        context({ error: new Error('x'.repeat(5000)), stage: ConnectorStartupStage.Identity }),
    );
    expect((long.detail.split(' Details: ')[1] ?? '').length).toBeLessThanOrEqual(240);
    expect(ConnectorFailure.classify(context({ error: 'not an error' })).detail).not.toContain(
        'Details',
    );
});

it('explains automatic retries from the interrupted stage', (): void => {
    expect(ConnectorFailure.retrying(ConnectorStartupStage.Dns, null).kind).toBe(
        ConnectorFailureKind.Offline,
    );
    expect(ConnectorFailure.retrying(ConnectorStartupStage.Verification, null).kind).toBe(
        ConnectorFailureKind.ServerBusy,
    );
    expect(ConnectorFailure.retrying(ConnectorStartupStage.Proof, null).kind).toBe(
        ConnectorFailureKind.SignIn,
    );
    expect(ConnectorFailure.retrying(ConnectorStartupStage.Rejected, 429).title).toContain(
        'HTTP 429',
    );
    expect(ConnectorFailure.retrying(null, null).recovery).toBe(ConnectorFailureRecovery.Automatic);
});

it('names why a signed-in connection dropped instead of blaming the internet connection', (): void => {
    const details: string[] = Object.values(ConnectorDisconnect).map(
        (disconnect: ConnectorDisconnect): string => {
            const reason: ConnectorFailureReason = ConnectorFailure.dropped(disconnect);
            expect(reason.kind).toBe(ConnectorFailureKind.Dropped);
            expect(reason.recovery).toBe(ConnectorFailureRecovery.Automatic);
            expect(reason.detail).not.toContain('internet');
            return reason.detail;
        },
    );
    expect(new Set(details).size).toBe(details.length);
    expect(ConnectorFailure.dropped(ConnectorDisconnect.Host).detail).toContain(
        'full-computer operation',
    );
});

it('backs off 5s, 10s, 20s, 40s and then holds at one minute', (): void => {
    expect(
        [1, 2, 3, 4, 5, 6, 50].map((attempt: number): number =>
            ConnectorFailure.backoffMs(attempt),
        ),
    ).toEqual([5000, 10000, 20000, 40000, 60000, 60000, 60000]);
    expect(ConnectorFailure.backoffMs(0)).toBe(5000);
    expect(ConnectorFailure.backoffMs(Number.NaN)).toBe(5000);
});
