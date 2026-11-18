// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

import { once } from 'node:events';
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { expect, it } from 'vitest';
import { Boundary } from 'nerva-connector-protocol/protocol/Boundary.js';
import {
    ConnectorHostTool,
    ConnectorHostOutcome,
    type ConnectorHostPermit,
    type ConnectorHostCompletion,
} from 'nerva-connector-protocol/protocol/ConnectorHost.js';
import type { ConnectorClientHost } from '../src/runtime/ConnectorClientHost.js';
import type { ConnectorHostLocalGrant } from '../src/runtime/ConnectorHostGrantTypes.js';
import { ConnectorHostFixture } from './support/ConnectorHostFixture.js';

it.skipIf(process.platform !== 'linux')(
    'signed native HTTP originals preserve exact body cursors and replay an open without a second connection',
    async (): Promise<void> => {
        const bytes: Buffer = Buffer.alloc(70000, 0x84);
        let connections: number = 0;
        const server: Server = createServer(
            (_incoming: IncomingMessage, response: ServerResponse): void => {
                connections++;
                response.writeHead(200, { 'content-length': String(bytes.byteLength) });
                response.end(bytes);
            },
        );
        server.listen(0, '127.0.0.1');
        await once(server, 'listening');
        try {
            await using fixture: ConnectorHostFixture = await ConnectorHostFixture.create();
            const grant: ConnectorHostLocalGrant = await fixture.grant();
            const host: ConnectorClientHost = await fixture.open();
            const address: AddressInfo | string | null = server.address();
            if (address === null || typeof address === 'string') {
                throw new Error('Missing native signed HTTP test listener');
            }
            const opening: ConnectorHostPermit = fixture.permit(
                grant,
                1n,
                ConnectorHostTool.HttpOpen,
                JSON.stringify({
                    url: 'http://pinned-native.invalid:' + String(address.port) + '/source',
                    address: '127.0.0.1',
                    method: 'GET',
                    headers: {},
                    maximumBytes: '100000',
                    timeoutMs: 10000,
                    idleTimeoutMs: 3000,
                }),
            );
            const opened: ConnectorHostCompletion = await host.execute(
                opening,
                opening.leaseId,
                opening.expiresAtMs,
            );
            expect(opened.response.outcome).toBe(ConnectorHostOutcome.Succeeded);
            const replayed: ConnectorHostCompletion = await host.execute(
                opening,
                opening.leaseId,
                opening.expiresAtMs,
            );
            expect(replayed.response).toEqual(opened.response);
            expect(connections).toBe(1);
            const rawHead: unknown = JSON.parse(opened.response.resultJson ?? 'null');
            const head: Readonly<Record<string, unknown>> = Boundary.record(rawHead, [
                'transferId',
                'status',
                'headers',
                'contentLength',
            ]);
            const transferId: unknown = head['transferId'];
            if (typeof transferId !== 'string') {
                throw new Error('Missing original native transfer identity');
            }
            await host.acknowledge(fixture.acknowledgment(opened), opening.leaseId);
            let sequence: bigint = 2n;
            let offset: bigint = 0n;
            const parts: Buffer[] = [];
            const deadline: AbortSignal = AbortSignal.timeout(10000);
            for (;;) {
                deadline.throwIfAborted();
                const permit: ConnectorHostPermit = fixture.permit(
                    grant,
                    sequence++,
                    ConnectorHostTool.HttpRead,
                    JSON.stringify({ transferId, offset: offset.toString(), maximumBytes: 32768 }),
                );
                const read: ConnectorHostCompletion = await host.execute(
                    permit,
                    permit.leaseId,
                    permit.expiresAtMs,
                );
                expect(read.response.outcome).toBe(ConnectorHostOutcome.Succeeded);
                const raw: unknown = JSON.parse(read.response.resultJson ?? 'null');
                const value: Readonly<Record<string, unknown>> = Boundary.record(raw, [
                    'transferId',
                    'offset',
                    'nextOffset',
                    'data',
                    'encoding',
                    'state',
                    'failure',
                ]);
                expect(value['transferId']).toBe(transferId);
                expect(value['offset']).toBe(offset.toString());
                expect(value['failure']).toBeNull();
                if (
                    typeof value['data'] !== 'string' ||
                    typeof value['nextOffset'] !== 'string' ||
                    value['encoding'] !== 'base64'
                ) {
                    throw new Error('Invalid signed native HTTP body window');
                }
                const part: Buffer = Buffer.from(value['data'], 'base64');
                expect(part.toString('base64')).toBe(value['data']);
                expect(part.byteLength).toBeLessThanOrEqual(32768);
                expect(BigInt(value['nextOffset'])).toBe(offset + BigInt(part.byteLength));
                offset = BigInt(value['nextOffset']);
                parts.push(part);
                await host.acknowledge(fixture.acknowledgment(read), permit.leaseId);
                if (value['state'] === 'complete') {
                    break;
                }
                expect(value['state']).toBe('pending');
                if (part.byteLength === 0) {
                    await delay(1);
                }
            }
            expect(Buffer.concat(parts)).toEqual(bytes);
            const closing: ConnectorHostPermit = fixture.permit(
                grant,
                sequence,
                ConnectorHostTool.HttpClose,
                JSON.stringify({ transferId }),
            );
            const closed: ConnectorHostCompletion = await host.execute(
                closing,
                closing.leaseId,
                closing.expiresAtMs,
            );
            expect(closed.response.outcome).toBe(ConnectorHostOutcome.Succeeded);
            expect(JSON.parse(closed.response.resultJson ?? 'null')).toEqual({
                transferId,
                closed: true,
            });
            await host.acknowledge(fixture.acknowledgment(closed), closing.leaseId);
            expect(connections).toBe(1);
        } finally {
            server.closeAllConnections();
            const closed: PromiseWithResolvers<undefined> = Promise.withResolvers<undefined>();
            server.close((): void => closed.resolve(undefined));
            await closed.promise;
        }
    },
    30000,
);
