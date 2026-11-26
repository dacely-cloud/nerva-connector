// SPDX-FileCopyrightText: 2026 Dacely <business@dacely.com>
// SPDX-License-Identifier: LicenseRef-Proprietary

import { readFile, readdir, writeFile } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { PassThrough, Readable } from 'node:stream';
import { getCACertificates, setDefaultCACertificates, TLSSocket } from 'node:tls';
import { afterEach, expect, it } from 'vitest';
import { WindowsUpdateFetch } from '../src/windows/WindowsUpdateFetch.js';
import { WindowsUpdateFetchError } from '../src/windows/WindowsUpdateFetchError.js';
import type { WindowsUpdateFetchRequest } from '../src/windows/WindowsUpdateFetchProtocol.js';
import { SocketFixture } from './support/SocketFixture.js';

const authorities: readonly string[] = getCACertificates('default');
afterEach((): void => setDefaultCACertificates([...authorities]));

/** One local TLS peer supplies ordinary OS-independent certificate validation without production CA overrides. */
function target(
    fixture: SocketFixture,
    path: string,
    maximumBytes: string = '32',
    timeoutMs: number = 2000,
): WindowsUpdateFetchRequest {
    const address: AddressInfo | string | null = fixture.server.address();
    if (address === null || typeof address === 'string') {
        throw new Error('Missing fixture listener');
    }
    return {
        address: `https://localhost:${String(address.port)}${path}`,
        destination: join(fixture.directory, 'download.partial'),
        maximumBytes,
        timeoutMs,
    };
}

it('streams the exact response with TLS 1.3, normal hostname trust and one bounded internal receipt', async (): Promise<void> => {
    await using fixture: SocketFixture = await SocketFixture.create();
    setDefaultCACertificates([...authorities, fixture.certificate.toString('utf8')]);
    let protocol: string | null = null;
    fixture.server.on('request', (request: IncomingMessage, response: ServerResponse): void => {
        if (!(request.socket instanceof TLSSocket)) {
            throw new Error('TLS fixture socket required');
        }
        protocol = request.socket.getProtocol();
        response.write(Buffer.from('signed '));
        response.end(Buffer.from('payload'));
    });
    const request: WindowsUpdateFetchRequest = target(fixture, '/file');
    const output: PassThrough = new PassThrough();
    await WindowsUpdateFetch.command(
        Readable.from([Buffer.from(JSON.stringify(request), 'utf8')]),
        output,
        new AbortController().signal,
    );
    expect(protocol).toBe('TLSv1.3');
    expect(await readFile(request.destination, 'utf8')).toBe('signed payload');
    const receipt: unknown = output.read();
    if (!Buffer.isBuffer(receipt)) {
        throw new Error('Missing bounded transport receipt');
    }
    expect(receipt.toString('utf8')).toBe('{"bytes":"14","protocol":"TLSv1.3"}\n');
});

it('refuses untrusted certificates and TLS 1.2-only servers without leaving a partial', async (): Promise<void> => {
    await using fixture: SocketFixture = await SocketFixture.create();
    fixture.server.on('request', (_request: IncomingMessage, response: ServerResponse): void => {
        response.end('payload');
    });
    const request: WindowsUpdateFetchRequest = target(fixture, '/file');
    await expect(
        WindowsUpdateFetch.download(request, new AbortController().signal),
    ).rejects.toMatchObject({ code: 'DEPTH_ZERO_SELF_SIGNED_CERT' });
    setDefaultCACertificates([...authorities, fixture.certificate.toString('utf8')]);
    await expect(
        WindowsUpdateFetch.download(
            { ...request, address: request.address.replace('localhost', '127.0.0.1') },
            new AbortController().signal,
        ),
    ).rejects.toMatchObject({ code: 'ERR_TLS_CERT_ALTNAME_INVALID' });
    fixture.server.setSecureContext({
        cert: fixture.certificate,
        key: await readFile(join(fixture.directory, 'key.pem')),
        minVersion: 'TLSv1.2',
        maxVersion: 'TLSv1.2',
    });
    await expect(
        WindowsUpdateFetch.download(request, new AbortController().signal),
    ).rejects.toBeInstanceOf(WindowsUpdateFetchError);
    expect(await readdir(fixture.directory)).not.toContain('download.partial');
});

it('rejects redirects, declared and streamed overflow, deadline expiry and reset connections and removes owned partials', async (): Promise<void> => {
    await using fixture: SocketFixture = await SocketFixture.create();
    setDefaultCACertificates([...authorities, fixture.certificate.toString('utf8')]);
    let redirected: boolean = false;
    fixture.server.on('request', (request: IncomingMessage, response: ServerResponse): void => {
        if (request.url === '/redirect') {
            response.writeHead(302, { location: '/target' });
            response.end();
        } else if (request.url === '/declared') {
            response.writeHead(200, { 'content-length': '33' });
            response.end('x'.repeat(33));
        } else if (request.url === '/overflow') {
            response.write('x'.repeat(16));
            response.end('x'.repeat(17));
        } else if (request.url === '/timeout') {
            response.write('pending');
        } else if (request.url === '/reset') {
            response.write('partial');
            response.socket?.destroy();
        } else {
            redirected = true;
            response.end('unexpected');
        }
    });
    for (const [path, code] of [
        ['/redirect', 'REDIRECT_DENIED'],
        ['/declared', 'BODY_LIMIT'],
        ['/overflow', 'BODY_LIMIT'],
        ['/timeout', 'TIMEOUT'],
    ] as const) {
        await expect(
            WindowsUpdateFetch.download(
                target(fixture, path, '32', path === '/timeout' ? 50 : 2000),
                new AbortController().signal,
            ),
        ).rejects.toMatchObject({ code });
        expect(await readdir(fixture.directory)).not.toContain('download.partial');
    }
    await expect(
        WindowsUpdateFetch.download(target(fixture, '/reset'), new AbortController().signal),
    ).rejects.toBeInstanceOf(WindowsUpdateFetchError);
    const cancel: AbortController = new AbortController();
    const timer: ReturnType<typeof setTimeout> = setTimeout((): void => cancel.abort(), 25);
    try {
        await expect(
            WindowsUpdateFetch.download(target(fixture, '/timeout'), cancel.signal),
        ).rejects.toMatchObject({ code: 'CANCELED' });
    } finally {
        clearTimeout(timer);
    }
    expect(redirected).toBe(false);
    expect(await readdir(fixture.directory)).not.toContain('download.partial');
});

it('preserves an existing destination, rejects unsafe requests and logs codes without private messages', async (): Promise<void> => {
    await using fixture: SocketFixture = await SocketFixture.create();
    setDefaultCACertificates([...authorities, fixture.certificate.toString('utf8')]);
    fixture.server.on('request', (_request: IncomingMessage, response: ServerResponse): void => {
        response.end('payload');
    });
    const request: WindowsUpdateFetchRequest = target(fixture, '/file');
    await writeFile(request.destination, 'user-owned');
    await expect(
        WindowsUpdateFetch.download(request, new AbortController().signal),
    ).rejects.toMatchObject({ code: 'EEXIST' });
    expect(await readFile(request.destination, 'utf8')).toBe('user-owned');
    for (const address of [
        'http://localhost/file',
        'https://user:private@localhost/file',
        'https://localhost/file?private=yes',
        'https://localhost/file#private',
    ]) {
        await expect(
            WindowsUpdateFetch.download({ ...request, address }, new AbortController().signal),
        ).rejects.toMatchObject({ code: 'INPUT_INVALID' });
    }
    await expect(
        WindowsUpdateFetch.command(
            Readable.from([Buffer.alloc(16385)]),
            new PassThrough(),
            new AbortController().signal,
        ),
    ).rejects.toMatchObject({ code: 'INPUT_LIMIT' });
    const cause: Error = Object.assign(new Error('private host/path'), {
        code: 'ERR_TLS_CERT_ALTNAME_INVALID',
    });
    expect(WindowsUpdateFetchError.from(cause).message).toBe(
        'windows-update-fetch code=ERR_TLS_CERT_ALTNAME_INVALID',
    );
});
