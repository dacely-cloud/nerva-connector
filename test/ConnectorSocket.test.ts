// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

import { once } from 'node:events';
import { ConnectorStartupDisplay } from '../src/cli/ConnectorStartupDisplay.js';
import type { Duplex } from 'node:stream';
import { expect, it } from 'vitest';
import type { ConnectorSocket } from '../src/networking/ConnectorSocket.js';
import { SocketFixture } from './support/SocketFixture.js';
import {
    ConnectorStartupStage,
    type ConnectorStartupProgress,
} from '../src/runtime/ConnectorStartup.js';

/** Expected transport failures still need their terminal event joined, rather than an error-sensitive events.once. */
function closed(socket: ConnectorSocket): Promise<void> {
    const result: PromiseWithResolvers<undefined> = Promise.withResolvers<undefined>();
    socket.once('close', (): void => result.resolve(undefined));
    return result.promise;
}

it.each([true, false])(
    'startup phases reflect the actual TLS socket, and rejected trust cannot reach upgrade: %s',
    async (trusted: boolean): Promise<void> => {
        await using fixture: SocketFixture = await SocketFixture.create();
        const stages: ConnectorStartupStage[] = [];
        const client: ConnectorSocket = fixture.connect(
            trusted,
            'localhost',
            32,
            (progress: ConnectorStartupProgress): void => {
                stages.push(progress.stage);
            },
        );
        if (trusted) {
            await once(client, 'open');
            expect(stages).toEqual([
                ConnectorStartupStage.Dns,
                ConnectorStartupStage.Tcp,
                ConnectorStartupStage.Tls,
                ConnectorStartupStage.Upgrade,
            ]);
        } else {
            await closed(client);
            expect(stages).toEqual([
                ConnectorStartupStage.Dns,
                ConnectorStartupStage.Tcp,
                ConnectorStartupStage.Tls,
            ]);
            expect(fixture.requests).toHaveLength(0);
        }
        expect(stages).not.toContain(ConnectorStartupStage.Ready);
    },
);

it('native WebSocket verifies a private CA, disables compression and decodes text and binary frames', async (): Promise<void> => {
    await using fixture: SocketFixture = await SocketFixture.create();
    const client: ConnectorSocket = fixture.connect();
    const messages: Buffer[] = [];
    const binary: boolean[] = [];
    const received: PromiseWithResolvers<undefined> = Promise.withResolvers<undefined>();
    client.on('message', (data: Buffer, isBinary: boolean): void => {
        messages.push(data);
        binary.push(isBinary);
        if (messages.length === 2) {
            received.resolve(undefined);
        }
    });
    await once(client, 'open');
    const peer: Duplex = await fixture.upgraded.promise;
    expect(fixture.requests[0]?.headers['sec-websocket-extensions']).toBeUndefined();
    peer.write(Buffer.from([0x81, 0x02, 0x6f, 0x6b, 0x82, 0x02, 0x00, 0xff]));
    await received.promise;
    expect(messages).toEqual([Buffer.from('ok'), Buffer.from([0, 255])]);
    expect(binary).toEqual([false, true]);
    expect(client.isOpen).toBe(true);
});

it.each([
    { trusted: false, hostname: 'localhost' },
    { trusted: true, hostname: '127.0.0.1' },
])(
    'native client refuses missing CA or wrong certificate hostname: $trusted/$hostname',
    async (settings): Promise<void> => {
        await using fixture: SocketFixture = await SocketFixture.create();
        const client: ConnectorSocket = fixture.connect(settings.trusted, settings.hostname);
        const finished: Promise<void> = closed(client);
        let opened: boolean = false;
        client.once('open', (): void => {
            opened = true;
        });
        await finished;
        expect(opened).toBe(false);
        expect(fixture.requests).toHaveLength(0);
    },
);

it.each(['payload', 'fragments'] as const)(
    'native parser closes a peer exceeding its %s budget before delivering a message',
    async (budget): Promise<void> => {
        await using fixture: SocketFixture = await SocketFixture.create();
        const client: ConnectorSocket = fixture.connect();
        let delivered: boolean = false;
        client.on('message', (): void => {
            delivered = true;
        });
        await once(client, 'open');
        const finished: Promise<void> = closed(client);
        const peer: Duplex = await fixture.upgraded.promise;
        if (budget === 'payload') {
            // A fragmented message exceeds the cumulative budget despite each fragment fitting.
            peer.write(
                Buffer.concat([
                    Buffer.from([0x01, 20]),
                    Buffer.alloc(20, 97),
                    Buffer.from([0x80, 20]),
                    Buffer.alloc(20, 97),
                ]),
            );
        } else {
            // Empty fragments must also have a finite work budget.
            const frames: Buffer[] = [Buffer.from([0x01, 0])];
            for (let index: number = 0; index < 64; index++) {
                frames.push(Buffer.from([0x00, 0]));
            }
            frames.push(Buffer.from([0x80, 0]));
            peer.write(Buffer.concat(frames));
        }
        await finished;
        expect(delivered).toBe(false);
    },
);

it('native transport cancellation releases a connection while its upgrade is pending', async (): Promise<void> => {
    await using fixture: SocketFixture = await SocketFixture.create();
    fixture.server.removeAllListeners('upgrade');
    const requested: PromiseWithResolvers<undefined> = Promise.withResolvers<undefined>();
    fixture.server.on('upgrade', (): void => requested.resolve(undefined));
    const client: ConnectorSocket = fixture.connect();
    const finished: Promise<void> = closed(client);
    await requested.promise;
    client.terminate();
    client.terminate();
    await finished;
    expect(client.isOpen).toBe(false);
});

it('an actual stalled TLS upgrade keeps its named elapsed stage visible without claiming authentication', async (): Promise<void> => {
    await using fixture: SocketFixture = await SocketFixture.create();
    fixture.server.removeAllListeners('upgrade');
    const requested: PromiseWithResolvers<undefined> = Promise.withResolvers<undefined>();
    fixture.server.on('upgrade', (): void => requested.resolve(undefined));
    const lines: string[] = [];
    using display: ConnectorStartupDisplay = new ConnectorStartupDisplay((text: string): void => {
        lines.push(text);
    }, true);
    const client: ConnectorSocket = fixture.connect(
        true,
        'localhost',
        32,
        (event: ConnectorStartupProgress): void => display.update(event),
    );
    const finished: Promise<void> = closed(client);
    try {
        await requested.promise;
        await expect
            .poll((): string | undefined => lines.at(-1), { timeout: 3000, interval: 25 })
            .toContain('Opening secure tunnel · 1s');
        expect(client.isOpen).toBe(false);
        expect(lines.join('\n')).not.toContain('Authenticated');
    } finally {
        client.terminate();
        await finished;
    }
});

it('a real HTTP 502 retains its safe status through retry without displaying response content', async (): Promise<void> => {
    await using fixture: SocketFixture = await SocketFixture.create();
    fixture.server.removeAllListeners('upgrade');
    fixture.server.on('upgrade', (_request, socket: Duplex): void => {
        socket.end(
            'HTTP/1.1 502 Bad Gateway\r\nContent-Length: 22\r\nConnection: close\r\n\r\nprivate-upstream-detail',
        );
    });
    const lines: string[] = [];
    using display: ConnectorStartupDisplay = new ConnectorStartupDisplay((text: string): void => {
        lines.push(text);
    }, true);
    const client: ConnectorSocket = fixture.connect(
        true,
        'localhost',
        32,
        (event: ConnectorStartupProgress): void => display.update(event),
    );
    await closed(client);
    expect(lines.at(-1)).toContain('Server rejected tunnel · HTTP 502');
    display.update({ stage: ConnectorStartupStage.Closing });
    display.update({ stage: ConnectorStartupStage.Retry, retryAfterMs: 3000 });
    expect(lines.at(-1)).toContain('after: Server rejected tunnel (HTTP 502)');
    expect(lines.join('\n')).not.toContain('private-upstream-detail');
    expect(lines.join('\n')).not.toContain('Authenticated');
});
