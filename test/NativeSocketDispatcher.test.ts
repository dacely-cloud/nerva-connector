// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

import type { IncomingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Duplex } from 'node:stream';
import { expect, it } from 'vitest';
import { NativeSocketDispatcher } from '../src/networking/NativeSocketDispatcher.js';
import { SocketFixture } from './support/SocketFixture.js';

/** What a Node 24 (Undici 7) shaped WebSocket handler observed from the dispatcher. */
interface LegacyHandlerRecord {
    readonly connects: number;
    readonly errors: readonly Error[];
    readonly upgrade: Promise<LegacyUpgrade>;
    readonly failed: Promise<Error>;
}

/** The upgrade arguments the handler received. */
interface LegacyUpgrade {
    readonly controller: unknown;
    readonly status: number;
    readonly protocol: string | string[] | undefined;
}

/** Mirrors the callback names Node 24's built-in WebSocket gives a custom dispatcher. */
class LegacyHandler {
    readonly #upgrade: PromiseWithResolvers<LegacyUpgrade> = Promise.withResolvers<LegacyUpgrade>();
    readonly #failed: PromiseWithResolvers<Error> = Promise.withResolvers<Error>();
    readonly #errors: Error[] = [];
    #connects: number = 0;

    /** Counts starts; the abort callback is not needed by these cases. */
    public onConnect(): void {
        this.#connects += 1;
    }
    /** Records a pre-upgrade failure. */
    public onError(error: Error): void {
        this.#errors.push(error);
        this.#failed.resolve(error);
    }
    /** Accepts the upgrade the way Node 24's fetch handler does. */
    public onRequestUpgrade(
        controller: unknown,
        status: number,
        headers: IncomingHttpHeaders,
        socket: Duplex,
    ): boolean {
        socket.destroy();
        this.#upgrade.resolve({ controller, status, protocol: headers['sec-websocket-protocol'] });
        return true;
    }

    /** A snapshot of what was observed. */
    public get record(): LegacyHandlerRecord {
        return {
            connects: this.#connects,
            errors: this.#errors,
            upgrade: this.#upgrade.promise,
            failed: this.#failed.promise,
        };
    }
}

function endpoint(fixture: SocketFixture): string {
    const address: AddressInfo | string | null = fixture.server.address();
    if (address === null || typeof address === 'string') {
        throw new Error('Missing test listener');
    }
    return 'wss://localhost:' + String(address.port) + '/';
}

function request(target: string, protocol: string): Readonly<Record<string, unknown>> {
    const url: URL = new URL(target);
    url.protocol = 'https:';
    return {
        origin: url.origin,
        path: '/',
        method: 'GET',
        upgrade: 'websocket',
        headers: {
            'sec-websocket-key': Buffer.alloc(16, 7).toString('base64'),
            'sec-websocket-version': '13',
            'sec-websocket-protocol': protocol,
        },
    };
}

it('drives a Node 24 shaped handler through start, verified upgrade and pre-upgrade failure', async (): Promise<void> => {
    await using fixture: SocketFixture = await SocketFixture.create();
    const target: string = endpoint(fixture);
    const trusted: NativeSocketDispatcher = new NativeSocketDispatcher(
        target,
        fixture.certificate,
        2000,
        32,
    );
    const accepted: LegacyHandler = new LegacyHandler();
    expect(trusted.dispatch(request(target, fixture.protocol), accepted)).toBe(true);
    const upgrade: LegacyUpgrade = await accepted.record.upgrade;
    expect(upgrade).toEqual({ controller: trusted, status: 101, protocol: fixture.protocol });
    expect(accepted.record.connects).toBe(1);
    expect(accepted.record.errors).toEqual([]);
    trusted.abort();

    const untrusted: NativeSocketDispatcher = new NativeSocketDispatcher(
        target,
        undefined,
        2000,
        32,
    );
    const rejected: LegacyHandler = new LegacyHandler();
    untrusted.dispatch(request(target, fixture.protocol), rejected);
    expect(await rejected.record.failed).toBeInstanceOf(Error);
    expect(rejected.record.connects).toBe(1);
    expect(rejected.record.errors).toHaveLength(1);
    expect(fixture.requests).toHaveLength(1);
});

it('refuses a handler that matches neither native WebSocket callback set', (): void => {
    const dispatcher: NativeSocketDispatcher = new NativeSocketDispatcher(
        'wss://localhost:9/',
        undefined,
        2000,
        32,
    );
    for (const handler of [
        { onRequestUpgrade: (): boolean => true },
        { onConnect: (): void => {}, onRequestUpgrade: (): boolean => true },
        { onRequestStart: (): void => {}, onError: (): void => {} },
        null,
    ]) {
        expect((): boolean =>
            dispatcher.dispatch(request('wss://localhost:9/', 'x'), handler),
        ).toThrow('Unsupported native WebSocket dispatcher invocation');
    }
});
