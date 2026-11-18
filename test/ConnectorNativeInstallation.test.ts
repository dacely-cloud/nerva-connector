// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

import { expect, it, vi, type MockInstance } from 'vitest';
import { mkdir, copyFile, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { ConnectorServiceFixture } from './support/ConnectorServiceFixture.js';
import { ConnectorNativeDependencies } from '../src/native/ConnectorNativeDependencies.js';
import { ConnectorNativeInstallation } from '../src/native/ConnectorNativeInstallation.js';
import { ConnectorNativePlans } from '../src/native/ConnectorNativePlan.js';
import {
    ConnectorNativePhase,
    type ConnectorNativePlan,
} from '../src/native/ConnectorNativeTypes.js';
import { ConnectorClient } from '../src/runtime/ConnectorClient.js';
import { ConnectorFileMode } from 'nerva-connector-protocol/protocol/ConnectorFiles.js';
import { ConnectorRuntimeFileMode } from '../src/native/ConnectorNativeTypes.js';
import { ExecutionWorkspaceAccess } from 'nerva-connector-protocol/execution/ExecutionTypes.js';

/** This controller is not the Ubuntu 26 pilot; only actual package mutation is replaced by a finite no-op in local copy/authority tests. */
class NativePackageObservation implements Disposable {
    readonly #ensure: MockInstance<typeof ConnectorNativeDependencies.ensure>;
    readonly #verify: MockInstance<typeof ConnectorNativeDependencies.verify>;
    public constructor() {
        this.#ensure = vi.spyOn(ConnectorNativeDependencies, 'ensure').mockResolvedValue(undefined);
        this.#verify = vi.spyOn(ConnectorNativeDependencies, 'verify').mockResolvedValue(undefined);
    }
    /** Readonly repeats must never invoke package preparation again. */
    public get preparationCalls(): number {
        return this.#ensure.mock.calls.length;
    }
    /** Existing runtime validation stays separate from package mutation. */
    public get verificationCalls(): number {
        return this.#verify.mock.calls.length;
    }
    /** Native fixture state never changes system packages, MAC policy or systemd. */
    public [Symbol.dispose](): void {
        this.#ensure.mockRestore();
        this.#verify.mockRestore();
    }
}

/** One actual small OS ELF supplies a reviewed input, while workspaces remain distinct from installation/source authority. */
async function request(fixture: ConnectorServiceFixture): Promise<string> {
    const directory: string = fixture.release.directory;
    await mkdir(join(directory, 'sources/usr/bin'), { recursive: true, mode: 0o700 });
    await mkdir(join(directory, 'project'), { mode: 0o700 });
    await copyFile('/usr/bin/true', join(directory, 'sources/usr/bin/true'));
    const bytes: Buffer = await readFile(join(directory, 'sources/usr/bin/true'));
    const sha256: string = createHash('sha256').update(bytes).digest('hex');
    const path: string = join(directory, 'native-request.json');
    await writeFile(
        path,
        JSON.stringify({
            installationDirectory: fixture.layout.installationDirectory,
            sourceDirectory: join(directory, 'sources'),
            runtimeFiles: [
                {
                    path: '/usr/bin/true',
                    sizeBytes: String(bytes.length),
                    sha256,
                    mode: ConnectorRuntimeFileMode.Executable,
                },
            ],
            files: {
                mode: ConnectorFileMode.ReadWrite,
                revision: '1',
                roots: [{ id: 'project', path: join(directory, 'project') }],
            },
            execution: {
                revision: '1',
                roots: [
                    {
                        id: 'project',
                        path: join(directory, 'project'),
                        access: ExecutionWorkspaceAccess.ReadOnly,
                    },
                ],
                programs: [
                    {
                        id: 'true',
                        path: '/usr/bin/true',
                        sha256,
                        rootIds: ['project'],
                        arguments: [],
                        children: [],
                    },
                ],
                resources: { memoryBytes: '67108864', maximumTasks: 8, cpuQuotaMicros: 50000 },
                timeoutMs: 5000,
                maximumAddressBytes: '1073741824',
                maximumFileBytes: '4096',
            },
        }),
        { mode: 0o600 },
    );
    return path;
}

it('native preparation freezes an approved runtime and stable generated policies without editing enrollment or exposing capabilities; exact readonly repeat tolerates an active runtime', async (): Promise<void> => {
    using packages: NativePackageObservation = new NativePackageObservation();
    await using fixture: ConnectorServiceFixture = await ConnectorServiceFixture.create(true);
    const path: string = await request(fixture);
    const runtimeFile: string = join(fixture.layout.installationDirectory, 'state/device.json');
    const before: Buffer = await readFile(runtimeFile);
    const plan: ConnectorNativePlan = await ConnectorNativeInstallation.prepare(
        path,
        new AbortController().signal,
    );
    expect(plan.phase).toBe(ConnectorNativePhase.Prepared);
    expect(await readFile(runtimeFile)).toEqual(before);
    const native: string = join(fixture.layout.installationDirectory, 'native');
    const original: Buffer = await readFile(join(native, 'plan.json'));
    expect((await readdir(native)).sort()).toEqual([
        'capability-request.json',
        'execution-policy.json',
        'files-policy.json',
        'plan.json',
        'runtime',
    ]);
    await using active: ConnectorClient = await ConnectorClient.load(runtimeFile, (): void => {});
    expect(active.identity.publicKey).toBe(plan.devicePublicKey);
    expect(await ConnectorNativeInstallation.prepare(path, new AbortController().signal)).toEqual(
        plan,
    );
    expect(await readFile(join(native, 'plan.json'))).toEqual(original);
    expect(await readFile(runtimeFile)).toEqual(before);
    expect(packages.preparationCalls).toBe(1);
    expect(packages.verificationCalls).toBe(1);
});

it('missing prepared code and changed approval cannot become a repaired or replacement runtime', async (): Promise<void> => {
    using packages: NativePackageObservation = new NativePackageObservation();
    await using fixture: ConnectorServiceFixture = await ConnectorServiceFixture.create(true);
    const path: string = await request(fixture);
    const plan: ConnectorNativePlan = await ConnectorNativeInstallation.prepare(
        path,
        new AbortController().signal,
    );
    await rm(join(fixture.layout.installationDirectory, 'native/runtime/usr/bin/true'));
    await expect(
        ConnectorNativeInstallation.prepare(path, new AbortController().signal),
    ).rejects.toThrow();
    const raw: unknown = JSON.parse(await readFile(path, 'utf8'));
    const original: ReturnType<typeof ConnectorNativePlans.request> =
        ConnectorNativePlans.request(raw);
    await writeFile(path, ConnectorNativePlans.encode({ ...original, files: null }));
    await expect(
        ConnectorNativeInstallation.prepare(path, new AbortController().signal),
    ).rejects.toThrow('original intent');
    expect(plan.enrollmentId).toBeTruthy();
    expect(packages.preparationCalls).toBe(1);
});
