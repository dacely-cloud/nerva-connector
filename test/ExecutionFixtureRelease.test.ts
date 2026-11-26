// SPDX-FileCopyrightText: 2026 Dacely <business@dacely.com>
// SPDX-License-Identifier: LicenseRef-Proprietary

import { access, rm } from 'node:fs/promises';
import { expect, it, vi, type MockInstance } from 'vitest';
import { ExecutionWorkspaceAccess } from 'nerva-connector-protocol/execution/ExecutionTypes.js';
import { ExecutionFixture } from './support/ExecutionFixture.js';
import { ExecutionAppArmorInstaller } from '../src/execution/ExecutionAppArmorInstaller.js';
import { ExecutionPolicyCodec } from '../src/execution/ExecutionPolicyCodec.js';
import { ProtectedFiles } from '../src/local/ProtectedFiles.js';
import type { ExecutionPolicyDefinition } from 'nerva-connector-protocol/execution/ExecutionPolicyTypes.js';

const helper: string | undefined = process.env['NERVA_CONNECTOR_EXEC_HELPER'];

it.skipIf(helper === undefined)(
    'unproven fixture shutdown preserves capabilities, profiles and files, and retention cannot be escalated by a later disposer',
    async (): Promise<void> => {
        if (helper === undefined) {
            throw new Error('Explicit current native execution helper required');
        }
        await using fixture: ExecutionFixture = await ExecutionFixture.create(helper);
        const path: string = await fixture.policy(helper, ExecutionWorkspaceAccess.ReadWrite);
        const raw: unknown = JSON.parse(
            (await ProtectedFiles.readPrivate(path, 65536)).toString('utf8'),
        );
        const definition: ExecutionPolicyDefinition = ExecutionPolicyCodec.policy(raw);
        const shutdown: MockInstance<() => Promise<void>> = vi
            .spyOn(fixture.sandbox, Symbol.asyncDispose)
            .mockRejectedValueOnce(new Error('Injected unproven child join'));
        try {
            const outcomes: readonly PromiseSettledResult<void>[] = await Promise.allSettled([
                fixture.release(true),
                fixture.release(false),
            ]);
            expect(
                outcomes.map((outcome: PromiseSettledResult<void>): string => outcome.status),
            ).toEqual(['rejected', 'rejected']);
            expect(shutdown).toHaveBeenCalledTimes(1);
            await expect(access(fixture.directory)).resolves.toBeUndefined();
            await expect(access(fixture.delegation)).resolves.toBeUndefined();
            await expect(
                ExecutionAppArmorInstaller.assertInstalled(definition),
            ).resolves.toBeUndefined();
            expect((await fixture.sandbox.capabilities.workspace.stat()).isDirectory()).toBe(true);
            expect((await fixture.sandbox.capabilities.cgroupParent.stat()).isDirectory()).toBe(
                true,
            );
            await expect(fixture.admission()).rejects.toThrow('closed');
            await fixture[Symbol.asyncDispose]();
            expect(shutdown).toHaveBeenCalledTimes(2);
            await expect(access(fixture.delegation)).rejects.toMatchObject({ code: 'ENOENT' });
            await expect(access(fixture.directory)).resolves.toBeUndefined();
            expect(fixture.sandbox.capabilities.workspace.fd).toBe(-1);
        } finally {
            shutdown.mockRestore();
            await fixture.release(true);
            await rm(fixture.directory, { recursive: true });
        }
    },
);

it.skipIf(helper === undefined)(
    'a rejected descriptor close joins every other close and retries without repeating successful kernel removal or deleting files early',
    async (): Promise<void> => {
        if (helper === undefined) {
            throw new Error('Explicit current native execution helper required');
        }
        await using fixture: ExecutionFixture = await ExecutionFixture.create(helper);
        await fixture.policy(helper, ExecutionWorkspaceAccess.ReadWrite);
        const removal: MockInstance<(definition: ExecutionPolicyDefinition) => Promise<void>> =
            vi.spyOn(ExecutionAppArmorInstaller, 'remove');
        const close: MockInstance<() => Promise<void>> = vi
            .spyOn(fixture.sandbox.capabilities.workspace, 'close')
            .mockRejectedValueOnce(new Error('Injected descriptor-close failure'));
        try {
            await expect(fixture.release(false)).rejects.toThrow('descriptor release');
            await expect(access(fixture.directory)).resolves.toBeUndefined();
            await expect(access(fixture.delegation)).rejects.toMatchObject({ code: 'ENOENT' });
            expect((await fixture.sandbox.capabilities.workspace.stat()).isDirectory()).toBe(true);
            expect(fixture.sandbox.capabilities.trampoline.fd).toBe(-1);
            expect(fixture.sandbox.capabilities.cgroupParent.fd).toBe(-1);
            expect(removal).toHaveBeenCalledTimes(1);
            await fixture.release(true);
            expect(close).toHaveBeenCalledTimes(2);
            expect(removal).toHaveBeenCalledTimes(1);
            expect(fixture.sandbox.capabilities.workspace.fd).toBe(-1);
            await expect(access(fixture.directory)).rejects.toMatchObject({ code: 'ENOENT' });
            await fixture.release(false);
            expect(close).toHaveBeenCalledTimes(2);
        } finally {
            close.mockRestore();
            removal.mockRestore();
            await fixture.release(false);
        }
    },
);
