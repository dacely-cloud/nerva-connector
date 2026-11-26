// SPDX-FileCopyrightText: 2026 Dacely <business@dacely.com>
// SPDX-License-Identifier: LicenseRef-Proprietary

import { once } from 'node:events';
import {
    createServer,
    createConnection,
    type Server,
    type AddressInfo,
    type Socket,
} from 'node:net';

/** A real listener observes accidental network activity, with positive controls independent of SDK mocks. */
export class NetworkCanary implements AsyncDisposable {
    readonly #server: Server = createServer((socket: Socket): void => {
        this.connections++;
        socket.destroy();
    });
    /** Every accepted TCP connection includes deliberate positive-control probes. */
    public connections: number = 0;

    /** Each fixture starts exactly one owned loopback listener. */
    public async endpoint(): Promise<string> {
        this.#server.listen(0, '127.0.0.1');
        await once(this.#server, 'listening');
        return 'wss://127.0.0.1:' + this.#address().port.toString() + '/v1/connector/tunnel';
    }

    /** Demonstrate that the observer can actually accept a connection before and after a local-only command. */
    public async probe(): Promise<void> {
        const socket: Socket = createConnection({
            host: '127.0.0.1',
            port: this.#address().port,
            signal: AbortSignal.timeout(1000),
        });
        try {
            await once(socket, 'close');
        } finally {
            socket.destroy();
        }
    }

    /** The fixture closes only its own listener after all accepted peers have been destroyed. */
    public async [Symbol.asyncDispose](): Promise<void> {
        if (!this.#server.listening) {
            return;
        }
        const closed: PromiseWithResolvers<undefined> = Promise.withResolvers<undefined>();
        this.#server.close((error?: Error): void => {
            if (error === undefined) {
                closed.resolve(undefined);
            } else {
                closed.reject(error);
            }
        });
        await closed.promise;
    }

    #address(): AddressInfo {
        const address: string | AddressInfo | null = this.#server.address();
        if (typeof address !== 'object' || address === null) {
            throw new Error('Owned network fixture required');
        }
        return address;
    }
}
