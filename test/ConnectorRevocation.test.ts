// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

import type { AddressInfo } from 'node:net';
import type { Duplex } from 'node:stream';
import { access, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { ConnectorRevocation } from '../src/runtime/ConnectorRevocation.js';
import { ConnectorLogout } from '../src/runtime/ConnectorLogout.js';
import { ConnectorClient } from '../src/runtime/ConnectorClient.js';
import { ConnectorClientConnection } from '../src/runtime/ConnectorClientConnection.js';
import { ConnectorClientState } from '../src/runtime/ConnectorClientState.js';
import { ConnectorDisconnect } from '../src/runtime/ConnectorDisconnect.js';
import {
    ConnectorFrameKind,
    ConnectorTransportCodec,
    ConnectorTransportLimits,
    type ConnectorServerFrame,
} from '../src/protocol/ConnectorTransport.js';
import {
    ConnectorPrivateDirectory,
    ConnectorDirectoryPurpose,
} from '../src/runtime/ConnectorPrivateDirectory.js';
import { ConnectorPairConfiguration } from '../src/runtime/ConnectorPairConfiguration.js';
import { ConnectorDeviceKey } from '../src/runtime/ConnectorDeviceKey.js';
import { ConnectorConsoleModel, ConnectorConsolePhase } from '../src/cli/ConnectorConsoleModel.js';
import { ConnectorSessionFixture } from './support/ConnectorSessionFixture.js';
import { ConnectorRevocationFixture } from './support/ConnectorRevocationFixture.js';
import { SocketFixture } from './support/SocketFixture.js';
import { SystemInfo } from '../src/system/SystemInfo.js';
import type { SystemSpecification } from 'nerva-connector-protocol/system/SystemSpecification.js';
import { ConnectorLifecyclePeer } from './support/ConnectorLifecyclePeer.js';
import type { ConnectorUnpair } from 'nerva-connector-protocol/protocol/ConnectorUnpair.js';
import { ConnectorUnpairCodec } from 'nerva-connector-protocol/protocol/ConnectorUnpair.js';
import { SignaturePurpose } from 'nerva-connector-protocol/identity/IdentityFormat.js';
import {
    ConnectorStartupStage,
    type ConnectorStartupProgress,
} from '../src/runtime/ConnectorStartup.js';

afterEach((): void => {
    vi.restoreAllMocks();
});

/** A TLS test peer emits the normal bounded control frame, not an injected client callback. */
function send(socket: Duplex, frame: ConnectorServerFrame): void {
    const body: Buffer = Buffer.from(ConnectorTransportCodec.encode(frame));
    const header: Buffer = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 126;
    header.writeUInt16BE(body.length, 2);
    socket.write(Buffer.concat([header, body]));
}

it('only the pinned authority can retire this exact device key', (): void => {
    using fixture: ConnectorSessionFixture = new ConnectorSessionFixture();
    using other: ConnectorSessionFixture = new ConnectorSessionFixture();
    const target: Pick<ConnectorUnpair, 'authorityId' | 'publicKey'> = {
        authorityId: fixture.identity.authority.authorityId,
        publicKey: fixture.device.publicKey,
    };
    const signature: string = fixture.authority.sign(
        SignaturePurpose.DeviceUnpaired,
        Buffer.from(ConnectorUnpairCodec.payload(target)),
    );
    const receipt: ConnectorUnpair = { ...target, signature };
    expect(
        ConnectorRevocation.verify(fixture.identity.authority, fixture.device.publicKey, receipt),
    ).toEqual(receipt);
    expect((): void => {
        ConnectorRevocation.verify(other.identity.authority, fixture.device.publicKey, receipt);
    }).toThrow('authority proof');
    expect((): void => {
        ConnectorRevocation.verify(fixture.identity.authority, other.device.publicKey, receipt);
    }).toThrow('authority proof');
    expect((): void => {
        ConnectorRevocation.verify(fixture.identity.authority, fixture.device.publicKey, {
            ...receipt,
            authorityId: 'another-deployment',
        });
    }).toThrow('authority proof');
    expect((): void => {
        ConnectorRevocation.verify(fixture.identity.authority, fixture.device.publicKey, {
            ...receipt,
            signature: fixture.device.sign(
                SignaturePurpose.DeviceUnpair,
                Buffer.from(ConnectorUnpairCodec.payload(target)),
            ),
        });
    }).toThrow('authority proof');
});

it.skipIf(process.platform !== 'linux')(
    'verified retirement blocks the old explicit runtime and resolves one new unpaired successor without another network request',
    async (): Promise<void> => {
        await using fixture: ConnectorRevocationFixture = await ConnectorRevocationFixture.create(
            'wss://example.invalid/v1/connector/tunnel',
        );
        const original: Buffer = await readFile(join(fixture.state, 'device-key.json'));
        await ConnectorRevocation.record(fixture.identity, fixture.receipt());
        await ConnectorRevocation.record(fixture.identity, fixture.receipt());
        await expect(
            ConnectorClient.load(fixture.identity.configurationFile, (): void => undefined),
        ).rejects.toThrow('logged out');
        const next: string = await ConnectorLogout.resolve(
            fixture.pairingFile,
            new AbortController().signal,
        );
        expect(
            await ConnectorLogout.resolve(fixture.pairingFile, new AbortController().signal),
        ).toBe(next);
        const pairing: Awaited<ReturnType<typeof ConnectorPairConfiguration.load>> =
            await ConnectorPairConfiguration.load(next);
        const device: Awaited<ReturnType<typeof ConnectorDeviceKey.load>> =
            await ConnectorDeviceKey.load(join(pairing.settings.stateDirectory, 'device-key.json'));
        using key: typeof device.key = device.key;
        expect(key.publicKey).not.toBe(fixture.identity.publicKey);
        expect(pairing.settings.files).toBeNull();
        expect(pairing.settings.execution).toBeNull();
        expect(await readFile(join(fixture.state, 'device-key.json'))).toEqual(original);
        expect(await readFile(join(fixture.state, 'file-journal'), 'utf8')).toBe(
            'retained native operation evidence',
        );
        await expect(ConnectorLogout.requireActive(fixture.state)).rejects.toThrow('logged out');
    },
);

it.skipIf(process.platform !== 'linux')(
    'an invalid persisted receipt cannot create a successor or revive its retired runtime',
    async (): Promise<void> => {
        await using fixture: ConnectorRevocationFixture = await ConnectorRevocationFixture.create(
            'wss://example.invalid/v1/connector/tunnel',
        );
        await using directory: ConnectorPrivateDirectory = await ConnectorPrivateDirectory.open(
            fixture.state,
            ConnectorDirectoryPurpose.Pairing,
        );
        await directory.write(
            'revoked-state',
            Buffer.from(JSON.stringify({ ...fixture.receipt(), authorityId: 'wrong-authority' })),
            16384,
            true,
        );
        await directory[Symbol.asyncDispose]();
        await expect(ConnectorLogout.requireActive(fixture.state)).rejects.toThrow('logged out');
        await expect(
            ConnectorLogout.resolve(fixture.pairingFile, new AbortController().signal),
        ).rejects.toThrow('authority proof');
    },
);

it.each([false, true])(
    'the actual outbound client retires its pairing after a signed receipt, already authenticated=%s',
    async (authenticated: boolean): Promise<void> => {
        await using tls: SocketFixture = await SocketFixture.create(
            ConnectorTransportLimits.protocol,
        );
        const bound: AddressInfo | string | null = tls.server.address();
        if (bound === null || typeof bound === 'string') {
            throw new Error('Actual TLS listener required');
        }
        await using fixture: ConnectorRevocationFixture = await ConnectorRevocationFixture.create(
            'wss://localhost:' + bound.port.toString() + ConnectorTransportLimits.path,
            tls.certificate,
        );
        const states: ConnectorClientState[] = [];
        if (authenticated) {
            vi.spyOn(SystemInfo, 'read').mockImplementation(
                async (signal: AbortSignal): Promise<SystemSpecification> => {
                    await new Promise<void>((resolve: () => void): void => {
                        if (signal.aborted) {
                            resolve();
                        } else {
                            signal.addEventListener('abort', (): void => resolve(), { once: true });
                        }
                    });
                    signal.throwIfAborted();
                    throw new Error('Retired inventory cannot complete');
                },
            );
        }
        const connection: ConnectorClientConnection = new ConnectorClientConnection(
            fixture.identity,
            null,
            null,
            (state: ConnectorClientState): void => {
                states.push(state);
            },
        );
        const stop: AbortController = new AbortController();
        const running: Promise<ConnectorDisconnect> = connection.run(
            fixture.identity.settings.endpoints[0] ?? '',
            stop.signal,
        );
        try {
            const socket: Duplex = await tls.upgraded.promise;
            if (authenticated) {
                new ConnectorLifecyclePeer(socket, fixture.session);
                await vi.waitUntil((): boolean =>
                    states.includes(ConnectorClientState.Authenticated),
                );
            }
            send(socket, { kind: ConnectorFrameKind.Unpaired, receipt: fixture.receipt() });
            expect(await running).toBe(ConnectorDisconnect.Revoked);
            expect(connection.revocation).toEqual(fixture.receipt());
        } finally {
            stop.abort();
            connection.terminate();
            await running;
        }
    },
    10000,
);

it.skipIf(process.platform !== 'linux')(
    'the native runtime persists a receipt, releases its local owners and never schedules another connection',
    async (): Promise<void> => {
        await using tls: SocketFixture = await SocketFixture.create(
            ConnectorTransportLimits.protocol,
        );
        const address: AddressInfo | string | null = tls.server.address();
        if (address === null || typeof address === 'string') {
            throw new Error('Actual TLS listener required');
        }
        await using fixture: ConnectorRevocationFixture = await ConnectorRevocationFixture.create(
            'wss://localhost:' + address.port.toString() + ConnectorTransportLimits.path,
            tls.certificate,
        );
        const states: ConnectorClientState[] = [];
        const stages: ConnectorStartupStage[] = [];
        await using client: ConnectorClient = await ConnectorClient.load(
            fixture.identity.configurationFile,
            (state: ConnectorClientState): void => {
                states.push(state);
            },
            (progress: ConnectorStartupProgress): void => {
                stages.push(progress.stage);
            },
        );
        const stop: AbortController = new AbortController();
        const running: Promise<void> = client.run(stop.signal);
        try {
            const socket: Duplex = await tls.upgraded.promise;
            send(socket, { kind: ConnectorFrameKind.Unpaired, receipt: fixture.receipt() });
            await running;
            expect(states.at(-1)).toBe(ConnectorClientState.Revoked);
            expect(
                states.filter(
                    (state: ConnectorClientState): boolean =>
                        state === ConnectorClientState.Connecting,
                ),
            ).toHaveLength(1);
            expect(stages).not.toContain(ConnectorStartupStage.Retry);
            expect(
                JSON.parse(await readFile(join(fixture.state, 'revoked-state'), 'utf8')),
            ).toEqual(fixture.receipt());
            await using reopened: ConnectorPrivateDirectory = await ConnectorPrivateDirectory.open(
                fixture.state,
                ConnectorDirectoryPurpose.Runtime,
            );
            expect(await reopened.exists('device-key.json')).toBe(true);
        } finally {
            stop.abort();
            await client[Symbol.asyncDispose]();
            await running;
        }
    },
    10000,
);

it.skipIf(process.platform !== 'linux').each([false, true])(
    'a network close or unverified retirement preserves pairing and schedules the normal retry, invalid proof=%s',
    async (invalidProof: boolean): Promise<void> => {
        await using tls: SocketFixture = await SocketFixture.create(
            ConnectorTransportLimits.protocol,
        );
        const address: AddressInfo | string | null = tls.server.address();
        if (address === null || typeof address === 'string') {
            throw new Error('Actual TLS listener required');
        }
        await using fixture: ConnectorRevocationFixture = await ConnectorRevocationFixture.create(
            'wss://localhost:' + address.port.toString() + ConnectorTransportLimits.path,
            tls.certificate,
        );
        using other: ConnectorSessionFixture = new ConnectorSessionFixture();
        const original: Buffer = await readFile(join(fixture.state, 'device-key.json'));
        const states: ConnectorClientState[] = [];
        const stop: AbortController = new AbortController();
        const retry: PromiseWithResolvers<ConnectorStartupProgress> =
            Promise.withResolvers<ConnectorStartupProgress>();
        await using client: ConnectorClient = await ConnectorClient.load(
            fixture.identity.configurationFile,
            (state: ConnectorClientState): void => {
                states.push(state);
            },
            (progress: ConnectorStartupProgress): void => {
                if (progress.stage === ConnectorStartupStage.Retry) {
                    retry.resolve(progress);
                    stop.abort();
                }
            },
        );
        const running: Promise<void> = client.run(stop.signal);
        try {
            const socket: Duplex = await tls.upgraded.promise;
            if (invalidProof) {
                send(socket, {
                    kind: ConnectorFrameKind.Unpaired,
                    receipt: { ...fixture.receipt(), publicKey: other.device.publicKey },
                });
            } else {
                socket.destroy();
            }
            expect((await retry.promise).disconnect).toBe(
                invalidProof ? ConnectorDisconnect.Authentication : ConnectorDisconnect.Network,
            );
            await running;
            expect(states).not.toContain(ConnectorClientState.Revoked);
            await expect(access(join(fixture.state, 'revoked-state'))).rejects.toThrow();
            await ConnectorLogout.requireActive(fixture.state);
            expect(await readFile(join(fixture.state, 'device-key.json'))).toEqual(original);
            expect(
                await ConnectorLogout.resolve(
                    fixture.pairingFile,
                    stop.signal.aborted ? new AbortController().signal : stop.signal,
                ),
            ).toBe(fixture.pairingFile);
        } finally {
            stop.abort();
            await client[Symbol.asyncDispose]();
            await running;
        }
    },
    10000,
);

it('a revoked console clears capabilities and waits for an explicit new pairing', (): void => {
    const model: ConnectorConsoleModel = new ConnectorConsoleModel();
    model.files = model.execution = model.host = true;
    model.connection(ConnectorClientState.Authenticated);
    model.connection(ConnectorClientState.Revoked);
    expect(model.phase).toBe(ConnectorConsolePhase.NotLinked);
    expect([model.files, model.execution, model.host]).toEqual([false, false, false]);
    expect(model.retryAt).toBeNull();
    expect(model.message).toContain('/pair');
});
