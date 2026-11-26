// SPDX-FileCopyrightText: 2026 Dacely <business@dacely.com>
// SPDX-License-Identifier: LicenseRef-Proprietary

import { readFile, writeFile, access, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, it, vi, type MockInstance } from 'vitest';
import { ExecutionAppArmorInstaller } from '../src/execution/ExecutionAppArmorInstaller.js';
import { ExecutionPolicy } from '../src/execution/ExecutionPolicy.js';
import { JointWorkspaceCapture } from '../src/workspace/JointWorkspaceCapture.js';
import { JointWorkspaceJournal } from '../src/workspace/JointWorkspaceJournal.js';
import {
    JointWorkspaceInstallation,
    type JointWorkspaceInstallationReport,
    type JointWorkspaceInstallationRoot,
} from '../src/workspace/JointWorkspaceInstallation.js';
import { JointWorkspaceCodec } from 'nerva-connector-protocol/workspace/JointWorkspaceCodec.js';
import { JointWorkspaceConfiguration } from '../src/workspace/JointWorkspaceConfiguration.js';
import { ConnectorPrivateDirectory } from '../src/runtime/ConnectorPrivateDirectory.js';
import type { JointWorkspaceDescriptor } from 'nerva-connector-protocol/workspace/JointWorkspaceBinding.js';
import { JointWorkspaceInstallationFixture } from './support/JointWorkspaceInstallationFixture.js';
import type { JointWorkspaceCaptureRequest } from '../src/workspace/JointWorkspaceCapture.js';

const helpers: boolean =
    process.platform === 'linux' &&
    process.env['NERVA_CONNECTOR_FILES_HELPER'] !== undefined &&
    process.env['NERVA_CONNECTOR_EXEC_HELPER'] !== undefined;

it.skipIf(!helpers)(
    'real native captures prepare all explicit pairs using one shared command policy and preserve all original identity/operation bytes',
    async (): Promise<void> => {
        await using fixture: JointWorkspaceInstallationFixture =
            await JointWorkspaceInstallationFixture.create(true);
        using mac: MockInstance<typeof ExecutionAppArmorInstaller.assertInstalled> = vi
            .spyOn(ExecutionAppArmorInstaller, 'assertInstalled')
            .mockResolvedValue();
        using policies: MockInstance<typeof ExecutionPolicy.load> = vi.spyOn(
            ExecutionPolicy,
            'load',
        );
        using capture: MockInstance<typeof JointWorkspaceCapture.prototype.capture> = vi.spyOn(
            JointWorkspaceCapture.prototype,
            'capture',
        );
        const original: readonly Buffer[] = await fixture.originalBytes();
        const report: JointWorkspaceInstallationReport =
            await JointWorkspaceInstallation.initialize(
                fixture.identity.configurationFile,
                fixture.requestFile,
                fixture.signal,
            );
        expect(report.installed).toBe(true);
        expect(report.activated).toBe(false);
        expect(
            report.roots.map((root: JointWorkspaceInstallationRoot): bigint => root.revision),
        ).toEqual([1n, 2n]);
        expect(policies).toHaveBeenCalledOnce();
        expect(capture).toHaveBeenCalledTimes(2);
        expect(mac).toHaveBeenCalledOnce();
        expect(await fixture.originalBytes()).toEqual(original);
        expect(
            await JointWorkspaceConfiguration.read(fixture.identity.settings.privateKeyFile),
        ).toEqual(fixture.mapping);
        await expect(access(fixture.paths.setupFile)).rejects.toThrow();
        const encoded: string = JSON.stringify(report, (_key: string, entry: unknown): unknown =>
            typeof entry === 'bigint' ? entry.toString() : entry,
        );
        expect(encoded).not.toContain(fixture.source.native.directory);
        expect(encoded).not.toContain('publicKey');
        // AppArmor is explicitly stubbed for read-only setup qualification; no program or backend operation runs.
    },
);

it.skipIf(!helpers)(
    'mapping is unpublished during preparation and exact retries reuse an already-retained first pair instead of recapturing it',
    async (): Promise<void> => {
        await using fixture: JointWorkspaceInstallationFixture =
            await JointWorkspaceInstallationFixture.create(true);
        using mac: MockInstance<typeof ExecutionAppArmorInstaller.assertInstalled> = vi
            .spyOn(ExecutionAppArmorInstaller, 'assertInstalled')
            .mockResolvedValue();
        const actual: unknown = Reflect.get(JointWorkspaceCapture.prototype, 'capture');
        if (typeof actual !== 'function') {
            throw new Error('Actual capture method required');
        }
        const first: JointWorkspaceDescriptor[] = [];
        using capture: MockInstance<typeof JointWorkspaceCapture.prototype.capture> = vi
            .spyOn(JointWorkspaceCapture.prototype, 'capture')
            .mockImplementation(async function (
                this: JointWorkspaceCapture,
                request: JointWorkspaceCaptureRequest,
                signal: AbortSignal,
            ): Promise<JointWorkspaceDescriptor> {
                expect(
                    await JointWorkspaceConfiguration.read(
                        fixture.identity.settings.privateKeyFile,
                    ),
                ).toBeNull();
                if (request.fileRootId === 'files-second') {
                    throw new Error('Owned fixture interrupted second capture');
                }
                const result: unknown = await Reflect.apply(actual, this, [request, signal]);
                const raw: unknown = JSON.parse(
                    JSON.stringify(result, (_key: string, entry: unknown): unknown =>
                        typeof entry === 'bigint' ? entry.toString() : entry,
                    ),
                );
                const descriptor: JointWorkspaceDescriptor = JointWorkspaceCodec.descriptor(raw);
                first.push(descriptor);
                return descriptor;
            });
        await expect(
            JointWorkspaceInstallation.initialize(
                fixture.identity.configurationFile,
                fixture.requestFile,
                fixture.signal,
            ),
        ).rejects.toThrow('keep the original');
        capture.mockRestore();
        expect(mac).toHaveBeenCalled();
        expect(first).toHaveLength(1);
        {
            await using proof: JointWorkspaceJournal = await fixture.workspaces();
            expect(await proof.descriptor(1n, fixture.signal)).toEqual(first[0]);
            expect(proof.pending).toBeNull();
        }
        const archive: Buffer = await readFile(
            join(fixture.paths.stateDirectory, 'workspace-binding-1'),
        );
        expect(
            await JointWorkspaceConfiguration.read(fixture.identity.settings.privateKeyFile),
        ).toBeNull();
        await access(fixture.paths.setupFile);
        using retry: MockInstance<typeof JointWorkspaceCapture.prototype.capture> = vi.spyOn(
            JointWorkspaceCapture.prototype,
            'capture',
        );
        const report: JointWorkspaceInstallationReport =
            await JointWorkspaceInstallation.initialize(
                fixture.identity.configurationFile,
                fixture.requestFile,
                fixture.signal,
            );
        expect(retry).toHaveBeenCalledOnce();
        expect(retry.mock.calls[0]?.[0].fileRootId).toBe('files-second');
        expect(
            report.roots.map((root: JointWorkspaceInstallationRoot): bigint => root.revision),
        ).toEqual([1n, 3n]);
        expect(await readFile(join(fixture.paths.stateDirectory, 'workspace-binding-1'))).toEqual(
            archive,
        );
    },
);

it.skipIf(!helpers)(
    'rejects changed requested mapping or missing historical head after intent rather than creating new counters',
    async (): Promise<void> => {
        await using fixture: JointWorkspaceInstallationFixture =
            await JointWorkspaceInstallationFixture.create();
        using mac: MockInstance<typeof ExecutionAppArmorInstaller.assertInstalled> = vi
            .spyOn(ExecutionAppArmorInstaller, 'assertInstalled')
            .mockResolvedValue();
        using fail: MockInstance<typeof JointWorkspaceCapture.prototype.capture> = vi
            .spyOn(JointWorkspaceCapture.prototype, 'capture')
            .mockRejectedValue(new Error('Owned fixture capture interruption'));
        await expect(
            JointWorkspaceInstallation.initialize(
                fixture.identity.configurationFile,
                fixture.requestFile,
                fixture.signal,
            ),
        ).rejects.toThrow();
        fail.mockRestore();
        const intent: Buffer = await readFile(fixture.paths.setupFile);
        const head: Buffer = await readFile(join(fixture.paths.stateDirectory, 'workspace-head'));
        await writeFile(
            fixture.requestFile,
            JointWorkspaceConfiguration.encode({
                roots: [{ fileRootId: 'other', executionRootId: 'other' }],
            }),
            { mode: 0o600 },
        );
        await expect(
            JointWorkspaceInstallation.initialize(
                fixture.identity.configurationFile,
                fixture.requestFile,
                fixture.signal,
            ),
        ).rejects.toThrow();
        expect(await readFile(fixture.paths.setupFile)).toEqual(intent);
        expect(await readFile(join(fixture.paths.stateDirectory, 'workspace-head'))).toEqual(head);
        await writeFile(fixture.requestFile, JointWorkspaceConfiguration.encode(fixture.mapping), {
            mode: 0o600,
        });
        await unlink(join(fixture.paths.stateDirectory, 'workspace-head'));
        await expect(
            JointWorkspaceInstallation.initialize(
                fixture.identity.configurationFile,
                fixture.requestFile,
                fixture.signal,
            ),
        ).rejects.toThrow();
        await expect(
            access(join(fixture.paths.stateDirectory, 'workspace-head')),
        ).rejects.toThrow();
        expect(await readFile(fixture.paths.setupFile)).toEqual(intent);
        expect(mac).toHaveBeenCalled();
    },
);

it.skipIf(!helpers)(
    'preserves completed mapping and all history when setup-intent cleanup fails, then exact retry cleans up without recapture',
    async (): Promise<void> => {
        await using fixture: JointWorkspaceInstallationFixture =
            await JointWorkspaceInstallationFixture.create();
        using mac: MockInstance<typeof ExecutionAppArmorInstaller.assertInstalled> = vi
            .spyOn(ExecutionAppArmorInstaller, 'assertInstalled')
            .mockResolvedValue();
        using remove: MockInstance<typeof ConnectorPrivateDirectory.prototype.remove> = vi
            .spyOn(ConnectorPrivateDirectory.prototype, 'remove')
            .mockRejectedValue(new Error('Owned fixture cleanup failure'));
        await expect(
            JointWorkspaceInstallation.initialize(
                fixture.identity.configurationFile,
                fixture.requestFile,
                fixture.signal,
            ),
        ).rejects.toThrow();
        remove.mockRestore();
        const mapping: Buffer = await readFile(fixture.paths.configurationFile);
        const head: Buffer = await readFile(join(fixture.paths.stateDirectory, 'workspace-head'));
        const archive: Buffer = await readFile(
            join(fixture.paths.stateDirectory, 'workspace-binding-1'),
        );
        using capture: MockInstance<typeof JointWorkspaceCapture.prototype.capture> = vi.spyOn(
            JointWorkspaceCapture.prototype,
            'capture',
        );
        await JointWorkspaceInstallation.initialize(
            fixture.identity.configurationFile,
            fixture.requestFile,
            fixture.signal,
        );
        expect(capture).not.toHaveBeenCalled();
        expect(mac).toHaveBeenCalled();
        expect(await readFile(fixture.paths.configurationFile)).toEqual(mapping);
        expect(await readFile(join(fixture.paths.stateDirectory, 'workspace-head'))).toEqual(head);
        expect(await readFile(join(fixture.paths.stateDirectory, 'workspace-binding-1'))).toEqual(
            archive,
        );
        await expect(access(fixture.paths.setupFile)).rejects.toThrow();
    },
);
