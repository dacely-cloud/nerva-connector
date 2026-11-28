// SPDX-FileCopyrightText: 2026 Dacely <business@dacely.com>
// SPDX-License-Identifier: LicenseRef-Proprietary

import { isIP } from 'node:net';
import { type HostHttpRequest } from './HostHttpTypes.js';
import { ConnectorHostHttpMethod } from 'nerva-connector-protocol/protocol/ConnectorHostArgumentChoices.js';

/** The socket capability cannot acquire proxy, redirect or credential authority from user headers. */
export class HostHttpValidation {
    static readonly #headers: ReadonlySet<string> = new Set([
        'accept',
        'accept-encoding',
        'user-agent',
        'range',
        'if-match',
        'if-none-match',
        'if-modified-since',
        'if-unmodified-since',
    ]);

    /** Validation applies to typed internal callers as well as decoded tool requests. */
    public static request(request: HostHttpRequest): URL {
        const url: URL = new URL(request.url);
        const hostname: string = url.hostname.replace(/^\[|\]$/gu, '');
        if (
            !request.url.isWellFormed() ||
            request.url.length > 16384 ||
            !['http:', 'https:'].includes(url.protocol) ||
            url.username !== '' ||
            url.password !== '' ||
            url.hash !== '' ||
            (url.port !== '' && Number(url.port) < 1) ||
            hostname.length === 0 ||
            isIP(request.address) === 0 ||
            request.address.includes('%') ||
            (isIP(hostname) !== 0 && this.#address(hostname) !== this.#address(request.address)) ||
            !Object.values(ConnectorHostHttpMethod).includes(request.method) ||
            request.maximumBytes < 1n ||
            request.maximumBytes > 104857600n ||
            !Number.isSafeInteger(request.timeoutMs) ||
            request.timeoutMs < 1000 ||
            request.timeoutMs > 900000 ||
            !Number.isSafeInteger(request.idleTimeoutMs) ||
            request.idleTimeoutMs < 1000 ||
            request.idleTimeoutMs > 30000 ||
            Object.keys(request.headers).length > this.#headers.size
        ) {
            throw new Error('Invalid pinned native HTTP request');
        }
        let bytes: number = 0;
        const names: Set<string> = new Set();
        for (const [name, value] of Object.entries(request.headers)) {
            const normalized: string = name.toLowerCase();
            bytes += Buffer.byteLength(name) + Buffer.byteLength(value);
            if (
                !this.#headers.has(normalized) ||
                names.has(normalized) ||
                !value.isWellFormed() ||
                /[^\t\x20-\x7e]/u.test(value) ||
                bytes > 16384 ||
                (normalized === 'accept-encoding' && value.trim().toLowerCase() !== 'identity')
            ) {
                throw new Error('Invalid pinned native HTTP headers');
            }
            names.add(normalized);
        }
        return url;
    }

    /** DNS names are sent to the local system's DNS servers as complete names. */
    public static hostname(hostname: string): void {
        if (isIP(hostname) !== 0 && !hostname.includes('%')) {
            return;
        }
        if (
            hostname.length < 1 ||
            hostname.length > 253 ||
            !/^[a-z0-9.-]+$/iu.test(hostname) ||
            hostname.split('.').some((part: string): boolean => part.length > 63)
        ) {
            throw new Error('Invalid native DNS hostname');
        }
    }

    static #address(value: string): string {
        return isIP(value) === 6 ? new URL('http://[' + value + ']/').hostname : value;
    }
}
