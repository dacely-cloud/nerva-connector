// SPDX-FileCopyrightText: 2026 Dacely <business@dacely.com>
// SPDX-License-Identifier: LicenseRef-Proprietary

import { expect, it, vi, type MockInstance } from 'vitest';
import type { HostDesktopInfo } from '../src/host/HostDesktopTypes.js';
import { HostDesktopWayland } from '../src/host/HostDesktopWayland.js';
import { HostWorkspace } from '../src/host/HostWorkspace.js';
import { HostWorkspaceFixture } from './support/HostWorkspaceFixture.js';

it.skipIf(process.platform !== 'linux')(
    'workspace shutdown cancels pending Wayland consent before joining admitted desktop work',
    async (): Promise<void> => {
        await using fixture: HostWorkspaceFixture = await HostWorkspaceFixture.create();
        await using host: HostWorkspace = await HostWorkspace.create({
            directory: fixture.directory,
            authorization: fixture,
            desktopEnvironment: {
                WAYLAND_DISPLAY: 'isolated-fixture',
                DISPLAY: '',
                DBUS_SESSION_BUS_ADDRESS: '',
            },
        });
        const gate: PromiseWithResolvers<HostDesktopInfo> =
            Promise.withResolvers<HostDesktopInfo>();
        const entered: PromiseWithResolvers<undefined> = Promise.withResolvers<undefined>();
        const canceled: PromiseWithResolvers<undefined> = Promise.withResolvers<undefined>();
        const original: () => Promise<void> = HostDesktopWayland.prototype[Symbol.asyncDispose];
        const info: MockInstance<HostDesktopWayland['info']> = vi
            .spyOn(HostDesktopWayland.prototype, 'info')
            .mockImplementation((): Promise<HostDesktopInfo> => {
                entered.resolve(undefined);
                return gate.promise;
            });
        const close: MockInstance<HostDesktopWayland[typeof Symbol.asyncDispose]> = vi
            .spyOn(HostDesktopWayland.prototype, Symbol.asyncDispose)
            .mockImplementation(async function (this: HostDesktopWayland): Promise<void> {
                canceled.resolve(undefined);
                gate.reject(new Error('Native consent canceled by close'));
                await original.call(this);
            });
        const operation: Promise<readonly PromiseSettledResult<void>[]> = Promise.allSettled([
            host.desktopText('must not reach a real desktop'),
        ]);
        let timer: ReturnType<typeof setTimeout> | undefined;
        let closing: Promise<void> | undefined;
        try {
            await entered.promise;
            closing = host[Symbol.asyncDispose]();
            await Promise.race([
                canceled.promise,
                new Promise<never>(
                    (_resolve: (value: never) => void, reject: (error: Error) => void): void => {
                        timer = setTimeout(
                            (): void =>
                                reject(
                                    new Error(
                                        'Workspace did not cancel pending consent before joining it',
                                    ),
                                ),
                            1000,
                        );
                    },
                ),
            ]);
            await closing;
            expect(await operation).toMatchObject([{ status: 'rejected' }]);
            expect(close).toHaveBeenCalledTimes(1);
        } finally {
            clearTimeout(timer);
            gate.reject(new Error('Fixture cleanup'));
            await operation;
            await closing;
            info.mockRestore();
            close.mockRestore();
        }
    },
);
