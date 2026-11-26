// SPDX-FileCopyrightText: 2026 Dacely <business@dacely.com>
// SPDX-License-Identifier: LicenseRef-Proprietary

import { ConnectorNativeStore } from './ConnectorNativeStore.js';
import { ConnectorNativePlans } from './ConnectorNativePlan.js';
import { ConnectorNativeRuntime } from './ConnectorNativeRuntime.js';
import { ConnectorNativePolicies } from './ConnectorNativePolicies.js';
import { ConnectorNativeDelegation } from './ConnectorNativeDelegation.js';
import {
    ConnectorNativePhase,
    type ConnectorNativePlan,
    type ConnectorNativeLayout,
} from './ConnectorNativeTypes.js';
import {
    ConnectorPrivateDirectory,
    ConnectorDirectoryPurpose,
} from '../runtime/ConnectorPrivateDirectory.js';
import {
    ConnectorClientConfiguration,
    type ConnectorClientIdentity,
} from '../runtime/ConnectorClientConfiguration.js';
import { ConnectorCapabilityInstallation } from '../install/ConnectorCapabilityInstallation.js';
import { ConnectorCapabilityState } from '../install/ConnectorCapabilityState.js';
import { ConnectorReleaseCodec } from '../install/ConnectorReleaseCodec.js';
import { ConnectorReleaseFile } from '../install/ConnectorRelease.js';
import type { ConnectorInstallationView } from '../install/ConnectorInstallation.js';
import {
    ConnectorServiceScope,
    ConnectorServiceActiveState,
    type ConnectorServiceLayout,
    type ConnectorServiceStatus,
} from '../service/ConnectorServiceTypes.js';
import { ConnectorServiceUnit } from '../service/ConnectorServiceUnit.js';
import { ConnectorServiceSystemd } from '../service/ConnectorServiceSystemd.js';
import { ExecutionAppArmorInstaller } from '../execution/ExecutionAppArmorInstaller.js';

/** Explicit registered-service startup restores one approved native plan before any enrolled socket or command owner opens. */
export class ConnectorNativeBoot {
    /** Ordinary foreground run and remote protocol handlers never call this privileged installation role. */
    public static async restore(
        installed: ConnectorInstallationView,
        scope: ConnectorServiceScope,
        signal: AbortSignal,
    ): Promise<void> {
        if (!(await ConnectorNativeStore.present(installed.directory))) {
            return;
        }
        if (scope !== ConnectorServiceScope.System) {
            throw new Error('Automatic native preparation requires the registered system service');
        }
        const layout: ConnectorNativeLayout = ConnectorNativePlans.layout(installed.directory);
        await using locks: AsyncDisposableStack = new AsyncDisposableStack();
        locks.use(
            await ConnectorPrivateDirectory.open(
                installed.directory,
                ConnectorDirectoryPurpose.Native,
            ),
        );
        const plan: ConnectorNativePlan = await ConnectorNativeStore.read(layout);
        const service: ConnectorServiceLayout = ConnectorServiceUnit.layout(
            installed.directory,
            scope,
        );
        const status: ConnectorServiceStatus = await new ConnectorServiceSystemd().status(
            service,
            signal,
        );
        if (
            status.mainPid !== process.pid ||
            status.fragmentPath !== service.unitFile ||
            status.dropInPaths !== '' ||
            status.needsReload ||
            ![ConnectorServiceActiveState.Active, ConnectorServiceActiveState.Activating].includes(
                status.active,
            )
        ) {
            throw new Error(
                'Native restoration is not running as the original service main process',
            );
        }
        const identity: ConnectorClientIdentity = await ConnectorClientConfiguration.load(
            installed.runtimeFile,
        );
        using secret: DisposableStack = new DisposableStack();
        secret.use(identity.key);
        if (
            plan.phase !== ConnectorNativePhase.Prepared ||
            plan.request.installationDirectory !== installed.directory ||
            plan.devicePublicKey !== installed.publicKey ||
            plan.devicePublicKey !== identity.publicKey ||
            plan.enrollmentId !== identity.settings.enrollmentId ||
            plan.environmentId !== identity.settings.environmentId ||
            plan.releaseSha256 !==
                ConnectorCapabilityState.hash(ConnectorReleaseCodec.encode(installed.release))
        ) {
            throw new Error(
                'Native plan no longer matches the original installed device and release',
            );
        }
        await ConnectorNativeRuntime.verify(layout, plan.request.runtimeFiles, signal);
        await ConnectorNativeDelegation.restore(layout);
        await using owner: ConnectorPrivateDirectory = await ConnectorPrivateDirectory.open(
            layout.directory,
            ConnectorDirectoryPurpose.Installation,
        );
        await ConnectorNativePolicies.publish(owner, plan, installed, false);
        const policy: ReturnType<typeof ConnectorNativePlans.execution> =
            ConnectorNativePlans.execution(
                plan.request,
                plan.bubblewrapSha256,
                ConnectorNativePolicies.digest(installed, ConnectorReleaseFile.Execution),
            );
        await ExecutionAppArmorInstaller.installRequired(policy);
        await ConnectorCapabilityInstallation.install(
            owner.file('capability-request.json'),
            signal,
        );
    }
}
