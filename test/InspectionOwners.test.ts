// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

import { fstatSync, type BigIntStats } from 'node:fs';
import { mkdir, rename, stat } from 'node:fs/promises';
import { expect, it } from 'vitest';
import { ConnectorFilesystem } from '../src/runtime/ConnectorFilesystem.js';
import { ExecutionPolicy } from '../src/execution/ExecutionPolicy.js';
import { ExecutionWorkspaceAccess } from '../src/execution/ExecutionTypes.js';
import { ConnectorFileMode } from 'nerva-connector-protocol/protocol/ConnectorFiles.js';
import type { WorkspaceInspection } from '../src/workspace/WorkspaceInspection.js';
import { InspectionFixture } from './support/InspectionFixture.js';

/** Both real policy owners must enforce the same borrowed-capability lifetime contract. */
interface InspectionOwner extends AsyncDisposable {
    [Symbol.asyncDispose](): Promise<void>;
    inspectWorkspace<T>(
        rootId: string,
        inspect: (root: WorkspaceInspection) => Promise<T>,
        signal: AbortSignal,
    ): Promise<T>;
}

/** Test choices are explicit; no case silently falls back to the other policy owner. */
enum OwnerKind {
    Files = 'files',
    Execution = 'execution',
}

const helpers: boolean =
    process.env['NERVA_CONNECTOR_FILES_HELPER'] !== undefined &&
    process.env['NERVA_CONNECTOR_EXEC_HELPER'] !== undefined;

/** Loading validates actual local policies and executable bytes without starting a program. */
async function load(fixture: InspectionFixture, kind: OwnerKind): Promise<InspectionOwner> {
    return kind === OwnerKind.Files
        ? await ConnectorFilesystem.load(fixture.filePolicy, [])
        : await ExecutionPolicy.load(fixture.executionPolicy, []);
}

/** A policy's root alias is independent of the other owner's name. */
function rootId(fixture: InspectionFixture, kind: OwnerKind): string {
    return kind === OwnerKind.Files ? fixture.fileRootId : fixture.executionRootId;
}

it.skipIf(!helpers).each(Object.values(OwnerKind))(
    '%s inspection pins the actual granted root across pathname replacement and reports its real access',
    async (kind: OwnerKind): Promise<void> => {
        await using fixture: InspectionFixture = await InspectionFixture.create(
            ConnectorFileMode.ReadWrite,
            ExecutionWorkspaceAccess.ReadWrite,
        );
        await using owner: InspectionOwner = await load(fixture, kind);
        const original: BigIntStats = await stat(fixture.root, { bigint: true });
        await rename(fixture.root, fixture.root + '-renamed');
        await mkdir(fixture.root, { mode: 0o700 });
        const replacement: BigIntStats = await stat(fixture.root, { bigint: true });
        expect(replacement.ino).not.toBe(original.ino);
        await owner.inspectWorkspace(
            rootId(fixture, kind),
            (root: WorkspaceInspection): Promise<void> => {
                const pinned: BigIntStats = fstatSync(root.descriptor, { bigint: true });
                expect(pinned.dev).toBe(original.dev);
                expect(pinned.ino).toBe(original.ino);
                expect(root.access).toBe(ConnectorFileMode.ReadWrite);
                expect(fstatSync(root.helperDescriptor).isFile()).toBe(true);
                expect(root.signal.aborted).toBe(false);
                return Promise.resolve();
            },
            new AbortController().signal,
        );
        let probes: number = 0;
        const inspect: (root: WorkspaceInspection) => Promise<void> = (
            _root: WorkspaceInspection,
        ): Promise<void> => {
            probes++;
            return Promise.resolve();
        };
        await expect(
            owner.inspectWorkspace('ungranted', inspect, new AbortController().signal),
        ).rejects.toThrow();
        await expect(
            owner.inspectWorkspace(rootId(fixture, kind), inspect, AbortSignal.abort()),
        ).rejects.toThrow();
        expect(probes).toBe(0);
    },
);

it.skipIf(!helpers).each(Object.values(OwnerKind))(
    '%s shutdown cancels bounded inspections and joins callbacks before closing their descriptors',
    async (kind: OwnerKind): Promise<void> => {
        await using fixture: InspectionFixture = await InspectionFixture.create();
        const owner: InspectionOwner = await load(fixture, kind);
        const finished: PromiseWithResolvers<undefined> = Promise.withResolvers<undefined>();
        const captured: WorkspaceInspection[] = [];
        const pending: Promise<void>[] = [];
        let closed: boolean = false;
        try {
            for (let index: number = 0; index < 4; index++) {
                pending.push(
                    owner.inspectWorkspace(
                        rootId(fixture, kind),
                        async (root: WorkspaceInspection): Promise<void> => {
                            captured.push(root);
                            await finished.promise;
                        },
                        new AbortController().signal,
                    ),
                );
            }
            expect(captured).toHaveLength(4);
            await expect(
                owner.inspectWorkspace(
                    rootId(fixture, kind),
                    (): Promise<void> => {
                        throw new Error('A fifth callback must not enter');
                    },
                    new AbortController().signal,
                ),
            ).rejects.toThrow('unavailable');
            const closing: Promise<void> = owner[Symbol.asyncDispose]();
            expect(
                captured.every((root: WorkspaceInspection): boolean => root.signal.aborted),
            ).toBe(true);
            for (const root of captured) {
                expect(fstatSync(root.descriptor).isDirectory()).toBe(true);
                expect(fstatSync(root.helperDescriptor).isFile()).toBe(true);
            }
            finished.resolve(undefined);
            const results: readonly PromiseSettledResult<void>[] =
                await Promise.allSettled(pending);
            expect(
                results.every(
                    (result: PromiseSettledResult<void>): boolean => result.status === 'rejected',
                ),
            ).toBe(true);
            await closing;
            closed = true;
            for (const root of captured) {
                expect((): void => {
                    fstatSync(root.descriptor);
                }).toThrow();
                expect((): void => {
                    fstatSync(root.helperDescriptor);
                }).toThrow();
            }
            await expect(
                owner.inspectWorkspace(
                    rootId(fixture, kind),
                    (): Promise<void> => {
                        throw new Error('A closed owner must not enter');
                    },
                    new AbortController().signal,
                ),
            ).rejects.toThrow('unavailable');
        } finally {
            finished.resolve(undefined);
            await Promise.allSettled(pending);
            if (!closed) {
                await owner[Symbol.asyncDispose]();
            }
        }
    },
);
