// SPDX-FileCopyrightText: 2026 Dacely <business@dacely.com>
// SPDX-License-Identifier: LicenseRef-Proprietary

import { setTimeout as delay } from 'node:timers/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { expect, it } from 'vitest';
import { HostHttpPool } from '../src/host/HostHttpPool.js';
import {
    HostHttpFailure,
    HostHttpMethod,
    HostHttpState,
    type HostHttpHead,
    type HostHttpRead,
    type HostHttpRequest,
} from '../src/host/HostHttpTypes.js';
import { SocketFixture } from './support/SocketFixture.js';

/** The fixture's self-signed localhost certificate is explicitly trusted without disabling TLS checks. */
function request(fixture: SocketFixture, hostname: string = 'localhost'): HostHttpRequest {
    const address: AddressInfo | string | null = fixture.server.address();
    if (address === null || typeof address === 'string') {
        throw new Error('Missing owned HTTP fixture listener');
    }
    return {
        url: 'https://' + hostname + ':' + String(address.port) + '/source?exact=1',
        address: '127.0.0.1',
        method: HostHttpMethod.Get,
        headers: { accept: 'application/octet-stream' },
        maximumBytes: 4194304n,
        timeoutMs: 10000,
        idleTimeoutMs: 3000,
    };
}

/** Every successful read must reach verified HTTP completion; an empty pending read never establishes EOF. */
async function consume(pool: HostHttpPool, id: string, start: bigint = 0n): Promise<Buffer> {
    const signal: AbortSignal = AbortSignal.timeout(5000);
    const parts: Uint8Array[] = [];
    let offset: bigint = start;
    for (;;) {
        signal.throwIfAborted();
        const read: HostHttpRead = pool.read(id, offset, 32768);
        expect(read.offset).toBe(offset);
        expect(read.nextOffset).toBe(offset + BigInt(read.bytes.byteLength));
        expect(read.bytes.byteLength).toBeLessThanOrEqual(32768);
        if (read.failure !== null) {
            throw new Error('Native source failed: ' + read.failure);
        }
        parts.push(read.bytes);
        offset = read.nextOffset;
        if (read.state === HostHttpState.Complete) {
            return Buffer.concat(parts);
        }
        if (read.bytes.byteLength === 0) {
            await delay(1);
        }
    }
}

it('pins an actual TLS connection while preserving Host and body bytes through bounded native pulls', async (): Promise<void> => {
    await using fixture: SocketFixture = await SocketFixture.create();
    await using pool: HostHttpPool = new HostHttpPool({
        certificates: [fixture.certificate.toString('utf8')],
    });
    const original: Buffer = Buffer.alloc(2097152, 0xa7);
    let host: string | undefined;
    fixture.server.on('request', (incoming: IncomingMessage, response: ServerResponse): void => {
        host = incoming.headers.host;
        expect(incoming.url).toBe('/source?exact=1');
        expect(incoming.headers['accept-encoding']).toBe('identity');
        response.writeHead(200, { 'content-length': String(original.byteLength) });
        response.end(original);
    });
    const input: HostHttpRequest = request(fixture);
    const head: HostHttpHead = await pool.open(input, AbortSignal.timeout(5000));
    expect(head.contentLength).toBe(BigInt(original.byteLength));
    expect(host).toBe(new URL(input.url).host);
    expect(await consume(pool, head.transferId)).toEqual(original);
    await pool.close(head.transferId);
    expect((): HostHttpRead => pool.read(head.transferId, 0n, 32768)).toThrow('unavailable');
});

it('retains certificate hostname validation even when its root and pinned IP are trusted', async (): Promise<void> => {
    await using fixture: SocketFixture = await SocketFixture.create();
    await using pool: HostHttpPool = new HostHttpPool({
        certificates: [fixture.certificate.toString('utf8')],
    });
    await expect(
        pool.open(request(fixture, 'wrong-host.invalid'), AbortSignal.timeout(5000)),
    ).rejects.toThrow('Native HTTP request failed');
});

it.each([
    [HostHttpMethod.Head, 200],
    [HostHttpMethod.Get, 304],
] as const)(
    'preserves representation length for bodyless %s responses with status %s',
    async (method: HostHttpMethod, status: number): Promise<void> => {
        await using fixture: SocketFixture = await SocketFixture.create();
        await using pool: HostHttpPool = new HostHttpPool({
            certificates: [fixture.certificate.toString('utf8')],
        });
        fixture.server.on(
            'request',
            (incoming: IncomingMessage, response: ServerResponse): void => {
                expect(incoming.method).toBe(method);
                response.writeHead(status, { 'content-length': '1099511627776' });
                response.end();
            },
        );
        const head: HostHttpHead = await pool.open(
            { ...request(fixture), method },
            AbortSignal.timeout(5000),
        );
        expect(head.status).toBe(status);
        expect(head.contentLength).toBe(1099511627776n);
        expect(await consume(pool, head.transferId)).toEqual(Buffer.alloc(0));
        await pool.close(head.transferId);
    },
);

it('exposes redirects without following them or opening a second connection', async (): Promise<void> => {
    await using fixture: SocketFixture = await SocketFixture.create();
    await using pool: HostHttpPool = new HostHttpPool({
        certificates: [fixture.certificate.toString('utf8')],
    });
    let calls: number = 0;
    fixture.server.on('request', (_incoming: IncomingMessage, response: ServerResponse): void => {
        calls++;
        response.writeHead(302, { location: 'https://must-not-contact.invalid/secret' });
        response.end();
    });
    const head: HostHttpHead = await pool.open(request(fixture), AbortSignal.timeout(5000));
    expect(head.status).toBe(302);
    expect(head.headers).toContainEqual(['location', 'https://must-not-contact.invalid/secret']);
    await pool.close(head.transferId);
    expect(calls).toBe(1);
});

it('still refuses a GET representation whose declared body exceeds its admitted byte ceiling', async (): Promise<void> => {
    await using fixture: SocketFixture = await SocketFixture.create();
    await using pool: HostHttpPool = new HostHttpPool({
        certificates: [fixture.certificate.toString('utf8')],
    });
    fixture.server.on('request', (_incoming: IncomingMessage, response: ServerResponse): void => {
        response.writeHead(200, { 'content-length': '1099511627776' });
        response.end();
    });
    await expect(pool.open(request(fixture), AbortSignal.timeout(5000))).rejects.toThrow(
        'Native HTTP request failed',
    );
});

it('preserves the exact last committed window and rejects a changed cursor', async (): Promise<void> => {
    await using fixture: SocketFixture = await SocketFixture.create();
    await using pool: HostHttpPool = new HostHttpPool({
        certificates: [fixture.certificate.toString('utf8')],
    });
    const original: Buffer = Buffer.alloc(65536, 0x62);
    fixture.server.on('request', (_incoming: IncomingMessage, response: ServerResponse): void => {
        response.end(original);
    });
    const head: HostHttpHead = await pool.open(request(fixture), AbortSignal.timeout(5000));
    const deadline: AbortSignal = AbortSignal.timeout(5000);
    let first: HostHttpRead = pool.read(head.transferId, 0n, 32768);
    while (first.bytes.byteLength === 0) {
        deadline.throwIfAborted();
        expect(first.failure).toBeNull();
        await delay(1);
        first = pool.read(head.transferId, 0n, 32768);
    }
    expect(pool.read(head.transferId, 0n, 32768)).toEqual(first);
    expect((): HostHttpRead => pool.read(head.transferId, 1n, 32768)).toThrow('cursor changed');
    const rest: Buffer = await consume(pool, head.transferId, first.nextOffset);
    expect(Buffer.concat([first.bytes, rest])).toEqual(original);
});

it('a failed HTTP body never becomes a successful empty EOF', async (): Promise<void> => {
    await using fixture: SocketFixture = await SocketFixture.create();
    await using pool: HostHttpPool = new HostHttpPool({
        certificates: [fixture.certificate.toString('utf8')],
    });
    const accepted: PromiseWithResolvers<ServerResponse> = Promise.withResolvers<ServerResponse>();
    fixture.server.on('request', (_incoming: IncomingMessage, response: ServerResponse): void => {
        response.writeHead(200, { 'content-length': '1000' });
        response.flushHeaders();
        response.write('partial');
        accepted.resolve(response);
    });
    const head: HostHttpHead = await pool.open(request(fixture), AbortSignal.timeout(5000));
    (await accepted.promise).destroy();
    await expect(consume(pool, head.transferId)).rejects.toThrow('Native source failed: network');
});

it('bounds an unknown-length body and keeps overflow distinct from completed input', async (): Promise<void> => {
    await using fixture: SocketFixture = await SocketFixture.create();
    await using pool: HostHttpPool = new HostHttpPool({
        certificates: [fixture.certificate.toString('utf8')],
    });
    fixture.server.on('request', (_incoming: IncomingMessage, response: ServerResponse): void => {
        response.writeHead(200);
        response.write('too much');
        response.end();
    });
    const head: HostHttpHead = await pool.open(
        { ...request(fixture), maximumBytes: 4n },
        AbortSignal.timeout(5000),
    );
    expect(head.contentLength).toBeNull();
    await expect(consume(pool, head.transferId)).rejects.toThrow('Native source failed: limit');
    const failed: HostHttpRead = pool.read(head.transferId, 0n, 32768);
    expect(failed.state).toBe(HostHttpState.Failed);
    expect(failed.failure).toBe(HostHttpFailure.Limit);
});

it('rejects implicit authentication, proxy headers and nonliteral addresses before opening a socket', async (): Promise<void> => {
    await using fixture: SocketFixture = await SocketFixture.create();
    await using pool: HostHttpPool = new HostHttpPool();
    let connections: number = 0;
    fixture.server.on('connection', (): void => {
        connections++;
    });
    await expect(
        pool.open(
            { ...request(fixture), headers: { authorization: 'private' } },
            AbortSignal.timeout(5000),
        ),
    ).rejects.toThrow('headers');
    await expect(
        pool.open({ ...request(fixture), address: 'localhost' }, AbortSignal.timeout(5000)),
    ).rejects.toThrow('pinned');
    await expect(
        pool.open(
            {
                ...request(fixture),
                url: request(fixture).url.replace('https://', 'https://user:secret@'),
            },
            AbortSignal.timeout(5000),
        ),
    ).rejects.toThrow('pinned');
    expect(connections).toBe(0);
});

it('cancels and joins a real connection before headers settle', async (): Promise<void> => {
    await using fixture: SocketFixture = await SocketFixture.create();
    await using pool: HostHttpPool = new HostHttpPool({
        certificates: [fixture.certificate.toString('utf8')],
    });
    const accepted: PromiseWithResolvers<ServerResponse> = Promise.withResolvers<ServerResponse>();
    fixture.server.on('request', (_incoming: IncomingMessage, response: ServerResponse): void =>
        accepted.resolve(response),
    );
    const controller: AbortController = new AbortController();
    const opening: Promise<HostHttpHead> = pool.open(request(fixture), controller.signal);
    const outcome: Promise<readonly PromiseSettledResult<HostHttpHead>[]> = Promise.allSettled([
        opening,
    ]);
    const response: ServerResponse = await accepted.promise;
    const peerClosed: PromiseWithResolvers<undefined> = Promise.withResolvers<undefined>();
    response.socket?.once('close', (): void => peerClosed.resolve(undefined));
    controller.abort(new Error('source canceled'));
    expect((await outcome)[0]?.status).toBe('rejected');
    await peerClosed.promise;
});

it('expires abandoned transfers after their finite lifetime and returns capacity only after cleanup', async (): Promise<void> => {
    await using fixture: SocketFixture = await SocketFixture.create();
    await using pool: HostHttpPool = new HostHttpPool({
        certificates: [fixture.certificate.toString('utf8')],
    });
    fixture.server.on('request', (_incoming: IncomingMessage, response: ServerResponse): void => {
        response.writeHead(200);
        response.flushHeaders();
    });
    const head: HostHttpHead = await pool.open(
        { ...request(fixture), timeoutMs: 1000 },
        AbortSignal.timeout(5000),
    );
    await delay(1200);
    expect((): HostHttpRead => pool.read(head.transferId, 0n, 32768)).toThrow('unavailable');
    const next: HostHttpHead = await pool.open(request(fixture), AbortSignal.timeout(5000));
    await pool.close(next.transferId);
});
