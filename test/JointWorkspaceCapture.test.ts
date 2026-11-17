// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

import { mkdir, rename } from 'node:fs/promises';
import { fstatSync } from 'node:fs';
import { expect, it, vi, type MockInstance } from 'vitest';
import { ConnectorFileMode } from 'nerva-connector-protocol/protocol/ConnectorFiles.js';
import { ExecutionWorkspaceAccess } from '../src/execution/ExecutionTypes.js';
import type { JointWorkspaceDescriptor } from 'nerva-connector-protocol/workspace/JointWorkspaceBinding.js';
import { JointWorkspaceProof } from '../src/workspace/JointWorkspaceProof.js';
import { JointWorkspaceCodec } from 'nerva-connector-protocol/workspace/JointWorkspaceCodec.js';
import { WorkspaceIdentityProcess } from '../src/workspace/WorkspaceIdentityProcess.js';
import type { WorkspaceInspection } from '../src/workspace/WorkspaceInspection.js';
import type { WorkspaceIdentityResult } from '../src/workspace/WorkspaceIdentity.js';
import { JointWorkspaceCaptureFixture } from './support/JointWorkspaceCaptureFixture.js';

const helpers: boolean =
    process.env['NERVA_CONNECTOR_FILES_HELPER'] !== undefined &&
    process.env['NERVA_CONNECTOR_EXEC_HELPER'] !== undefined;

it.skipIf(!helpers)(
    'actual opened roots produce a signed descriptor across independent aliases and stay pinned after pathname replacement',
    async (): Promise<void> => {
        await using fixture: JointWorkspaceCaptureFixture =
            await JointWorkspaceCaptureFixture.create();
        const first: JointWorkspaceDescriptor = await fixture.owner.capture(
            fixture.request,
            new AbortController().signal,
        );
        expect(JointWorkspaceProof.verify(fixture.scope, first)).toBe(true);
        expect(first.binding.fileRootId).not.toBe(first.binding.executionRootId);
        expect(first.binding.revision).toBe(9007199254740993n);
        await rename(fixture.source.root, fixture.source.root + '.captured');
        await mkdir(fixture.source.root, { mode: 0o700 });
        const next: JointWorkspaceDescriptor = await fixture.owner.capture(
            { ...fixture.request, revision: fixture.request.revision + 1n },
            new AbortController().signal,
        );
        expect(JointWorkspaceProof.verify(fixture.scope, next)).toBe(true);
        expect(next.binding.physicalRootCommitment).toBe(first.binding.physicalRootCommitment);
        expect(JointWorkspaceProof.bindingSha256(next.binding)).not.toBe(
            JointWorkspaceProof.bindingSha256(first.binding),
        );
        const publicText: string = JointWorkspaceCodec.encode(next);
        for (const privateField of [
            'filesystemUuid',
            'inode',
            'device',
            'handle',
            fixture.source.root,
        ]) {
            expect(publicText).not.toContain(privateField);
        }
    },
);

it.skipIf(!helpers).each([false, true])(
    'physical mismatch or access mismatch cannot sign a joint grant (different root=%s)',
    async (differentRoot: boolean): Promise<void> => {
        await using fixture: JointWorkspaceCaptureFixture =
            await JointWorkspaceCaptureFixture.create(
                ConnectorFileMode.ReadOnly,
                differentRoot
                    ? ExecutionWorkspaceAccess.ReadOnly
                    : ExecutionWorkspaceAccess.ReadWrite,
                !differentRoot,
            );
        await expect(
            fixture.owner.capture(fixture.request, new AbortController().signal),
        ).rejects.toThrow();
    },
);

it.skipIf(!helpers)(
    'disposal aborts and joins both borrowed inspections, blocks parallel admission and releases neither policy',
    async (): Promise<void> => {
        await using fixture: JointWorkspaceCaptureFixture =
            await JointWorkspaceCaptureFixture.create();
        const entered: PromiseWithResolvers<undefined> = Promise.withResolvers<undefined>();
        let active: number = 0;
        const inspect: MockInstance<typeof WorkspaceIdentityProcess.prototype.inspect> = vi.spyOn(
            WorkspaceIdentityProcess.prototype,
            'inspect',
        );
        inspect.mockImplementation(
            async (input: WorkspaceInspection): Promise<WorkspaceIdentityResult> => {
                active++;
                if (active === 2) {
                    entered.resolve(undefined);
                }
                const cancelled: PromiseWithResolvers<undefined> =
                    Promise.withResolvers<undefined>();
                const abort: () => void = (): void => cancelled.resolve(undefined);
                input.signal.addEventListener('abort', abort, { once: true });
                try {
                    if (input.signal.aborted) {
                        abort();
                    }
                    await cancelled.promise;
                    input.signal.throwIfAborted();
                    throw new Error('Fixture inspection cancelled');
                } finally {
                    input.signal.removeEventListener('abort', abort);
                    active--;
                }
            },
        );
        try {
            const pending: Promise<JointWorkspaceDescriptor> = fixture.owner.capture(
                fixture.request,
                new AbortController().signal,
            );
            const rejected: Promise<void> = expect(pending).rejects.toThrow();
            await entered.promise;
            await expect(
                fixture.owner.capture(fixture.request, new AbortController().signal),
            ).rejects.toThrow('active');
            await fixture.owner[Symbol.asyncDispose]();
            await rejected;
            expect(active).toBe(0);
            expect(fixture.commands.failed).toBe(false);
            await expect(
                fixture.owner.capture(fixture.request, new AbortController().signal),
            ).rejects.toThrow('closed');
            expect(fixture.files.profile.roots).toContain(fixture.source.fileRootId);
        } finally {
            inspect.mockRestore();
        }
        expect(
            await fixture.files.inspectWorkspace(
                fixture.source.fileRootId,
                (root: WorkspaceInspection): Promise<boolean> =>
                    Promise.resolve(fstatSync(root.descriptor).isDirectory()),
                new AbortController().signal,
            ),
        ).toBe(true);
        expect(
            await fixture.commands.inspectWorkspace(
                fixture.source.executionRootId,
                (root: WorkspaceInspection): Promise<boolean> =>
                    Promise.resolve(fstatSync(root.descriptor).isDirectory()),
                new AbortController().signal,
            ),
        ).toBe(true);
    },
);
