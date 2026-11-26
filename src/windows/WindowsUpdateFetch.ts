// SPDX-FileCopyrightText: 2026 Dacely <business@dacely.com>
// SPDX-License-Identifier: LicenseRef-Proprietary

import { request } from 'node:https';
import type { ClientRequest, IncomingMessage } from 'node:http';
import { open, rm, type FileHandle } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { TLSSocket } from 'node:tls';
import type { Readable, Writable } from 'node:stream';
import { Boundary } from 'nerva-connector-protocol/protocol/Boundary.js';
import {
    WindowsUpdateFetchProtocol,
    type WindowsUpdateFetchRequest,
    type WindowsUpdateFetchReceipt,
} from './WindowsUpdateFetchProtocol.js';
import { WindowsUpdateFetchError } from './WindowsUpdateFetchError.js';

/** The installed Node runtime supplies HTTPS only; the native supervisor keeps signature and installation authority. */
export class WindowsUpdateFetch {
    /** Runs one bounded stdin request and returns one small receipt without opening connector state or a console. */
    public static async command(
        input: Readable,
        output: Writable,
        signal: AbortSignal,
    ): Promise<void> {
        const bounded: AbortSignal = AbortSignal.any([signal, AbortSignal.timeout(5000)]);
        const abort: () => void = (): void => {
            input.destroy(new WindowsUpdateFetchError('INPUT_TIMEOUT'));
        };
        const chunks: Buffer[] = [];
        let bytes: number = 0;
        bounded.addEventListener('abort', abort, { once: true });
        try {
            bounded.throwIfAborted();
            for await (const raw of input) {
                const chunk: unknown = raw;
                if (
                    !Buffer.isBuffer(chunk) ||
                    bytes + chunk.length > WindowsUpdateFetchProtocol.requestBytes
                ) {
                    throw new WindowsUpdateFetchError('INPUT_LIMIT');
                }
                chunks.push(chunk);
                bytes += chunk.length;
            }
        } catch (caught: unknown) {
            throw WindowsUpdateFetchError.from(caught);
        } finally {
            bounded.removeEventListener('abort', abort);
        }
        let checked: WindowsUpdateFetchRequest;
        try {
            const raw: unknown = JSON.parse(
                new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, bytes)),
            );
            checked = this.#request(raw);
        } catch {
            throw new WindowsUpdateFetchError('INPUT_INVALID');
        }
        const receipt: WindowsUpdateFetchReceipt = await this.download(checked, signal);
        output.write(JSON.stringify(receipt) + '\n');
    }

    /** Streams one exact HTTPS response to an exclusively created file; every unsuccessful owned partial is removed. */
    public static async download(
        raw: WindowsUpdateFetchRequest,
        signal: AbortSignal,
    ): Promise<WindowsUpdateFetchReceipt> {
        const checked: WindowsUpdateFetchRequest = this.#request(raw);
        const maximum: bigint = BigInt(checked.maximumBytes);
        const deadline: AbortSignal = AbortSignal.timeout(checked.timeoutMs);
        const bounded: AbortSignal = AbortSignal.any([signal, deadline]);
        let response: IncomingMessage | null = null;
        let file: FileHandle | null = null;
        let created: boolean = false;
        let complete: boolean = false;
        try {
            response = await this.#response(new URL(checked.address), checked.timeoutMs, bounded);
            if (response.statusCode !== 200) {
                throw new WindowsUpdateFetchError(
                    (response.statusCode ?? 0) >= 300 && (response.statusCode ?? 0) <= 399
                        ? 'REDIRECT_DENIED'
                        : 'HTTP_' + String(response.statusCode ?? 0),
                );
            }
            if (
                !(response.socket instanceof TLSSocket) ||
                !response.socket.authorized ||
                response.socket.getProtocol() !== WindowsUpdateFetchProtocol.tls
            ) {
                throw new WindowsUpdateFetchError('TLS_PROTOCOL');
            }
            if (
                response.headers['content-encoding'] !== undefined &&
                response.headers['content-encoding'] !== 'identity'
            ) {
                throw new WindowsUpdateFetchError('CONTENT_ENCODING');
            }
            const length: string | undefined = response.headers['content-length'];
            if (
                length !== undefined &&
                (!/^(0|[1-9][0-9]{0,8})$/u.test(length) || BigInt(length) > maximum)
            ) {
                throw new WindowsUpdateFetchError('BODY_LIMIT');
            }
            file = await open(checked.destination, 'wx', 0o600);
            created = true;
            let bytes: bigint = 0n;
            for await (const rawChunk of response) {
                const chunk: unknown = rawChunk;
                if (!Buffer.isBuffer(chunk)) {
                    throw new WindowsUpdateFetchError('BODY_INVALID');
                }
                bytes += BigInt(chunk.length);
                if (bytes > maximum) {
                    throw new WindowsUpdateFetchError('BODY_LIMIT');
                }
                bounded.throwIfAborted();
                await file.writeFile(chunk);
            }
            if (length !== undefined && bytes !== BigInt(length)) {
                throw new WindowsUpdateFetchError('BODY_LENGTH');
            }
            bounded.throwIfAborted();
            await file.sync();
            await file.close();
            file = null;
            complete = true;
            return { bytes: bytes.toString(), protocol: WindowsUpdateFetchProtocol.tls };
        } catch (caught: unknown) {
            throw deadline.aborted
                ? new WindowsUpdateFetchError('TIMEOUT')
                : signal.aborted
                  ? new WindowsUpdateFetchError('CANCELED')
                  : WindowsUpdateFetchError.from(caught);
        } finally {
            response?.destroy();
            try {
                await file?.close();
            } finally {
                if (created && !complete) {
                    await rm(checked.destination, { force: true });
                }
            }
        }
    }

    static #request(raw: unknown): WindowsUpdateFetchRequest {
        const value: Readonly<Record<string, unknown>> = Boundary.record(raw, [
            'address',
            'destination',
            'maximumBytes',
            'timeoutMs',
        ]);
        if (
            typeof value['address'] !== 'string' ||
            typeof value['destination'] !== 'string' ||
            typeof value['maximumBytes'] !== 'string' ||
            typeof value['timeoutMs'] !== 'number'
        ) {
            throw new WindowsUpdateFetchError('INPUT_INVALID');
        }
        const address: URL = new URL(value['address']);
        const destination: string = value['destination'];
        if (
            address.protocol !== 'https:' ||
            address.username !== '' ||
            address.password !== '' ||
            address.search !== '' ||
            address.hash !== '' ||
            address.href.length > 4096 ||
            destination.length > 4096 ||
            /[\r\n\0]/u.test(destination) ||
            !isAbsolute(destination) ||
            resolve(destination) !== destination ||
            !/^[1-9][0-9]{0,8}$/u.test(value['maximumBytes']) ||
            BigInt(value['maximumBytes']) > WindowsUpdateFetchProtocol.maximumBytes ||
            !Number.isSafeInteger(value['timeoutMs']) ||
            value['timeoutMs'] < 1 ||
            value['timeoutMs'] > WindowsUpdateFetchProtocol.maximumTimeoutMs
        ) {
            throw new WindowsUpdateFetchError('INPUT_INVALID');
        }
        return {
            address: address.href,
            destination,
            maximumBytes: value['maximumBytes'],
            timeoutMs: value['timeoutMs'],
        };
    }

    static async #response(
        address: URL,
        timeoutMs: number,
        signal: AbortSignal,
    ): Promise<IncomingMessage> {
        return await new Promise<IncomingMessage>(
            (complete: (response: IncomingMessage) => void, fail: (error: Error) => void): void => {
                const operation: ClientRequest = request(
                    address,
                    {
                        method: 'GET',
                        agent: false,
                        minVersion: WindowsUpdateFetchProtocol.tls,
                        rejectUnauthorized: true,
                        signal,
                        headers: {
                            accept: 'application/octet-stream',
                            'accept-encoding': 'identity',
                            'cache-control': 'no-cache',
                        },
                    },
                    complete,
                );
                operation.once('error', fail);
                operation.setTimeout(Math.min(timeoutMs, 120000), (): void => {
                    operation.destroy(new WindowsUpdateFetchError('IDLE_TIMEOUT'));
                });
                operation.end();
            },
        );
    }
}
