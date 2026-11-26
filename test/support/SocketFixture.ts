// SPDX-FileCopyrightText: 2026 Dacely <business@dacely.com>
// SPDX-License-Identifier: LicenseRef-Proprietary

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import type { IncomingMessage } from 'node:http';
import { createServer, type Server } from 'node:https';
import type { AddressInfo, Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Duplex } from 'node:stream';
import { promisify } from 'node:util';
import { ConnectorSocket } from '../../src/networking/ConnectorSocket.js';
import type { ConnectorStartupObserver } from '../../src/runtime/ConnectorStartup.js';

/** Real TLS/upgrade peer with separately owned sockets and temporary certificate files. */
export class SocketFixture implements AsyncDisposable {
    readonly #connections: Set<Socket> = new Set<Socket>();
    readonly #clients: ConnectorSocket[] = [];
    public readonly upgraded: PromiseWithResolvers<Duplex> = Promise.withResolvers<Duplex>();
    public readonly requests: IncomingMessage[] = [];

    private constructor(
        public readonly directory: string,
        public readonly certificate: Buffer,
        public readonly server: Server,
        public readonly protocol: string,
    ) {
        server.on('connection', (socket: Socket): void => {
            this.#connections.add(socket);
            socket.once('close', (): void => {
                this.#connections.delete(socket);
            });
        });
        server.on('upgrade', (request: IncomingMessage, socket: Duplex): void => {
            this.requests.push(request);
            const accept: string = createHash('sha1')
                .update(
                    String(request.headers['sec-websocket-key']) +
                        '258EAFA5-E914-47DA-95CA-C5AB0DC85B11',
                )
                .digest('base64');
            socket.write(
                'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' +
                    accept +
                    '\r\nSec-WebSocket-Protocol: ' +
                    protocol +
                    '\r\n\r\n',
            );
            this.upgraded.resolve(socket);
        });
    }

    /** A self-signed localhost identity is trusted only by clients explicitly given its certificate. */
    public static async create(protocol: string = 'nerva-test'): Promise<SocketFixture> {
        const directory: string = await mkdtemp(join(tmpdir(), 'nerva-native-socket-'));
        try {
            await promisify(execFile)(
                'openssl',
                [
                    'req',
                    '-x509',
                    '-newkey',
                    'ec',
                    '-pkeyopt',
                    'ec_paramgen_curve:P-256',
                    '-nodes',
                    '-keyout',
                    join(directory, 'key.pem'),
                    '-out',
                    join(directory, 'cert.pem'),
                    '-subj',
                    '/CN=localhost',
                    '-addext',
                    'subjectAltName=DNS:localhost',
                    '-days',
                    '1',
                ],
                { timeout: 5000, maxBuffer: 16384 },
            );
            const certificate: Buffer = await readFile(join(directory, 'cert.pem'));
            const server: Server = createServer({
                cert: certificate,
                key: await readFile(join(directory, 'key.pem')),
            });
            const fixture: SocketFixture = new SocketFixture(
                directory,
                certificate,
                server,
                protocol,
            );
            server.listen(0, '127.0.0.1');
            await once(server, 'listening');
            return fixture;
        } catch (caught: unknown) {
            await rm(directory, { recursive: true, force: true });
            throw caught;
        }
    }

    /** Tests select correct trust or deliberately omit it without changing process-global TLS state. */
    public connect(
        trusted: boolean = true,
        hostname: string = 'localhost',
        maximumPayload: number = 32,
        progress?: ConnectorStartupObserver,
    ): ConnectorSocket {
        const address: AddressInfo | string | null = this.server.address();
        if (address === null || typeof address === 'string') {
            throw new Error('Missing test listener');
        }
        const client: ConnectorSocket = new ConnectorSocket(
            'wss://' + hostname + ':' + String(address.port),
            this.protocol,
            {
                ca: trusted ? this.certificate : undefined,
                maximumPayload,
                handshakeMs: 2000,
                ...(progress === undefined ? {} : { progress }),
            },
        );
        client.on('error', (): void => {});
        this.#clients.push(client);
        return client;
    }

    /** Forced shutdown joins the listener before deleting this fixture's exact temporary directory. */
    public async [Symbol.asyncDispose](): Promise<void> {
        for (const client of this.#clients) {
            client.terminate();
        }
        for (const socket of this.#connections) {
            socket.destroy();
        }
        const closed: PromiseWithResolvers<undefined> = Promise.withResolvers<undefined>();
        this.server.close((): void => closed.resolve(undefined));
        await closed.promise;
        await rm(this.directory, { recursive: true, force: true });
    }
}
