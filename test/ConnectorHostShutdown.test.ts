// SPDX-FileCopyrightText: 2026 Dacely <business@dacely.com>
// SPDX-License-Identifier: LicenseRef-Proprietary

import { expect, it, vi, type MockInstance } from 'vitest';
import { HostWorkspace } from '../src/host/HostWorkspace.js';
import { ConnectorClientHost } from '../src/runtime/ConnectorClientHost.js';
import { ConnectorHostJournal } from '../src/runtime/ConnectorHostJournal.js';
import { ConnectorHostFixture } from './support/ConnectorHostFixture.js';

it.skipIf(process.platform !== 'linux')(
    'failed native cleanup retains the real journal owner and a concurrent retry joins one exact shutdown',
    async (): Promise<void> => {
        await using fixture: ConnectorHostFixture = await ConnectorHostFixture.create();
        await fixture.grant();
        const host: ConnectorClientHost = await fixture.open();
        const dispose: HostWorkspace[typeof Symbol.asyncDispose] =
            HostWorkspace.prototype[Symbol.asyncDispose];
        const entered: PromiseWithResolvers<undefined> = Promise.withResolvers<undefined>();
        const allowed: PromiseWithResolvers<undefined> = Promise.withResolvers<undefined>();
        const workspace: MockInstance<HostWorkspace[typeof Symbol.asyncDispose]> = vi
            .spyOn(HostWorkspace.prototype, Symbol.asyncDispose)
            .mockRejectedValueOnce(new Error('Native ownership remains unconfirmed'))
            .mockImplementation(async function (this: HostWorkspace): Promise<void> {
                entered.resolve(undefined);
                await allowed.promise;
                await dispose.call(this);
            });
        const journal: MockInstance<ConnectorHostJournal[typeof Symbol.asyncDispose]> = vi.spyOn(
            host.journal,
            Symbol.asyncDispose,
        );
        try {
            await expect(host[Symbol.asyncDispose]()).rejects.toThrow('shutdown failed');
            expect(workspace).toHaveBeenCalledTimes(1);
            expect(journal).not.toHaveBeenCalled();
            await expect(ConnectorClientHost.load(fixture.identity)).rejects.toThrow();
            const first: Promise<void> = host[Symbol.asyncDispose]();
            const concurrent: Promise<void> = host[Symbol.asyncDispose]();
            await entered.promise;
            expect(workspace).toHaveBeenCalledTimes(2);
            expect(journal).not.toHaveBeenCalled();
            allowed.resolve(undefined);
            await Promise.all([first, concurrent]);
            expect(journal).toHaveBeenCalledTimes(1);
            await host[Symbol.asyncDispose]();
            expect(workspace).toHaveBeenCalledTimes(2);
            expect(journal).toHaveBeenCalledTimes(1);
            await fixture.open();
        } finally {
            allowed.resolve(undefined);
            workspace.mockRestore();
            journal.mockRestore();
            await host[Symbol.asyncDispose]();
        }
    },
);
