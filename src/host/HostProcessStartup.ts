// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

import { ConnectorHostErrorCode } from 'nerva-connector-protocol/protocol/ConnectorHost.js';
import { HostOperationError } from './HostOperationError.js';

/** Native creation must be acknowledged separately from a broker's authenticated control readiness. */
export class HostProcessStartup {
    readonly #result: PromiseWithResolvers<undefined> = Promise.withResolvers<undefined>();
    #settled: boolean = false;
    #confirmed: boolean = false;

    /** Only Windows native admission requires a decision; the same rejection is observed immediately. */
    public constructor(public readonly required: boolean) {
        void this.#observe();
        if (!required) {
            this.#settled = true;
            this.#result.resolve(undefined);
        }
    }

    async #observe(): Promise<void> {
        try {
            await this.#result.promise;
        } catch {
            /** The registered owner can still await the same immutable failed decision. */
        }
    }

    /** A creation acknowledgment does not claim that the root remains alive or that output reached EOF. */
    public started(): void {
        if (this.#settled) {
            throw new Error('Host native launch decision changed');
        }
        this.#settled = true;
        this.#confirmed = true;
        this.#result.resolve(undefined);
    }

    /** Closed control or failed launch remains uncertain unless the caller supplies verified no-create evidence. */
    public failed(error: Error): void {
        if (!this.required || this.#settled) {
            return;
        }
        this.#settled = true;
        this.#result.reject(error);
    }

    /** Only an actual native creation acknowledgment satisfies the Windows admission boundary. */
    public get confirmed(): boolean {
        return this.#confirmed;
    }

    /** Startup has one finite observer; every outcome clears its owned deadline. */
    public async wait(): Promise<void> {
        let timer: NodeJS.Timeout | undefined;
        try {
            await Promise.race([
                this.#result.promise,
                new Promise<never>(
                    (_resolve: (value: never) => void, reject: (error: Error) => void): void => {
                        timer = setTimeout((): void => {
                            const error: HostOperationError = new HostOperationError(
                                ConnectorHostErrorCode.Canceled,
                                'The job launcher did not confirm process creation within 15 seconds',
                                false,
                            );
                            this.failed(error);
                            reject(error);
                        }, 15000);
                    },
                ),
            ]);
        } finally {
            clearTimeout(timer);
        }
    }
}
