// SPDX-FileCopyrightText: 2026 Dacely <business@dacely.com>
// SPDX-License-Identifier: LicenseRef-Proprietary

import { join } from 'node:path';
import { lstat, type FileHandle } from 'node:fs/promises';
import { ConnectorFileMode } from 'nerva-connector-protocol/protocol/ConnectorFiles.js';
import { ConnectorFileRoots } from '../runtime/ConnectorFileRoots.js';
import { ConnectorNativeExecutable } from '../runtime/ConnectorNativeExecutable.js';
import { ProtectedFiles } from '../local/ProtectedFiles.js';
import type { ConnectorPrivateDirectory } from '../runtime/ConnectorPrivateDirectory.js';
import type { ConnectorInstallationView } from '../install/ConnectorInstallation.js';
import { ConnectorReleaseFile } from '../install/ConnectorRelease.js';
import { ConnectorNativePlans } from './ConnectorNativePlan.js';
import { ConnectorNativeStore } from './ConnectorNativeStore.js';
import type {
    ConnectorNativeLayout,
    ConnectorNativePlan,
    ConnectorNativeRequest,
} from './ConnectorNativeTypes.js';

/** Runtime configuration receives generated fixed references while local root/program grants remain explicit. */
export class ConnectorNativePolicies {
    /** Native code is checked as an actual host-architecture ELF before its prepared plan can be installed or started. */
    public static async verifyPrograms(plan: ConnectorNativePlan): Promise<void> {
        const layout: ConnectorNativeLayout = ConnectorNativePlans.layout(
            plan.request.installationDirectory,
        );
        await using resources: AsyncDisposableStack = new AsyncDisposableStack();
        const seen: Set<string> = new Set();
        for (const program of plan.request.execution.programs) {
            for (const binary of [program, ...program.children]) {
                if (!seen.has(binary.path)) {
                    const executable: FileHandle = resources.use(
                        await ConnectorNativeExecutable.open(
                            join(layout.runtimeDirectory, '.' + binary.path),
                            binary.sha256,
                            268435456,
                        ),
                    );
                    await ConnectorNativeExecutable.assertRunnable(executable);
                    seen.add(binary.path);
                }
            }
        }
    }
    /** A new intent never silently takes over an existing private staging directory. */
    public static async assertFreshStaging(request: ConnectorNativeRequest): Promise<void> {
        const layout: ConnectorNativeLayout = ConnectorNativePlans.layout(
            request.installationDirectory,
        );
        if (request.files?.mode === ConnectorFileMode.ReadWrite) {
            for (const root of request.files.roots) {
                try {
                    await lstat(ConnectorNativePlans.staging(layout, root));
                } catch (caught: unknown) {
                    if (caught instanceof Error && 'code' in caught && caught.code === 'ENOENT') {
                        continue;
                    }
                    throw caught;
                }
                throw new Error('Unregistered native staging directory already exists');
            }
        }
    }
    /** All actual workspace roots exclude installation authority, source bundles, requests and every private staging path. */
    public static async preflight(
        request: ConnectorNativeRequest,
        requestFile: string,
    ): Promise<void> {
        const layout: ConnectorNativeLayout = ConnectorNativePlans.layout(
            request.installationDirectory,
        );
        const secrets: string[] = [
            layout.installationDirectory,
            request.sourceDirectory,
            requestFile,
        ];
        if (request.files?.mode === ConnectorFileMode.ReadWrite) {
            for (const root of request.files.roots) {
                secrets.push(ConnectorNativePlans.staging(layout, root));
            }
        }
        await using resources: AsyncDisposableStack = new AsyncDisposableStack();
        resources.use(
            await ConnectorFileRoots.load(
                request.execution.roots.map((root): Readonly<Record<string, string>> => ({
                    id: root.id,
                    path: root.path,
                })),
                ConnectorFileMode.ReadOnly,
                secrets,
            ),
        );
        if (request.files !== null) {
            resources.use(
                await ConnectorFileRoots.load(
                    request.files.roots,
                    ConnectorFileMode.ReadOnly,
                    secrets,
                ),
            );
        }
    }
    /** Staging is created only after durable original intent; ordinary startup never creates or repairs workspace paths. */
    public static async staging(plan: ConnectorNativePlan): Promise<void> {
        const layout: ConnectorNativeLayout = ConnectorNativePlans.layout(
            plan.request.installationDirectory,
        );
        if (plan.request.files?.mode === ConnectorFileMode.ReadWrite) {
            for (const root of plan.request.files.roots) {
                await ProtectedFiles.createDirectory(ConnectorNativePlans.staging(layout, root));
            }
        }
        if (plan.request.files !== null) {
            await using resources: AsyncDisposableStack = new AsyncDisposableStack();
            resources.use(
                await ConnectorFileRoots.load(
                    plan.request.files.roots.map((root): Readonly<Record<string, string>> =>
                        plan.request.files?.mode === ConnectorFileMode.ReadWrite
                            ? {
                                  id: root.id,
                                  path: root.path,
                                  stagingPath: ConnectorNativePlans.staging(layout, root),
                              }
                            : { id: root.id, path: root.path },
                    ),
                    plan.request.files.mode,
                    [layout.installationDirectory, plan.request.sourceDirectory],
                ),
            );
        }
    }
    /** Policies and local activation requests are stable outputs, with native helper digests supplied by the signed release. */
    public static async publish(
        owner: ConnectorPrivateDirectory,
        plan: ConnectorNativePlan,
        installed: ConnectorInstallationView,
        preparing: boolean,
    ): Promise<void> {
        const layout: ConnectorNativeLayout = ConnectorNativePlans.layout(installed.directory);
        const execution: Buffer = ConnectorNativePlans.encode(
            ConnectorNativePlans.execution(
                plan.request,
                plan.bubblewrapSha256,
                this.digest(installed, ConnectorReleaseFile.Execution),
            ),
        );
        await ConnectorNativeStore.publish(owner, 'execution-policy.json', execution, preparing);
        if (plan.request.files !== null) {
            const grant: typeof plan.request.files = plan.request.files;
            const policy: Buffer = Buffer.from(
                JSON.stringify({
                    mode: grant.mode,
                    revision: grant.revision.toString(),
                    helperFile: join(installed.directory, ConnectorReleaseFile.Files),
                    helperSha256: this.digest(installed, ConnectorReleaseFile.Files),
                    roots: grant.roots.map((root): Readonly<Record<string, string>> =>
                        grant.mode === ConnectorFileMode.ReadOnly
                            ? { id: root.id, path: root.path }
                            : {
                                  id: root.id,
                                  path: root.path,
                                  stagingPath: ConnectorNativePlans.staging(layout, root),
                              },
                    ),
                }),
            );
            await ConnectorNativeStore.publish(owner, 'files-policy.json', policy, preparing);
        }
        await ConnectorNativeStore.publish(
            owner,
            'capability-request.json',
            Buffer.from(
                JSON.stringify({
                    installationDirectory: installed.directory,
                    filesPolicyFile:
                        plan.request.files === null ? null : owner.file('files-policy.json'),
                    executionPolicyFile: owner.file('execution-policy.json'),
                }),
            ),
            preparing,
        );
    }
    /** A missing signed native asset is never replaced by another local executable. */
    public static digest(installed: ConnectorInstallationView, name: ConnectorReleaseFile): string {
        const value: string | undefined = installed.release.manifest.artifacts.find(
            (entry): boolean => entry.name === name,
        )?.sha256;
        if (value === undefined) {
            throw new Error('Signed native helper is missing');
        }
        return value;
    }
}
