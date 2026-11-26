// SPDX-FileCopyrightText: 2026 Dacely <business@dacely.com>
// SPDX-License-Identifier: LicenseRef-Proprietary

import type { ConnectorExecutionCommandFrame } from '../protocol/ConnectorTransport.js';
import type { ExecutionDeliveryLink } from './ExecutionDeliveryLink.js';

/** A channel retains one active delivery and one replacement envelope, irrespective of reconnect count. */
export interface ExecutionPendingDelivery {
    readonly frame: ConnectorExecutionCommandFrame;
    readonly link: ExecutionDeliveryLink;
}

/** Starts/receipts and explicit stops have independent finite channels, so stopping never waits behind a running command. */
export class ExecutionDeliveryChannel implements AsyncDisposable {
    #link: ExecutionDeliveryLink | null = null;
    #pending: ExecutionPendingDelivery | null = null;
    #active: ExecutionPendingDelivery | null = null;
    #task: Promise<void> | null = null;
    #closed: boolean = false;

    /** The shared owner verifies signed authority, correlates results and decides which current socket can receive them. */
    public constructor(
        public readonly perform: (delivery: ExecutionPendingDelivery) => Promise<void>,
        public readonly failed: (link: ExecutionDeliveryLink) => void,
    ) {}
    /** Replacing transport discards only its queued envelope, never the active original task. */
    public activate(link: ExecutionDeliveryLink): void {
        this.#link = link;
        this.#pending = null;
    }
    /** Disconnect releases all queued session references without waiting for or stopping native work. */
    public detach(link: ExecutionDeliveryLink): void {
        if (this.#link === link) {
            this.#link = null;
            this.#pending = null;
        }
    }
    /** Each connection may supply one active envelope or one replacement while the preceding connection's task joins. */
    public receive(frame: ConnectorExecutionCommandFrame, link: ExecutionDeliveryLink): void {
        if (
            this.#closed ||
            this.#link !== link ||
            this.#pending !== null ||
            this.#active?.link === link
        ) {
            throw new Error('Connector execution delivery unavailable');
        }
        this.#pending = { frame, link };
        this.#start();
    }
    /** The parent stops the native owner first; this method then joins bounded delivery continuations. */
    public async [Symbol.asyncDispose](): Promise<void> {
        this.#closed = true;
        this.#link = null;
        this.#pending = null;
        await this.#task;
    }
    #start(): void {
        if (!this.#closed && this.#task === null && this.#pending !== null) {
            this.#task = this.#drain();
            void this.#observe(this.#task);
        }
    }
    async #drain(): Promise<void> {
        while (!this.#closed && this.#pending !== null) {
            const delivery: ExecutionPendingDelivery = this.#pending;
            this.#pending = null;
            this.#active = delivery;
            try {
                if (delivery.link === this.#link) {
                    await this.perform(delivery);
                }
            } catch {
                this.failed(delivery.link);
                if (delivery.link === this.#link) {
                    this.#pending = null;
                }
            } finally {
                this.#active = null;
            }
        }
    }
    async #observe(task: Promise<void>): Promise<void> {
        try {
            await task;
        } catch {
            this.#closed = true;
            this.#link = null;
            this.#pending = null;
        } finally {
            if (this.#task === task) {
                this.#task = null;
                this.#start();
            }
        }
    }
}
