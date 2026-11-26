// SPDX-FileCopyrightText: 2026 Dacely <business@dacely.com>
// SPDX-License-Identifier: LicenseRef-Proprietary

import { readdir, lstat } from 'node:fs/promises';
import type { BigIntStats } from 'node:fs';
import { ProtectedFiles } from '../local/ProtectedFiles.js';
import { ProtectedArtifact } from '../local/ProtectedArtifact.js';
import {
    ConnectorPrivateDirectory,
    ConnectorDirectoryPurpose,
} from '../runtime/ConnectorPrivateDirectory.js';
import {
    ConnectorClientConfiguration,
    type ConnectorClientIdentity,
} from '../runtime/ConnectorClientConfiguration.js';
import {
    ConnectorInstallation,
    type ConnectorInstallationView,
} from '../install/ConnectorInstallation.js';
import { ConnectorReleaseCodec } from '../install/ConnectorReleaseCodec.js';
import { ConnectorCapabilityState } from '../install/ConnectorCapabilityState.js';
import { ConnectorServiceManager } from '../service/ConnectorServiceManager.js';
import { ConnectorServiceUnit } from '../service/ConnectorServiceUnit.js';
import {
    ConnectorServiceScope,
    type ConnectorServiceStatus,
} from '../service/ConnectorServiceTypes.js';
import { ConnectorNativePlans } from './ConnectorNativePlan.js';
import { ConnectorNativeStore } from './ConnectorNativeStore.js';
import { ConnectorNativeDependencies } from './ConnectorNativeDependencies.js';
import { ConnectorNativeRuntime } from './ConnectorNativeRuntime.js';
import { ConnectorNativePolicies } from './ConnectorNativePolicies.js';
import {
    ConnectorNativePhase,
    type ConnectorNativeRequest,
    type ConnectorNativePlan,
    type ConnectorNativeLayout,
} from './ConnectorNativeTypes.js';

/** Native setup reports local preparation and manager observation; cloud online presence remains independently authenticated. */
export interface ConnectorNativeInstallationResult {
    readonly phase: ConnectorNativePhase.Prepared;
    readonly runtimeDirectory: string;
    readonly service: ConnectorServiceStatus;
}

/** One root-owned local operation prepares approved native tooling and starts its registered persistent service. */
export class ConnectorNativeInstallation {
    /** Registered startup restores the delegated cgroup and enforcing policy before the enrolled connection can open. */
    public static async install(
        path: string,
        signal: AbortSignal,
        expectedDirectory?: string,
    ): Promise<ConnectorNativeInstallationResult> {
        const plan: ConnectorNativePlan = await this.prepare(path, signal, expectedDirectory);
        const manager: ConnectorServiceManager = new ConnectorServiceManager(
            ConnectorServiceUnit.layout(
                plan.request.installationDirectory,
                ConnectorServiceScope.System,
            ),
        );
        await manager.install(signal);
        const service: ConnectorServiceStatus = await manager.start(signal);
        return {
            phase: ConnectorNativePhase.Prepared,
            runtimeDirectory: ConnectorNativePlans.layout(plan.request.installationDirectory)
                .runtimeDirectory,
            service,
        };
    }
    /** Retry resumes the same approved byte set; an already prepared tree is verified rather than repaired or duplicated. */
    public static async prepare(
        path: string,
        signal: AbortSignal,
        expectedDirectory?: string,
    ): Promise<ConnectorNativePlan> {
        const request: ConnectorNativeRequest = ConnectorNativePlans.request(
            JSON.parse(
                new TextDecoder('utf-8', { fatal: true }).decode(
                    await ProtectedFiles.readPrivate(path, 131072),
                ),
            ),
        );
        const layout: ConnectorNativeLayout = ConnectorNativePlans.layout(
            request.installationDirectory,
        );
        if (expectedDirectory !== undefined && layout.installationDirectory !== expectedDirectory) {
            throw new Error('Native setup targets another installation');
        }
        if (
            request.sourceDirectory === layout.installationDirectory ||
            request.sourceDirectory.startsWith(layout.installationDirectory + '/') ||
            layout.installationDirectory.startsWith(request.sourceDirectory + '/')
        ) {
            throw new Error('Runtime sources must be independent from installed authority');
        }
        const installed: ConnectorInstallationView = await ConnectorInstallation.read(
            layout.installationDirectory,
            signal,
        );
        if (!installed.enrolled) {
            throw new Error('Pair the original installed device before native preparation');
        }
        await using locks: AsyncDisposableStack = new AsyncDisposableStack();
        locks.use(
            await ConnectorPrivateDirectory.open(
                installed.directory,
                ConnectorDirectoryPurpose.Native,
            ),
        );
        await using installation: ConnectorPrivateDirectory = await ConnectorPrivateDirectory.open(
            installed.directory,
            ConnectorDirectoryPurpose.Installation,
        );
        await ConnectorNativePolicies.preflight(request, path);
        const directory: string = installation.file('native');
        await ProtectedFiles.createDirectory(directory);
        await using owner: ConnectorPrivateDirectory = await ConnectorPrivateDirectory.open(
            directory,
            ConnectorDirectoryPurpose.Installation,
        );
        const existing: ConnectorNativePlan | null = (await owner.exists('plan.json'))
            ? await ConnectorNativeStore.read(layout)
            : null;
        using keys: DisposableStack = new DisposableStack();
        const device: ConnectorClientIdentity = await ConnectorClientConfiguration.load(
            installed.runtimeFile,
        );
        keys.use(device.key);
        if (device.publicKey !== installed.publicKey) {
            throw new Error('Native device identity changed');
        }
        const original: ConnectorNativePlan = {
            request,
            releaseSha256: ConnectorCapabilityState.hash(
                ConnectorReleaseCodec.encode(installed.release),
            ),
            devicePublicKey: installed.publicKey,
            enrollmentId: device.settings.enrollmentId,
            environmentId: device.settings.environmentId,
            phase: ConnectorNativePhase.Preparing,
            bubblewrapSha256: existing?.bubblewrapSha256 ?? '0'.repeat(64),
        };
        if (
            existing !== null &&
            !ConnectorNativePlans.encode({
                ...existing,
                phase: ConnectorNativePhase.Preparing,
            }).equals(ConnectorNativePlans.encode(original))
        ) {
            throw new Error('Native setup differs from its original intent');
        }
        if (existing?.phase !== ConnectorNativePhase.Prepared) {
            locks.use(
                await ConnectorPrivateDirectory.open(
                    installed.stateDirectory,
                    ConnectorDirectoryPurpose.Runtime,
                ),
            );
        }
        if (existing === null) {
            if (
                (await readdir(directory)).some((name): boolean => name !== 'plan.json.partial') ||
                device.settings.files !== null ||
                device.settings.execution !== null
            ) {
                throw new Error(
                    'Unregistered native content or existing grants require explicit migration',
                );
            }
            await ConnectorNativePolicies.assertFreshStaging(request);
            await ConnectorNativeStore.write(owner, original, true);
        }
        if (existing?.phase === ConnectorNativePhase.Prepared) {
            await ConnectorNativeDependencies.verify();
        } else {
            await ConnectorNativeDependencies.ensure(signal);
        }
        const info: BigIntStats = await lstat('/usr/bin/bwrap', { bigint: true });
        const bubblewrapSha256: string = await ProtectedArtifact.transfer(
            '/usr/bin/bwrap',
            null,
            { sizeBytes: info.size, maximumBytes: 16777216, executable: true },
            signal,
        );
        if (
            original.bubblewrapSha256 !== '0'.repeat(64) &&
            original.bubblewrapSha256 !== bubblewrapSha256
        ) {
            throw new Error('Pinned system confinement binary changed');
        }
        const plan: ConnectorNativePlan = { ...original, bubblewrapSha256 };
        if (existing?.phase === ConnectorNativePhase.Prepared) {
            await ConnectorNativeRuntime.verify(layout, request.runtimeFiles, signal);
            await ConnectorNativePolicies.verifyPrograms(existing);
            await ConnectorNativePolicies.publish(owner, existing, installed, false);
            return existing;
        }
        await ConnectorNativeStore.write(owner, plan, false);
        await ConnectorNativeRuntime.prepare(
            layout,
            request.sourceDirectory,
            request.runtimeFiles,
            signal,
        );
        await ConnectorNativePolicies.staging(plan);
        await ConnectorNativePolicies.verifyPrograms(plan);
        await ConnectorNativePolicies.publish(owner, plan, installed, true);
        const prepared: ConnectorNativePlan = { ...plan, phase: ConnectorNativePhase.Prepared };
        await ConnectorNativeStore.write(owner, prepared, false);
        signal.throwIfAborted();
        return prepared;
    }
}
