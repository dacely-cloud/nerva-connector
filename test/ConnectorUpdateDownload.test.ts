// SPDX-FileCopyrightText: 2026 Dacely <business@dacely.com>
// SPDX-License-Identifier: LicenseRef-Proprietary

import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { ConnectorUpdateDownload } from '../src/update/ConnectorUpdateDownload.js';
import type {
    ConnectorUpdateRelease,
    ConnectorUpdateSettings,
} from '../src/update/ConnectorUpdateProtocol.js';

const settings: ConnectorUpdateSettings = {
    version: '1.0.0',
    platform: 'linux',
    architecture: 'x64',
    feedUrl: 'https://downloads.example.test/linux/',
    publicKey: '',
    helperSha256: 'a'.repeat(64),
    files: [],
};
const payload: Uint8Array = new TextEncoder().encode('signed fixture installer');
const release: ConnectorUpdateRelease = {
    version: '1.1.0',
    artifact: {
        name: 'Nerva-Connector-Setup-1.1.0-x64.run',
        size: BigInt(payload.byteLength),
        sha256: createHash('sha256').update(payload).digest('hex'),
    },
};

afterEach((): void => {
    vi.unstubAllGlobals();
});

it('checks exact streamed length/hash, removes failed partial files and preserves an existing destination', async (): Promise<void> => {
    const directory: string = await mkdtemp(join(tmpdir(), 'nerva-update-download-'));
    try {
        const destination: string = join(directory, 'installer');
        for (const bytes of [
            payload.slice(0, -1),
            new Uint8Array(payload.length + 1),
            new Uint8Array(payload.length),
        ]) {
            vi.stubGlobal('fetch', (): Promise<Response> => Promise.resolve(new Response(bytes)));
            await expect(
                ConnectorUpdateDownload.installer(
                    settings,
                    release,
                    destination,
                    new AbortController().signal,
                ),
            ).rejects.toThrow();
            expect(await readdir(directory)).toEqual([]);
        }
        vi.stubGlobal(
            'fetch',
            (_input: string | URL | Request, options?: RequestInit): Promise<Response> => {
                expect(options?.redirect).toBe('error');
                return Promise.resolve(
                    new Response(
                        new ReadableStream<Uint8Array>({
                            start(controller: ReadableStreamDefaultController<Uint8Array>): void {
                                controller.enqueue(payload.slice(0, 3));
                                controller.enqueue(payload.slice(3));
                                controller.close();
                            },
                        }),
                    ),
                );
            },
        );
        await ConnectorUpdateDownload.installer(
            settings,
            release,
            destination,
            new AbortController().signal,
        );
        expect(await readFile(destination)).toEqual(Buffer.from(payload));
        await writeFile(destination, 'user-owned');
        await expect(
            ConnectorUpdateDownload.installer(
                settings,
                release,
                destination,
                new AbortController().signal,
            ),
        ).rejects.toThrow();
        expect(await readFile(destination, 'utf8')).toBe('user-owned');
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});

it('cancels oversized small responses and refuses insecure locations before requesting them', async (): Promise<void> => {
    let cancelled: boolean = false;
    const fetch: ReturnType<typeof vi.fn> = vi.fn((): Promise<Response> =>
        Promise.resolve(
            new Response(
                new ReadableStream<Uint8Array>({
                    start(controller: ReadableStreamDefaultController<Uint8Array>): void {
                        controller.enqueue(new Uint8Array(33));
                    },
                    cancel(): void {
                        cancelled = true;
                    },
                }),
            ),
        ),
    );
    vi.stubGlobal('fetch', fetch);
    await expect(
        ConnectorUpdateDownload.bytes(new URL(settings.feedUrl), 32, new AbortController().signal),
    ).rejects.toThrow('byte limit');
    expect(cancelled).toBe(true);
    await expect(
        ConnectorUpdateDownload.bytes(
            new URL('http://downloads.example.test/'),
            32,
            new AbortController().signal,
        ),
    ).rejects.toThrow('HTTPS');
    expect(fetch).toHaveBeenCalledTimes(1);
});
