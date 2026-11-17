// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

import { readdir } from 'node:fs/promises';
import { ProtectedFiles } from '../local/ProtectedFiles.js';
import {
    ConnectorPrivateDirectory,
    ConnectorDirectoryPurpose,
} from '../runtime/ConnectorPrivateDirectory.js';
import {
    ConnectorClientConfiguration,
    type ConnectorClientIdentity,
} from '../runtime/ConnectorClientConfiguration.js';
import type { ConnectorClientSettings } from '../runtime/ConnectorClientSettings.js';
import { ConnectorClientFiles } from '../runtime/ConnectorClientFiles.js';
import { ConnectorClientExecution } from '../runtime/ConnectorClientExecution.js';
import { ExecutionPairPreparation } from '../execution/ExecutionPairPreparation.js';
import { ExecutionAppArmorInstaller } from '../execution/ExecutionAppArmorInstaller.js';
import { ConnectorInstallation, type ConnectorInstallationView } from './ConnectorInstallation.js';
import {
    ConnectorCapabilityPlans,
    type ConnectorCapabilityPlan,
    type ConnectorCapabilityRequest,
} from './ConnectorCapabilityPlan.js';
import {
    ConnectorCapabilityState,
    ConnectorCapabilityPhase,
    type ConnectorCapabilityRecord,
} from './ConnectorCapabilityState.js';

/** Local setup returns commitments and references, never private identity or copied configuration bytes. */
export interface ConnectorCapabilityInstallationResult {
    readonly phase: ConnectorCapabilityPhase.Active;
    readonly intentSha256: string;
    readonly runtimeFile: string;
    readonly files: boolean;
    readonly execution: boolean;
}

/** Explicit local setup prepares approved confinement and encrypted history before atomically enabling native access. */
export class ConnectorCapabilityInstallation {
    /** A live runtime prevents setup; completed setup preserves original journals and never recreates missing history. */
    public static async install(
        path: string,
        signal: AbortSignal,
    ): Promise<ConnectorCapabilityInstallationResult> {
        const request: ConnectorCapabilityRequest = await ConnectorCapabilityPlans.request(path);
        const installed: ConnectorInstallationView = await ConnectorInstallation.read(
            request.installationDirectory,
            signal,
        );
        if (!installed.enrolled) {
            throw new Error(
                'Pair the original installed device before granting local capabilities',
            );
        }
        await using installation: ConnectorPrivateDirectory = await ConnectorPrivateDirectory.open(
            installed.directory,
            ConnectorDirectoryPurpose.Installation,
        );
        await using runtime: ConnectorPrivateDirectory = await ConnectorPrivateDirectory.open(
            installed.stateDirectory,
            ConnectorDirectoryPurpose.Runtime,
        );
        const plan: ConnectorCapabilityPlan = await ConnectorCapabilityPlans.read(
            path,
            request,
            installed,
        );
        const directory: string = installation.file('capabilities');
        await ProtectedFiles.createDirectory(directory);
        await using owner: ConnectorPrivateDirectory = await ConnectorPrivateDirectory.open(
            directory,
            ConnectorDirectoryPurpose.Installation,
        );
        const record: ConnectorCapabilityRecord | null = await ConnectorCapabilityState.read(owner);
        if (
            record === null &&
            (await readdir(directory)).some((name): boolean => name !== 'intent.json.partial')
        ) {
            throw new Error('Unregistered capability installation content');
        }
        using secrets: DisposableStack = new DisposableStack();
        const current: ConnectorClientIdentity = await ConnectorClientConfiguration.load(
            installed.runtimeFile,
        );
        secrets.use(current.key);
        if (current.publicKey !== installed.publicKey) {
            throw new Error('Original installed device identity changed');
        }
        const target: ConnectorClientSettings = {
            ...current.settings,
            files:
                plan.files === null
                    ? null
                    : {
                          policyFile: owner.file('files-policy.json'),
                          stateDirectory: owner.file('files'),
                      },
            execution:
                plan.execution === null
                    ? null
                    : {
                          policyFile: owner.file('execution-policy.json'),
                          stateDirectory: owner.file('execution'),
                      },
        };
        const bytes: Buffer = Buffer.from(JSON.stringify(target));
        const actualSha256: string = ConnectorCapabilityState.hash(
            JSON.stringify(current.settings),
        );
        const targetSha256: string = ConnectorCapabilityState.hash(bytes);
        const intentSha256: string = ConnectorCapabilityState.hash(
            JSON.stringify([
                installed.publicKey,
                current.settings.enrollmentId,
                current.settings.environmentId,
                plan.files?.bytes.toString('utf8') ?? null,
                plan.execution?.bytes.toString('utf8') ?? null,
                targetSha256,
            ]),
        );
        if (
            record === null &&
            (current.settings.files !== null || current.settings.execution !== null)
        ) {
            throw new Error('Existing local grants require an explicit policy migration');
        }
        if (
            record !== null &&
            (record.intentSha256 !== intentSha256 ||
                record.targetSha256 !== targetSha256 ||
                ![record.originalSha256, record.targetSha256].includes(actualSha256))
        ) {
            throw new Error('Capability setup differs from its original intent');
        }
        const original: ConnectorCapabilityRecord = record ?? {
            intentSha256,
            originalSha256: actualSha256,
            targetSha256,
            phase: ConnectorCapabilityPhase.Preparing,
        };
        if (
            original.phase === ConnectorCapabilityPhase.Preparing &&
            actualSha256 !== original.originalSha256
        ) {
            throw new Error('Unprepared capability configuration was exposed');
        }
        if (record === null) {
            await ConnectorCapabilityState.write(owner, original, true);
        }
        for (const [name, policy] of [
            ['files-policy.json', plan.files],
            ['execution-policy.json', plan.execution],
        ] as const) {
            if (policy !== null) {
                await this.#publish(
                    owner,
                    name,
                    policy.bytes,
                    original.phase === ConnectorCapabilityPhase.Preparing,
                );
            }
        }
        const identity: ConnectorClientIdentity = { ...current, settings: target };
        if (original.phase === ConnectorCapabilityPhase.Preparing) {
            if (plan.execution?.execution !== null && plan.execution?.execution !== undefined) {
                if (
                    (await readdir(plan.execution.execution.cgroupRoot)).some((name): boolean =>
                        name.startsWith('exec-'),
                    )
                ) {
                    throw new Error(
                        'Execution policy has retained command cgroups; inspect original ownership',
                    );
                }
                await ExecutionAppArmorInstaller.installRequired(plan.execution.execution);
            }
            if (target.files !== null) {
                await ProtectedFiles.createDirectory(target.files.stateDirectory);
                const state: ConnectorPrivateDirectory = await ConnectorPrivateDirectory.open(
                    target.files.stateDirectory,
                    ConnectorDirectoryPurpose.Installation,
                );
                try {
                    if (!(await state.exists('file-journal'))) {
                        await ConnectorClientFiles.initialize(identity);
                    }
                } finally {
                    await state[Symbol.asyncDispose]();
                }
            }
            if (target.execution !== null) {
                await ProtectedFiles.createDirectory(target.execution.stateDirectory);
                await ExecutionPairPreparation.prepare(identity, true);
            }
        }
        if (target.files !== null) {
            await using files: ConnectorClientFiles = await ConnectorClientFiles.load(identity);
            if (files.failed) {
                throw new Error('Prepared native file history is unavailable');
            }
        }
        if (target.execution !== null) {
            if (plan.execution?.execution === null || plan.execution?.execution === undefined) {
                throw new Error('Original execution policy is unavailable');
            }
            await ExecutionAppArmorInstaller.assertRequired(plan.execution.execution);
            await using execution: ConnectorClientExecution =
                await ConnectorClientExecution.load(identity);
            if (execution.failed) {
                throw new Error('Prepared native command history is unavailable');
            }
        }
        signal.throwIfAborted();
        if (original.phase === ConnectorCapabilityPhase.Preparing) {
            await ConnectorCapabilityState.write(
                owner,
                { ...original, phase: ConnectorCapabilityPhase.Prepared },
                false,
            );
        }
        if (actualSha256 !== targetSha256) {
            await runtime.cleanPartial('device.json', 16384);
            await runtime.write('device.json', bytes, 16384, false);
        }
        await ConnectorCapabilityState.write(
            owner,
            { ...original, phase: ConnectorCapabilityPhase.Active },
            false,
        );
        return {
            phase: ConnectorCapabilityPhase.Active,
            intentSha256,
            runtimeFile: installed.runtimeFile,
            files: target.files !== null,
            execution: target.execution !== null,
        };
    }
    static async #publish(
        owner: ConnectorPrivateDirectory,
        name: string,
        bytes: Buffer,
        preparing: boolean,
    ): Promise<void> {
        if (await owner.exists(name)) {
            if (!(await owner.read(name, 131072)).equals(bytes)) {
                throw new Error('Original capability policy bytes changed');
            }
        } else if (preparing) {
            await owner.cleanPartial(name, 131072);
            await owner.write(name, bytes, 131072, true);
        } else {
            throw new Error('Original capability policy disappeared');
        }
    }
}
