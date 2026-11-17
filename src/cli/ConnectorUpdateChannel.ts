// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

import {
    ConnectorUpdateMessage,
    ConnectorUpdateStatus,
    type ConnectorUpdatePacket,
} from '../update/ConnectorUpdateMessage.js';

/** The console asks its installed supervisor to check without ever handling release keys, downloads or program writes. */
export class ConnectorUpdateChannel implements Disposable {
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
        if (this.available) {
            process.on('message', this.#receive);
            process.once('disconnect', this.#disconnect);
        }
    }

    /** Only installed POSIX launchers provide the private Node IPC channel. */
    public get available(): boolean {
        return typeof process.send === 'function' && process.connected;
    }

    /** Coalesced checks remain in the supervisor, independent of this console's connection and local approvals. */
    public check(): void {
        if (!this.available || process.send === undefined) {
            throw new Error('Automatic updates require the installed connector launcher');
        }
        const packet: ConnectorUpdatePacket = { nervaConnectorUpdate: ConnectorUpdateStatus.Check };
        process.send(packet, (failure: Error | null): void => {
            if (failure !== null) {
                this.#report(ConnectorUpdateMessage.rows(ConnectorUpdateStatus.Failed));
            }
        });
    }

    /** Teardown detaches only this console's listener and lets normal shutdown release the IPC channel. */
    public [Symbol.dispose](): void {
        process.removeListener('message', this.#receive);
        process.removeListener('disconnect', this.#disconnect);
    }
}
