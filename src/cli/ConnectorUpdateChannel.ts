// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

import {
    ConnectorUpdateMessage,
    ConnectorUpdateStatus,
    type ConnectorUpdatePacket,
} from '../update/ConnectorUpdateMessage.js';
import { WindowsBackgroundUpdate } from '../windows/WindowsBackgroundUpdate.js';

/** The console asks its installed supervisor to check without ever handling release keys, downloads or program writes. */
export class ConnectorUpdateChannel implements Disposable {
    readonly #windows: WindowsBackgroundUpdate | null = WindowsBackgroundUpdate.find();
    readonly #stop: AbortController = new AbortController();
    #windowsChecking: boolean = false;
    readonly #report: (rows: readonly string[]) => void;
    readonly #closed: () => void;
    readonly #disconnect: () => void = (): void => this.#closed();
    readonly #receive: (message: unknown) => void = (message: unknown): void => {
        const status: ConnectorUpdateStatus | null = ConnectorUpdateMessage.read(message);
        if (status !== null && status !== ConnectorUpdateStatus.Check) {
            this.#report(ConnectorUpdateMessage.rows(status));
        }
    };

    /** The caller owns drawing; message text comes exclusively from the fixed update-status catalog. */
    public constructor(report: (rows: readonly string[]) => void, closed: () => void) {
        this.#report = report;
        this.#closed = closed;
        if (typeof process.send === 'function' && process.connected) {
            process.on('message', this.#receive);
            process.once('disconnect', this.#disconnect);
        }
    }

    /** Installed POSIX launchers provide private Node IPC; the Windows launcher provides a bounded native event. */
    public get available(): boolean {
        return this.#windows !== null || (typeof process.send === 'function' && process.connected);
    }

    /** Coalesced checks remain in the supervisor, independent of this console's connection and local approvals. */
    public check(signal: AbortSignal): void {
        signal.throwIfAborted();
        if (this.#windows !== null) {
            if (!this.#windowsChecking) {
                this.#windowsChecking = true;
                void this.#checkWindows(
                    this.#windows,
                    AbortSignal.any([this.#stop.signal, signal]),
                );
            }
            return;
        }
        if (!this.available || process.send === undefined) {
            throw new Error('Automatic updates require the installed connector launcher');
        }
        const packet: ConnectorUpdatePacket = { nervaConnectorUpdate: ConnectorUpdateStatus.Check };
        this.#report(ConnectorUpdateMessage.rows(ConnectorUpdateStatus.Checking));
        process.send(packet, (failure: Error | null): void => {
            if (failure !== null) {
                this.#report(ConnectorUpdateMessage.rows(ConnectorUpdateStatus.Failed));
            }
        });
    }

    async #checkWindows(windows: WindowsBackgroundUpdate, signal: AbortSignal): Promise<void> {
        try {
            this.#report(ConnectorUpdateMessage.rows(ConnectorUpdateStatus.Checking));
            const status: ConnectorUpdateStatus = await windows.check(signal);
            if (!signal.aborted) {
                this.#report(
                    status === ConnectorUpdateStatus.Failed
                        ? ["Couldn't check or download an update. See supervisor.log for details."]
                        : ConnectorUpdateMessage.rows(status),
                );
            }
        } catch {
            if (!signal.aborted) {
                this.#report([
                    "Couldn't reach the Windows updater. Reopen Nerva Connector and try /update again.",
                ]);
            }
        } finally {
            this.#windowsChecking = false;
        }
    }

    /** Teardown detaches only this console's listener and lets normal shutdown release the IPC channel. */
    public [Symbol.dispose](): void {
        this.#stop.abort();
        process.removeListener('message', this.#receive);
        process.removeListener('disconnect', this.#disconnect);
    }
}
