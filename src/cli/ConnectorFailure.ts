// SPDX-FileCopyrightText: 2026 Dacely <business@dacely.com>
// SPDX-License-Identifier: LicenseRef-Proprietary

import { ConnectorStartupStage } from '../runtime/ConnectorStartup.js';
import { ConnectorDisconnect } from '../runtime/ConnectorDisconnect.js';
import { ConnectorPairEventKind } from '../runtime/ConnectorPairClient.js';
import { ConnectorLoggedOut } from '../runtime/ConnectorLogout.js';
import { ConnectorJournalFormatError } from '../runtime/ConnectorJournalFormatError.js';
import { ConnectorNativeExecutionError } from '../runtime/ConnectorNativeExecutionError.js';
import { ConnectorHistoryMigrationError } from '../runtime/ConnectorHistoryMigration.js';
import { ConnectorPermissionError } from '../permissions/ConnectorPermissionError.js';
import { WindowsStateError, WindowsStateFailure } from '../windows/WindowsStateProtocol.js';
import { ConnectorRuntimeUnsupported } from '../networking/ConnectorNodeRuntime.js';
import { ConnectorLaneFailure } from '../runtime/ConnectorLaneFailure.js';

/** Every reason the connector can explain to a person; no remote text ever selects or fills one. */
export const ConnectorFailureKind = {
    Offline: 'offline',
    Dropped: 'dropped',
    Refused: 'refused',
    ServerBusy: 'server-busy',
    SignIn: 'sign-in',
    TimedOut: 'timed-out',
    CodeExpired: 'code-expired',
    Declined: 'declined',
    Removed: 'removed',
    LoggedOut: 'logged-out',
    PairingRejected: 'pairing-rejected',
    AlreadyRunning: 'already-running',
    StoragePermission: 'storage-permission',
    FolderPermissions: 'folder-permissions',
    StorageHelperStopped: 'storage-helper-stopped',
    AccessReloaded: 'access-reloaded',
    DiskFull: 'disk-full',
    RuntimeUnsupported: 'runtime-unsupported',
    LocalState: 'local-state',
    Unknown: 'unknown',
} as const;
/** Failure kinds derive from their runtime mapping. */
export type ConnectorFailureKind = (typeof ConnectorFailureKind)[keyof typeof ConnectorFailureKind];

/** What the person can do next. */
export const ConnectorFailureRecovery = {
    /** Transient: the connector retries by itself with capped backoff. */
    Automatic: 'automatic',
    /** Retrying may help once the person fixes something. */
    Manual: 'manual',
    /** The pairing code is no longer valid; a fresh code is needed. */
    NewCode: 'new-code',
    /** This computer must be unlinked and linked again. */
    StartOver: 'start-over',
} as const;
/** Recovery values derive from their runtime mapping. */
export type ConnectorFailureRecovery =
    (typeof ConnectorFailureRecovery)[keyof typeof ConnectorFailureRecovery];

/** Locally observed facts about a failure; never contains server text, credentials or paths. */
export interface ConnectorFailureContext {
    /** The thrown value, or `null` when only a retry progress event is known. */
    readonly error: unknown;
    /** The last real startup stage before the failure or retry. */
    readonly stage: ConnectorStartupStage | null;
    readonly httpStatus: number | null;
    /** The last public pairing event observed during this attempt. */
    readonly event: ConnectorPairEventKind | null;
    /** Whether a pairing code was on screen during this attempt. */
    readonly codeShown: boolean;
}

/** One bounded, friendly explanation of a failure. */
export interface ConnectorFailureReason {
    readonly kind: ConnectorFailureKind;
    /** A short headline such as "Can't reach Nerva". */
    readonly title: string;
    /** One plain sentence about what to do. */
    readonly detail: string;
    readonly recovery: ConnectorFailureRecovery;
}

/** Classifies failures from typed local evidence rather than matching on error messages. */
export class ConnectorFailure {
    /** Delays never exceed one minute. */
    public static readonly maximumBackoffMs: number = 60000;
    static readonly #network: ReadonlySet<string> = new Set([
        'ENOTFOUND',
        'EAI_AGAIN',
        'ECONNREFUSED',
        'ECONNRESET',
        'ECONNABORTED',
        'ETIMEDOUT',
        'ENETUNREACH',
        'ENETDOWN',
        'EHOSTUNREACH',
        'EHOSTDOWN',
        'EPIPE',
    ]);
    static readonly #transport: ReadonlySet<ConnectorStartupStage> = new Set([
        ConnectorStartupStage.Dns,
        ConnectorStartupStage.Tcp,
        ConnectorStartupStage.Tls,
        ConnectorStartupStage.Upgrade,
    ]);
    static readonly #exchange: ReadonlySet<ConnectorStartupStage> = new Set([
        ConnectorStartupStage.PairingRequest,
        ConnectorStartupStage.PairingStatus,
        ConnectorStartupStage.Verification,
    ]);
    static readonly #session: ReadonlySet<ConnectorStartupStage> = new Set([
        ConnectorStartupStage.Authentication,
        ConnectorStartupStage.Proof,
        ConnectorStartupStage.Confirmation,
    ]);

    /** Explains a thrown failure, preferring pairing events, then typed local errors, then the stage it happened in. */
    public static classify(context: ConnectorFailureContext): ConnectorFailureReason {
        const error: unknown = context.error;
        if (context.event === ConnectorPairEventKind.Expired) {
            return this.#reason(ConnectorFailureKind.CodeExpired);
        }
        if (context.event === ConnectorPairEventKind.Denied) {
            return this.#reason(ConnectorFailureKind.Declined);
        }
        if (context.event === ConnectorPairEventKind.Revoked) {
            return this.#reason(ConnectorFailureKind.Removed);
        }
        if (error instanceof ConnectorLoggedOut) {
            return this.#reason(ConnectorFailureKind.LoggedOut);
        }
        if (error instanceof ConnectorRuntimeUnsupported) {
            return {
                ...this.#reason(ConnectorFailureKind.RuntimeUnsupported),
                detail: error.advice,
            };
        }
        if (error instanceof ConnectorLaneFailure) {
            return this.#reason(ConnectorFailureKind.AccessReloaded);
        }
        if (error instanceof WindowsStateError) {
            return error.failure === WindowsStateFailure.Busy
                ? this.#reason(ConnectorFailureKind.AlreadyRunning)
                : error.failure === WindowsStateFailure.Untrusted
                  ? this.#reason(ConnectorFailureKind.FolderPermissions)
                  : error.failure === WindowsStateFailure.Stopped
                    ? this.#reason(ConnectorFailureKind.StorageHelperStopped)
                    : this.#local(error.message);
        }
        if (
            error instanceof ConnectorPermissionError ||
            error instanceof ConnectorJournalFormatError ||
            error instanceof ConnectorNativeExecutionError ||
            error instanceof ConnectorHistoryMigrationError
        ) {
            return this.#local(error.message);
        }
        const code: string | null = this.#code(error);
        if (code === 'EADDRINUSE' || code === 'EBUSY') {
            return this.#reason(ConnectorFailureKind.AlreadyRunning);
        }
        if (code === 'EACCES' || code === 'EPERM') {
            return this.#reason(ConnectorFailureKind.StoragePermission);
        }
        if (code === 'ENOSPC' || code === 'EDQUOT') {
            return this.#reason(ConnectorFailureKind.DiskFull);
        }
        if (code !== null && this.#network.has(code)) {
            return this.#reason(ConnectorFailureKind.Offline);
        }
        if (this.#named(error, 'TimeoutError')) {
            return context.codeShown
                ? this.#reason(ConnectorFailureKind.CodeExpired)
                : this.#reason(ConnectorFailureKind.TimedOut);
        }
        const stage: ConnectorStartupStage | null = context.stage;
        if (stage === ConnectorStartupStage.Rejected) {
            return this.#refused(context.httpStatus);
        }
        if (stage !== null && this.#transport.has(stage)) {
            return this.#reason(ConnectorFailureKind.Offline);
        }
        if (stage !== null && this.#exchange.has(stage)) {
            return this.#reason(ConnectorFailureKind.PairingRejected);
        }
        if (stage !== null && this.#session.has(stage)) {
            return this.#reason(ConnectorFailureKind.SignIn);
        }
        if (stage !== null) {
            return this.#detailed(this.#reason(ConnectorFailureKind.LocalState), stage, error);
        }
        return this.#detailed(this.#reason(ConnectorFailureKind.Unknown), null, error);
    }

    /**
     * Appends the interrupted local step and the connector's own bounded error text.
     *
     * @remarks
     * Unrecognized failures are otherwise indistinguishable on screen; the text comes from this
     * process, is shown only locally, and has control and formatting characters removed.
     */
    static #detailed(
        reason: ConnectorFailureReason,
        stage: ConnectorStartupStage | null,
        error: unknown,
    ): ConnectorFailureReason {
        const message: string =
            error instanceof Error ? error.message.replace(/[\p{Cc}\p{Cf}]/gu, ' ').trim() : '';
        const cause: string = [stage ?? '', message]
            .filter((part: string): boolean => part !== '')
            .join(': ');
        if (cause === '') {
            return reason;
        }
        return {
            ...reason,
            detail: reason.detail + ' Details: ' + Array.from(cause).slice(0, 240).join(''),
        };
    }

    /**
     * Explains why a connection that had signed in ended, from the local reason its socket closed.
     *
     * @param disconnect - The first local reason, or {@link ConnectorDisconnect.Closed} when Nerva or the network closed it
     */
    public static dropped(disconnect: ConnectorDisconnect): ConnectorFailureReason {
        return {
            kind: ConnectorFailureKind.Dropped,
            title: 'The connection to Nerva dropped',
            detail: this.#dropped[disconnect],
            recovery: ConnectorFailureRecovery.Automatic,
        };
    }

    static readonly #dropped: Readonly<Record<ConnectorDisconnect, string>> = {
        [ConnectorDisconnect.Revoked]:
            'This computer was disconnected from your account. Pair it again to reconnect.',
        [ConnectorDisconnect.Closed]: 'Nerva or the network closed it.',
        [ConnectorDisconnect.Network]: 'A network error interrupted it.',
        [ConnectorDisconnect.HandshakeTimeout]: 'Signing in again took too long.',
        [ConnectorDisconnect.LeaseExpired]: 'Its session ran out before it was renewed.',
        [ConnectorDisconnect.InvalidFrame]:
            'Nerva sent something this connector does not accept. Updating the connector may fix it.',
        [ConnectorDisconnect.Authentication]: "Nerva's sign-in could not be verified.",
        [ConnectorDisconnect.Host]:
            'A full-computer operation from Nerva could not be accepted on this computer.',
        [ConnectorDisconnect.Files]:
            'A file operation from Nerva could not be accepted on this computer.',
        [ConnectorDisconnect.Execution]:
            'A program run from Nerva could not be accepted on this computer.',
        [ConnectorDisconnect.Inventory]: "This computer's system details could not be read.",
    };

    /** Explains an automatic retry announced by progress events, from the stage that was interrupted. */
    public static retrying(
        stage: ConnectorStartupStage | null,
        httpStatus: number | null,
    ): ConnectorFailureReason {
        if (stage === ConnectorStartupStage.Rejected) {
            return this.#refused(httpStatus);
        }
        if (stage !== null && this.#exchange.has(stage)) {
            return this.#reason(ConnectorFailureKind.ServerBusy);
        }
        if (stage !== null && this.#session.has(stage)) {
            return this.#reason(ConnectorFailureKind.SignIn);
        }
        return this.#reason(ConnectorFailureKind.Offline);
    }

    /**
     * Capped exponential delay for the connector's own retries: 5s, 10s, 20s, 40s, then 60s.
     *
     * @param attempt - One-based retry number
     */
    public static backoffMs(attempt: number): number {
        const count: number = Number.isFinite(attempt) ? Math.trunc(attempt) : 1;
        const exponent: number = Math.max(0, Math.min(16, count - 1));
        return Math.min(this.maximumBackoffMs, 5000 * 2 ** exponent);
    }

    static #refused(httpStatus: number | null): ConnectorFailureReason {
        const status: string =
            httpStatus !== null &&
            Number.isSafeInteger(httpStatus) &&
            httpStatus >= 100 &&
            httpStatus <= 599
                ? ' (HTTP ' + httpStatus.toString() + ')'
                : '';
        return {
            kind: ConnectorFailureKind.Refused,
            title: 'Nerva turned the connection away' + status,
            detail: 'This is usually temporary.',
            recovery: ConnectorFailureRecovery.Automatic,
        };
    }

    static #local(message: string): ConnectorFailureReason {
        return {
            kind: ConnectorFailureKind.LocalState,
            title: 'The connector needs attention on this computer',
            detail: Array.from(message.replace(/[\p{Cc}\p{Cf}]/gu, ''))
                .slice(0, 240)
                .join(''),
            recovery: ConnectorFailureRecovery.Manual,
        };
    }

    static #reason(kind: ConnectorFailureKind): ConnectorFailureReason {
        switch (kind) {
            case ConnectorFailureKind.Offline:
                return {
                    kind,
                    title: "Can't reach Nerva",
                    detail: 'Check your internet connection.',
                    recovery: ConnectorFailureRecovery.Automatic,
                };
            case ConnectorFailureKind.Dropped:
                return this.dropped(ConnectorDisconnect.Closed);
            case ConnectorFailureKind.Refused:
                return this.#refused(null);
            case ConnectorFailureKind.ServerBusy:
                return {
                    kind,
                    title: 'Nerva is busy right now',
                    detail: 'This is usually temporary.',
                    recovery: ConnectorFailureRecovery.Automatic,
                };
            case ConnectorFailureKind.SignIn:
                return {
                    kind,
                    title: "Nerva didn't finish signing in this computer",
                    detail: 'This is usually temporary.',
                    recovery: ConnectorFailureRecovery.Automatic,
                };
            case ConnectorFailureKind.TimedOut:
                return {
                    kind,
                    title: 'Nerva took too long to answer',
                    detail: 'Check your internet connection.',
                    recovery: ConnectorFailureRecovery.Automatic,
                };
            case ConnectorFailureKind.CodeExpired:
                return {
                    kind,
                    title: 'Your code expired',
                    detail: 'Codes last 10 minutes. Get a new one to keep going.',
                    recovery: ConnectorFailureRecovery.NewCode,
                };
            case ConnectorFailureKind.Declined:
                return {
                    kind,
                    title: 'The link request was declined',
                    detail: 'Start over to get a new code.',
                    recovery: ConnectorFailureRecovery.StartOver,
                };
            case ConnectorFailureKind.Removed:
                return {
                    kind,
                    title: 'This computer was removed from your Nerva account',
                    detail: 'Start over to link it again.',
                    recovery: ConnectorFailureRecovery.StartOver,
                };
            case ConnectorFailureKind.LoggedOut:
                return {
                    kind,
                    title: 'This computer was unlinked',
                    detail: 'Start over to link it again.',
                    recovery: ConnectorFailureRecovery.StartOver,
                };
            case ConnectorFailureKind.PairingRejected:
                return {
                    kind,
                    title: "Nerva couldn't confirm this computer",
                    detail: 'Try again. If it keeps happening, start over with /logout.',
                    recovery: ConnectorFailureRecovery.Manual,
                };
            case ConnectorFailureKind.AlreadyRunning:
                return {
                    kind,
                    title: 'Nerva Connector is already running on this computer',
                    detail: 'Close the other window or stop its background service, then try again.',
                    recovery: ConnectorFailureRecovery.Manual,
                };
            case ConnectorFailureKind.StoragePermission:
                return {
                    kind,
                    title: "Can't access the connector's private files",
                    detail: 'Run the connector as the user who set it up, then try again.',
                    recovery: ConnectorFailureRecovery.Manual,
                };
            case ConnectorFailureKind.FolderPermissions:
                return {
                    kind,
                    title: 'Windows folder permissions block the connector',
                    detail: 'Windows rejected a connector storage folder. Its name and fix are below; pairing and keys are unchanged.',
                    recovery: ConnectorFailureRecovery.Manual,
                };
            case ConnectorFailureKind.StorageHelperStopped:
                return {
                    kind,
                    title: "The connector's Windows storage helper stopped",
                    detail: 'The connector starts a new one and reconnects. Saved pairing and keys are unchanged.',
                    recovery: ConnectorFailureRecovery.Automatic,
                };
            case ConnectorFailureKind.AccessReloaded:
                return {
                    kind,
                    title: "A local check stopped this computer's connector access",
                    detail: 'The connector reloads its saved state and reconnects. Nothing that already started runs again.',
                    recovery: ConnectorFailureRecovery.Automatic,
                };
            case ConnectorFailureKind.DiskFull:
                return {
                    kind,
                    title: 'This computer is out of disk space',
                    detail: 'Free up some space, then try again.',
                    recovery: ConnectorFailureRecovery.Manual,
                };
            case ConnectorFailureKind.RuntimeUnsupported:
                return {
                    kind,
                    title: 'This computer needs a newer Node.js',
                    detail: 'Install Node.js 26 LTS from nodejs.org, then try again.',
                    recovery: ConnectorFailureRecovery.Manual,
                };
            case ConnectorFailureKind.LocalState:
                return {
                    kind,
                    title: "Couldn't open this computer's connector files",
                    detail: 'They may be in use or damaged. Close other connector windows, then try again.',
                    recovery: ConnectorFailureRecovery.Manual,
                };
            case ConnectorFailureKind.Unknown:
                return {
                    kind,
                    title: 'Something went wrong while connecting',
                    detail: 'Try again in a moment.',
                    recovery: ConnectorFailureRecovery.Manual,
                };
        }
    }

    static #code(error: unknown): string | null {
        return error instanceof Error && 'code' in error && typeof error.code === 'string'
            ? error.code
            : null;
    }

    static #named(error: unknown, name: string): boolean {
        return (error instanceof Error || error instanceof DOMException) && error.name === name;
    }
}
