// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

import type { AddressInfo } from 'node:net';
import type { Duplex } from 'node:stream';
import { afterEach, expect, it, vi } from 'vitest';
import { ConnectorClientConnection } from '../src/runtime/ConnectorClientConnection.js';
import type { ConnectorClientIdentity } from '../src/runtime/ConnectorClientConfiguration.js';
import { ConnectorClientState } from '../src/runtime/ConnectorClientState.js';
import {
    ConnectorStartupStage,
    type ConnectorStartupProgress,
} from '../src/runtime/ConnectorStartup.js';
import { ConnectorConsoleModel, ConnectorConsolePhase } from '../src/cli/ConnectorConsoleModel.js';
import { ConnectorStartupDisplay } from '../src/cli/ConnectorStartupDisplay.js';
import { ConnectorTransportLimits } from '../src/protocol/ConnectorTransport.js';
import { SystemInfo } from '../src/system/SystemInfo.js';
import type { SystemSpecification } from 'nerva-connector-protocol/system/SystemSpecification.js';
import { SocketFixture } from './support/SocketFixture.js';
import { ConnectorSessionFixture } from './support/ConnectorSessionFixture.js';
import { ConnectorLifecyclePeer } from './support/ConnectorLifecyclePeer.js';

afterEach((): void => {
    vi.restoreAllMocks();
});

/** Channel loss, explicit quit and a failing display observer retain the same owned-work join. */
enum DrainCase {
    Interrupted = 'interrupted',
    Quit = 'quit',
    ObserverFailure = 'observer-failure',
}

it.each(Object.values(DrainCase))(
    'a real authenticated channel joins delayed inventory without false readiness or quit reconnect: %s',
    async (mode: DrainCase): Promise<void> => {
        const quit: boolean = mode === DrainCase.Quit;
        const observerFailure: Error = new Error('Controlled progress observer failure');
        await using tls: SocketFixture = await SocketFixture.create(
            ConnectorTransportLimits.protocol,
        );
        using authority: ConnectorSessionFixture = new ConnectorSessionFixture();
        const model: ConnectorConsoleModel = new ConnectorConsoleModel();
        const stages: ConnectorStartupStage[] = [];
        const state: ConnectorClientState[] = [];
        const started: PromiseWithResolvers<AbortSignal> = Promise.withResolvers<AbortSignal>();
        const drain: PromiseWithResolvers<undefined> = Promise.withResolvers<undefined>();
        const closing: PromiseWithResolvers<undefined> = Promise.withResolvers<undefined>();
        let finished: boolean = false;
        vi.spyOn(SystemInfo, 'read').mockImplementation(
            async (signal: AbortSignal): Promise<SystemSpecification> => {
                expect(model.phase).toBe(ConnectorConsolePhase.Connected);
                started.resolve(signal);
                await drain.promise;
                signal.throwIfAborted();
                throw new Error('Expected the closed inventory operation to be canceled');
            },
        );
        using display: ConnectorStartupDisplay = new ConnectorStartupDisplay(
            (text: string): void => {
                model.activity = text;
            },
            true,
        );
        const identity: ConnectorClientIdentity = { ...authority.identity, ca: tls.certificate };
        const connection: ConnectorClientConnection = new ConnectorClientConnection(
            identity,
            null,
            null,
            (value: ConnectorClientState): void => {
                state.push(value);
                model.connection(value);
            },
            (progress: ConnectorStartupProgress): void => {
                stages.push(progress.stage);
                if (progress.stage === ConnectorStartupStage.Closing) {
                    model.closing();
                    closing.resolve(undefined);
                }
                display.update(progress);
                if (
                    progress.stage === ConnectorStartupStage.Closing &&
                    mode === DrainCase.ObserverFailure
                ) {
                    throw observerFailure;
                }
            },
        );
        const address: AddressInfo | string | null = tls.server.address();
        if (address === null || typeof address === 'string') {
            throw new Error('Actual TLS listener required');
        }
        const stop: AbortController = new AbortController();
        const running: Promise<Error | null> = (async (): Promise<Error | null> => {
            try {
                await connection.run('wss://localhost:' + address.port.toString(), stop.signal);
                return null;
            } catch (caught: unknown) {
                if (caught instanceof Error) {
                    return caught;
                }
                throw caught;
            } finally {
                finished = true;
            }
        })();
        try {
            const socket: Duplex = await tls.upgraded.promise;
            const peer: ConnectorLifecyclePeer = new ConnectorLifecyclePeer(socket, authority);
            const probeSignal: AbortSignal = await started.promise;
            expect(state).toEqual([ConnectorClientState.Authenticated]);
            expect(stages.at(-1)).toBe(ConnectorStartupStage.Ready);
            const closed: PromiseWithResolvers<undefined> = Promise.withResolvers<undefined>();
            socket.once('close', (): void => closed.resolve(undefined));
            if (quit) {
                model.connection(ConnectorClientState.Stopped);
                stop.abort();
            } else {
                socket.destroy();
                await closing.promise;
            }
            await closed.promise;
            expect(finished).toBe(false);
            expect(probeSignal.aborted).toBe(true);
            if (quit) {
                expect(stages).not.toContain(ConnectorStartupStage.Closing);
                expect(model.phase).toBe(ConnectorConsolePhase.Stopped);
            } else {
                expect(model.phase).toBe(ConnectorConsolePhase.Reconnecting);
                expect(model.activity).toContain('Closing previous connection');
            }
            drain.resolve(undefined);
            expect(await running).toBe(mode === DrainCase.ObserverFailure ? observerFailure : null);
            expect(finished).toBe(true);
            expect(
                stages.filter(
                    (entry: ConnectorStartupStage): boolean =>
                        entry === ConnectorStartupStage.Ready,
                ),
            ).toHaveLength(1);
            peer.assertHealthy();
        } finally {
            stop.abort();
            drain.resolve(undefined);
            await running;
        }
    },
    10000,
);
