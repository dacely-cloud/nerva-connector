// SPDX-FileCopyrightText: 2026 Dacely <business@dacely.com>
// SPDX-License-Identifier: LicenseRef-Proprietary

import { lstat } from 'node:fs/promises';
import type { ExecutionDeliveryLink } from '../execution/ExecutionDeliveryLink.js';
import type { ConnectorClientIdentity } from './ConnectorClientConfiguration.js';
import type { ConnectorClientFiles } from './ConnectorClientFiles.js';
import type { ConnectorClientExecution } from './ConnectorClientExecution.js';
import { ConnectorStartupStage, type ConnectorStartupObserver } from './ConnectorStartup.js';
import {
    JointWorkspaceConfiguration,
    type JointWorkspaceLocalConfiguration,
    type JointWorkspaceConfigurationPaths,
} from '../workspace/JointWorkspaceConfiguration.js';
import type {
    ConnectorFileWorkspaceSource,
    ConnectorExecutionWorkspaceSource,
} from '../workspace/ConnectorWorkspaceSource.js';
import { JointWorkspaceJournal } from '../workspace/JointWorkspaceJournal.js';
import type { JointWorkspaceJournalIdentity } from '../workspace/JointWorkspaceJournalTypes.js';
import { JointWorkspaceCapture } from '../workspace/JointWorkspaceCapture.js';
import type { JointWorkspaceDescriptor } from 'nerva-connector-protocol/workspace/JointWorkspaceBinding.js';
import type { ConnectorFilePermit } from 'nerva-connector-protocol/protocol/ConnectorFileJobs.js';
import type { ExecutionPermit } from 'nerva-connector-protocol/execution/ExecutionJobs.js';
import type { ConnectorJointAdmission } from './ConnectorJointAdmission.js';
import { JointWorkspaceAdmission } from '../workspace/JointWorkspaceAdmission.js';
import { JointWorkspaceProof } from 'nerva-connector-protocol/workspace/JointWorkspaceProof.js';
import {
    JointWorkspaceDelivery,
    type JointWorkspaceDeliveryReply,
} from '../workspace/JointWorkspaceDelivery.js';

/** One installed mapping set borrows the existing capabilities and owns only its metadata journal and delivery loop. */
export class ConnectorClientWorkspaces implements AsyncDisposable, ConnectorJointAdmission {
    readonly #resources: AsyncDisposableStack;
    readonly #delivery: JointWorkspaceDelivery;
    readonly #admission: JointWorkspaceAdmission;

    private constructor(
        resources: AsyncDisposableStack,
        delivery: JointWorkspaceDelivery,
        admission: JointWorkspaceAdmission,
    ) {
        this.#delivery = delivery;
        this.#admission = admission;
        this.#resources = resources.move();
    }

    /** Optional absence is uninstalled; installed metadata requires its exact existing history and actual opened-directory captures. */
    public static async load(
        identity: ConnectorClientIdentity,
        files: ConnectorClientFiles | null,
        execution: ConnectorClientExecution | null,
        signal: AbortSignal,
        progress?: ConnectorStartupObserver,
    ): Promise<ConnectorClientWorkspaces | null> {
        signal.throwIfAborted();
        const paths: JointWorkspaceConfigurationPaths = JointWorkspaceConfiguration.paths(
            identity.settings.privateKeyFile,
        );
        await this.#requireCompletedSetup(paths);
        const configuration: JointWorkspaceLocalConfiguration | null =
            await JointWorkspaceConfiguration.read(identity.settings.privateKeyFile);
        if (configuration === null) {
            try {
                await lstat(paths.stateDirectory);
            } catch (caught: unknown) {
                if (caught instanceof Error && 'code' in caught && caught.code === 'ENOENT') {
                    return null;
                }
                throw caught;
            }
            throw new Error('Saved workspace mappings are missing; keep their original history');
        }
        if (files === null || execution === null || identity.settings.slot !== 0) {
            throw new Error(
                'Installed workspace mappings require both existing primary capabilities',
            );
        }
        progress?.({ stage: ConnectorStartupStage.WorkspaceAccess });
        const file: ConnectorFileWorkspaceSource = files.workspaceSource;
        const commands: ConnectorExecutionWorkspaceSource = execution.workspaceSource;
        const journalIdentity: JointWorkspaceJournalIdentity = {
            scope: {
                authorityId: identity.authority.authorityId,
                authorityPublicKey: identity.authority.publicKey,
                environmentId: identity.settings.environmentId,
                enrollmentId: identity.settings.enrollmentId,
                devicePublicKey: identity.publicKey,
            },
            fileJournalId: file.journalId,
            executionJournals: commands.journals,
        };
        await using resources: AsyncDisposableStack = new AsyncDisposableStack();
        const journal: JointWorkspaceJournal = resources.use(
            await JointWorkspaceJournal.open(
                paths.stateDirectory,
                identity.key,
                journalIdentity,
                signal,
            ),
        );
        if (
            journal.snapshot.pairs.length !== configuration.roots.length ||
            journal.snapshot.reservedRevision !== null
        ) {
            throw new Error('Workspace installation is incomplete; finish its original setup');
        }
        const bindings: JointWorkspaceDescriptor[] = [];
        {
            await using capture: JointWorkspaceCapture = new JointWorkspaceCapture(
                identity.key,
                journalIdentity.scope,
                file.filesystem,
                commands.policy,
            );
            for (const root of configuration.roots) {
                const original: JointWorkspaceDescriptor | null = await journal.current(
                    root.fileRootId,
                    root.executionRootId,
                    signal,
                );
                if (original === null) {
                    throw new Error('Installed workspace has no original retained binding');
                }
                const captured: JointWorkspaceDescriptor = await capture.capture(
                    {
                        revision: original.binding.revision,
                        fileRootId: root.fileRootId,
                        executionRootId: root.executionRootId,
                        fileJournalId: file.journalId,
                        executionJournals: commands.journals,
                        executionProfile: commands.profile,
                    },
                    signal,
                );
                if (
                    JointWorkspaceProof.bindingSha256(original.binding) !==
                    JointWorkspaceProof.bindingSha256(captured.binding)
                ) {
                    throw new Error(
                        'Workspace policy or physical directory changed; keep original history',
                    );
                }
                bindings.push(original);
            }
        }
        signal.throwIfAborted();
        const delivery: JointWorkspaceDelivery = resources.use(
            new JointWorkspaceDelivery(identity, journal, bindings, progress),
        );
        return new ConnectorClientWorkspaces(
            resources,
            delivery,
            new JointWorkspaceAdmission(identity, file, commands, delivery, bindings),
        );
    }

    /** Readiness is metadata acceptance for the current lease, not a grant to execute compound tools. */
    public get ready(): boolean {
        return this.#delivery.ready;
    }
    public get failed(): boolean {
        return this.#delivery.failed;
    }
    public activate(link: ExecutionDeliveryLink): void {
        this.#delivery.activate(link);
    }
    public detach(link: ExecutionDeliveryLink): void {
        this.#delivery.detach(link);
    }
    public receive(frame: JointWorkspaceDeliveryReply, link: ExecutionDeliveryLink): void {
        this.#delivery.receive(frame, link);
    }
    public async file(permit: ConnectorFilePermit): Promise<void> {
        await this.#admission.file(permit);
    }
    public async execution(permit: ExecutionPermit): Promise<void> {
        await this.#admission.execution(permit);
    }
    /** Delivery joins before the metadata journal; the enclosing client releases borrowed capabilities and the key afterward. */
    public async [Symbol.asyncDispose](): Promise<void> {
        await this.#resources[Symbol.asyncDispose]();
    }

    static async #requireCompletedSetup(paths: JointWorkspaceConfigurationPaths): Promise<void> {
        for (const file of [
            paths.setupFile,
            paths.setupFile + '.partial',
            paths.configurationFile + '.partial',
        ]) {
            try {
                await lstat(file);
            } catch (caught: unknown) {
                if (caught instanceof Error && 'code' in caught && caught.code === 'ENOENT') {
                    continue;
                }
                throw caught;
            }
            throw new Error(
                'Workspace setup is unfinished; retry initialize-workspaces with the original mappings',
            );
        }
    }
}
