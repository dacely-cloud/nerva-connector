// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

import { createHash, type Hash } from 'node:crypto';
import { open, rm, type FileHandle } from 'node:fs/promises';
import { ConnectorUpdateManifest } from './ConnectorUpdateManifest.js';
import type { ConnectorUpdateRelease, ConnectorUpdateSettings } from './ConnectorUpdateProtocol.js';

/** Bounded HTTPS downloads never follow redirects or execute unverified installer bytes. */
export class ConnectorUpdateDownload {
    /** Reads and authenticates the exact feed before selecting the current native architecture. */
    public static async check(
        settings: ConnectorUpdateSettings,
        signal: AbortSignal,
    ): Promise<ConnectorUpdateRelease | null> {
        const directory: URL = ConnectorUpdateManifest.directory(settings.feedUrl);
        const stop: AbortController = new AbortController();
        const bounded: AbortSignal = AbortSignal.any([signal, stop.signal]);
        const pending: readonly [Promise<Buffer>, Promise<Buffer>] = [
            this.bytes(
                new URL('latest.json', directory),
                ConnectorUpdateManifest.maximumBytes,
                bounded,
            ),
            this.bytes(new URL('latest.json.sig', directory), 4096, bounded),
        ];
        let responses: readonly [Buffer, Buffer];
        try {
            responses = await Promise.all(pending);
        } catch (caught: unknown) {
            stop.abort();
            await Promise.allSettled(pending);
            throw caught;
        }
        return ConnectorUpdateManifest.select(
            responses[0],
            new TextDecoder('utf-8', { fatal: true }).decode(responses[1]),
            settings,
        );
    }

    /** Streams a signed exact-size installer to an exclusively created private staging file; failures remove it. */
    public static async installer(
        settings: ConnectorUpdateSettings,
        release: ConnectorUpdateRelease,
        destination: string,
        signal: AbortSignal,
    ): Promise<void> {
        const url: URL = new URL(
            release.artifact.name,
            ConnectorUpdateManifest.directory(settings.feedUrl),
        );
        const response: Response = await this.#response(url, signal, 180000);
        let file: FileHandle | null = null;
        let complete: boolean = false;
        try {
            file = await open(destination, 'wx', 0o600);
            const hash: Hash = createHash('sha256');
            let bytes: bigint = 0n;
            for await (const chunk of this.#body(response)) {
                bytes += BigInt(chunk.byteLength);
                if (bytes > release.artifact.size) {
                    throw new Error('Update download exceeds its signed size');
                }
                hash.update(chunk);
                await file.writeFile(chunk);
            }
            if (bytes !== release.artifact.size || hash.digest('hex') !== release.artifact.sha256) {
                throw new Error('Update download differs from its signed size or SHA-256');
            }
            await file.sync();
            complete = true;
        } finally {
            if (!response.body?.locked) {
                await response.body?.cancel();
            }
            if (file !== null) {
                await file.close();
                if (!complete) {
                    await rm(destination, { force: true });
                }
            }
        }
    }

    /** Small feed responses are bounded while streaming, before decoding or concatenation. */
    public static async bytes(url: URL, maximum: number, signal: AbortSignal): Promise<Buffer> {
        const response: Response = await this.#response(url, signal);
        const chunks: Buffer[] = [];
        let size: number = 0;
        for await (const chunk of this.#body(response)) {
            size += chunk.byteLength;
            if (size > maximum) {
                throw new Error('Update response exceeds its byte limit');
            }
            chunks.push(Buffer.from(chunk));
        }
        return Buffer.concat(chunks, size);
    }

    static async #response(
        url: URL,
        signal: AbortSignal,
        timeout: number = 20000,
    ): Promise<Response> {
        if (
            url.protocol !== 'https:' ||
            url.username !== '' ||
            url.password !== '' ||
            url.search !== '' ||
            url.hash !== '' ||
            url.href.length > 4096
        ) {
            throw new Error('Updates require a fixed HTTPS URL');
        }
        const response: Response = await fetch(url, {
            redirect: 'error',
            cache: 'no-store',
            signal: AbortSignal.any([signal, AbortSignal.timeout(timeout)]),
        });
        if (!response.ok || response.body === null) {
            await response.body?.cancel();
            throw new Error(`Update request failed: HTTP ${response.status.toString()}`);
        }
        return response;
    }

    static #body(response: Response): ReadableStream<Uint8Array> {
        if (response.body === null) {
            throw new Error('Update response has no body');
        }
        return response.body;
    }
}
