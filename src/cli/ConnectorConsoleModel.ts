// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

import { ConnectorClientState } from '../runtime/ConnectorClientState.js';
import { ConnectorPairEventKind, type ConnectorPairEvent } from '../runtime/ConnectorPairClient.js';
import { ConnectorFailureRecovery, type ConnectorFailureReason } from './ConnectorFailure.js';

/** Connection claims come from the authenticated runtime, independently of a completed pairing. */
export const ConnectorConsolePhase = {
    Starting: 'Starting',
    Connecting: 'Connecting',
    NotLinked: 'Not linked',
    Connected: 'Connected',
    Reconnecting: 'Reconnecting',
    Unavailable: "Can't connect",
    Stopped: 'Stopped',
} as const;
/** Phase labels derive from their runtime mapping. */
export type ConnectorConsolePhase =
    (typeof ConnectorConsolePhase)[keyof typeof ConnectorConsolePhase];

/** One finite command catalog drives filtering, keyboard selection and help. */
export const ConnectorConsoleCommand = {
    Activity: 'activity',
    Settings: 'settings',
    Reconnect: 'reconnect',
    Pair: 'pair',
    Permissions: 'permissions',
    DisableHost: 'disable-host',
    System: 'system',
    Startup: 'startup',
    Updates: 'updates',
    Log: 'log',
    Logout: 'logout',
    Help: 'help',
    Quit: 'quit',
} as const;
/** Command names derive from their runtime mapping. */
export type ConnectorConsoleCommand =
    (typeof ConnectorConsoleCommand)[keyof typeof ConnectorConsoleCommand];

/** Only public human-facing state is kept by the terminal; keys, proofs and physical paths never enter it. */
export class ConnectorConsoleModel {
    /** The headline state shown next to the status dot. */
    public phase: ConnectorConsolePhase = ConnectorConsolePhase.Starting;
    /** One or two plain sentences under the headline. */
    public message: string = 'Starting…';
    /** The live progress line while the connector is actually working. */
    public activity: string = '';
    /** Output of the last slash command. */
    public details: readonly string[] = [];
    /** Folder access is configured for this computer. */
    public files: boolean = false;
    /** Command access is configured for this computer. */
    public execution: boolean = false;
    /** Full computer access is on, as verified from the signed local grant. */
    public host: boolean = false;
    /** The name this computer shows in Nerva, from the saved setup choices. */
    public computer: string = 'This computer';
    /** The folder Nexa starts in or is limited to, from the saved setup choices. */
    public folder: string | null = null;
    /** Whether the installed Windows connector starts in the background at sign-in; `null` where that is not offered. */
    public startup: boolean | null = null;
    /** Installed Mac/Linux launchers expose their private automatic-update channel. */
    public updates: boolean = false;
    /** `performance.now()` time of the next automatic retry, for the visible countdown. */
    public retryAt: number | null = null;
    #everConnected: boolean = false;

    /** The headline with a live countdown while an automatic retry is scheduled. */
    public status(now: number): string {
        if (this.retryAt === null) {
            return this.message;
        }
        const seconds: number = Math.max(0, Math.ceil((this.retryAt - now) / 1000));
        return (
            this.message +
            (seconds > 0 ? ' Retrying in ' + seconds.toString() + 's…' : ' Retrying…')
        );
    }

    /** Pairing for a linked computer only reports reconnects; failures are explained by the caller. */
    public pairing(event: ConnectorPairEvent): void {
        if (
            event.state === ConnectorPairEventKind.Reconnecting ||
            event.state === ConnectorPairEventKind.Paired
        ) {
            this.phase =
                event.state === ConnectorPairEventKind.Reconnecting && this.#everConnected
                    ? ConnectorConsolePhase.Reconnecting
                    : ConnectorConsolePhase.Connecting;
            this.message = 'Connecting to Nerva…';
        }
    }

    /** Work has started; any earlier failure or countdown is cleared. */
    public connecting(): void {
        this.phase = this.#everConnected
            ? ConnectorConsolePhase.Reconnecting
            : ConnectorConsolePhase.Connecting;
        this.message = 'Connecting to Nerva…';
        this.retryAt = null;
    }

    /** The computer has no account link yet and the person chose to link later. */
    public notLinked(): void {
        this.phase = ConnectorConsolePhase.NotLinked;
        this.message = 'Type /pair when you are ready to link this computer to your Nerva account.';
        this.retryAt = null;
    }

    /** A failure the connector cannot fix by itself, or one it retries at `retryAt`. */
    public failure(reason: ConnectorFailureReason, retryAt: number | null): void {
        this.phase = ConnectorConsolePhase.Unavailable;
        this.message =
            reason.title +
            '. ' +
            reason.detail +
            (retryAt !== null
                ? ''
                : reason.recovery === ConnectorFailureRecovery.StartOver
                  ? ' Use /logout to start over.'
                  : reason.recovery === ConnectorFailureRecovery.NewCode
                    ? ' Use /pair to get a new code.'
                    : ' Use /reconnect to try again.');
        this.retryAt = retryAt;
    }

    /** The runtime lost its connection and retries by itself at `retryAt`. */
    public retrying(reason: ConnectorFailureReason, retryAt: number): void {
        this.phase = this.#everConnected
            ? ConnectorConsolePhase.Reconnecting
            : ConnectorConsolePhase.Connecting;
        this.message = reason.title + '. ' + reason.detail;
        this.retryAt = retryAt;
    }

    /** A closed channel cannot retain a connected display while its prior work is being joined. */
    public closing(): void {
        if (this.phase === ConnectorConsolePhase.Stopped) {
            return;
        }
        this.phase = this.#everConnected
            ? ConnectorConsolePhase.Reconnecting
            : ConnectorConsolePhase.Connecting;
        this.message = 'Closing the previous connection…';
        this.retryAt = null;
    }

    /** Pairing alone can never produce the green authenticated connection state. */
    public connection(state: ConnectorClientState): void {
        if (state === ConnectorClientState.Revoked) {
            this.#everConnected = false;
            this.files = false;
            this.execution = false;
            this.host = false;
            this.notLinked();
            this.message =
                'This computer was disconnected from your account. Type /pair to link it again.';
            return;
        }
        if (state === ConnectorClientState.Authenticated) {
            this.#everConnected = true;
        }
        this.retryAt = null;
        this.phase =
            state === ConnectorClientState.Authenticated
                ? ConnectorConsolePhase.Connected
                : state === ConnectorClientState.Stopped
                  ? ConnectorConsolePhase.Stopped
                  : this.#everConnected
                    ? ConnectorConsolePhase.Reconnecting
                    : ConnectorConsolePhase.Connecting;
        this.message =
            state === ConnectorClientState.Authenticated
                ? 'Nexa can use this computer. Keep this window open.'
                : state === ConnectorClientState.Stopped
                  ? 'Connection stopped.'
                  : this.#everConnected
                    ? 'Connection lost. Reconnecting…'
                    : 'Connecting to Nerva…';
    }
}
