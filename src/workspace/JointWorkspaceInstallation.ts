// SPDX-FileCopyrightText: 2026 Dacely <business@dacely.com>
// SPDX-License-Identifier: LicenseRef-Proprietary

import { dirname, basename } from 'node:path';
import { ProtectedFiles } from '../local/ProtectedFiles.js';
import {
    ConnectorClientConfiguration,
    type ConnectorClientIdentity,
} from '../runtime/ConnectorClientConfiguration.js';
import { ConnectorClientFiles } from '../runtime/ConnectorClientFiles.js';
import { ConnectorClientExecution } from '../runtime/ConnectorClientExecution.js';
import {
    ConnectorPrivateDirectory,
    ConnectorDirectoryPurpose,
} from '../runtime/ConnectorPrivateDirectory.js';
import { ConnectorHistoryMigration } from '../runtime/ConnectorHistoryMigration.js';
import type {
    ConnectorFileWorkspaceSource,
    ConnectorExecutionWorkspaceSource,
} from './ConnectorWorkspaceSource.js';
import {
    JointWorkspaceConfiguration,
    type JointWorkspaceLocalConfiguration,
    type JointWorkspaceRootMapping,
} from './JointWorkspaceConfiguration.js';
import {
    JointWorkspaceInstallationState,
    type JointWorkspaceInstallationIntent,
} from './JointWorkspaceInstallationState.js';
import { JointWorkspaceJournal } from './JointWorkspaceJournal.js';
import { JointWorkspaceJournalContext } from './JointWorkspaceJournalContext.js';
import type {
    JointWorkspaceJournalIdentity,
    JointWorkspaceJournalPair,
} from './JointWorkspaceJournalTypes.js';
import { JointWorkspaceCapture } from './JointWorkspaceCapture.js';
import type { JointWorkspaceDescriptor } from 'nerva-connector-protocol/workspace/JointWorkspaceBinding.js';
import { JointWorkspaceProof } from 'nerva-connector-protocol/workspace/JointWorkspaceProof.js';
import { JointWorkspaceRequestProtection } from './JointWorkspaceRequestProtection.js';

/** Local completion publishes only explicit mappings and signed descriptor metadata; it is never backend activation. */
export interface JointWorkspaceInstallationRoot extends JointWorkspaceRootMapping {
    readonly revision: bigint;
    readonly bindingSha256: string;
}
export interface JointWorkspaceInstallationReport {
    readonly installed: true;
    readonly activated: false;
    readonly roots: readonly JointWorkspaceInstallationRoot[];
}

/** Fixed safe copy preserves original state rather than suggesting reset or silently accepting another mapping. */
export class JointWorkspaceInstallationError extends Error {
    public constructor(canceled: boolean = false) {
        super(
            canceled
                ? 'Workspace setup canceled. Keep the original bindings and history; retry the same setup.'
                : 'Workspace setup could not finish. Stop the connector, keep the original bindings and history, and retry the same setup. Linux file and command confinement is required.',
        );
        this.name = 'JointWorkspaceInstallationError';
    }
}

/** Explicit stopped setup borrows one file owner and one shared two-lane command owner, never initializes their histories or grants. */
export class JointWorkspaceInstallation {
    public static async initialize(
        configurationFile: string,
        bindingsFile: string,
        signal: AbortSignal,
    ): Promise<JointWorkspaceInstallationReport> {
        try {
            return await this.#initialize(configurationFile, bindingsFile, signal);
        } catch {
            throw new JointWorkspaceInstallationError(signal.aborted);
        }
    }

    static async #initialize(
        configurationFile: string,
        bindingsFile: string,
        signal: AbortSignal,
    ): Promise<JointWorkspaceInstallationReport> {
        signal.throwIfAborted();
        if (process.platform !== 'linux') {
            throw new JointWorkspaceInstallationError();
        }
        const requested: JointWorkspaceLocalConfiguration =
            await JointWorkspaceConfiguration.request(bindingsFile);
        await using resources: AsyncDisposableStack = new AsyncDisposableStack();
        const original: ConnectorClientIdentity =
            await ConnectorClientConfiguration.load(configurationFile);
        resources.use(original.key);
        const directory: string = dirname(original.settings.privateKeyFile);
        for (const purpose of [
            ConnectorDirectoryPurpose.Runtime,
            ConnectorDirectoryPurpose.Pairing,
        ]) {
            resources.use(await ConnectorPrivateDirectory.open(directory, purpose));
        }
        const owner: ConnectorPrivateDirectory = resources.use(
            await ConnectorPrivateDirectory.open(directory, ConnectorDirectoryPurpose.Installation),
        );
        const identity: ConnectorClientIdentity =
            await ConnectorClientConfiguration.load(configurationFile);
        resources.use(identity.key);
        if (
            original.publicKey !== identity.publicKey ||
            original.authority.publicKey !== identity.authority.publicKey ||
            JSON.stringify(original.settings) !== JSON.stringify(identity.settings) ||
            identity.settings.files === null ||
            identity.settings.execution === null ||
            identity.settings.slot !== 0
        ) {
            throw new JointWorkspaceInstallationError();
        }
        signal.throwIfAborted();
        await ConnectorHistoryMigration.requireComplete(identity);
        const files: ConnectorClientFiles = resources.use(
            await ConnectorClientFiles.load(identity),
        );
        const commands: ConnectorClientExecution = resources.use(
            await ConnectorClientExecution.load(identity),
        );
        const file: ConnectorFileWorkspaceSource = files.workspaceSource;
        const execution: ConnectorExecutionWorkspaceSource = commands.workspaceSource;
        if (!file.quiescent || !execution.quiescent) {
            throw new JointWorkspaceInstallationError();
        }
        await JointWorkspaceRequestProtection.assert(
            bindingsFile,
            identity.settings.files.policyFile,
            file.profile.policySha256,
            execution.policy,
        );
        const journalIdentity: JointWorkspaceJournalIdentity = {
            scope: {
                authorityId: identity.settings.authorityId,
                authorityPublicKey: identity.authority.publicKey,
                environmentId: identity.settings.environmentId,
                enrollmentId: identity.settings.enrollmentId,
                devicePublicKey: identity.publicKey,
            },
            fileJournalId: file.journalId,
            executionJournals: execution.journals,
        };
        const context: JointWorkspaceJournalContext = new JointWorkspaceJournalContext(
            journalIdentity,
            identity.key,
        );
        const paths: ReturnType<typeof JointWorkspaceConfiguration.paths> =
            JointWorkspaceConfiguration.paths(identity.settings.privateKeyFile);
        const intent: JointWorkspaceInstallationIntent = JointWorkspaceInstallationState.create(
            context.digest,
            file.profile.policySha256,
            execution.profile.policySha256,
            requested,
        );
        const retained: JointWorkspaceInstallationIntent | null =
            await JointWorkspaceInstallationState.read(owner, paths.setupFile);
        const installed: JointWorkspaceLocalConfiguration | null =
            await JointWorkspaceConfiguration.read(identity.settings.privateKeyFile);
        if (
            (retained !== null && retained.intentSha256 !== intent.intentSha256) ||
            (installed !== null &&
                JointWorkspaceConfiguration.encode(installed) !==
                    JointWorkspaceConfiguration.encode(requested))
        ) {
            throw new JointWorkspaceInstallationError();
        }
        const fresh: boolean = retained === null && installed === null;
        if (fresh) {
            if (
                (await ProtectedFiles.exists(paths.stateDirectory)) ||
                (await owner.exists(basename(paths.configurationFile) + '.partial'))
            ) {
                throw new JointWorkspaceInstallationError();
            }
            signal.throwIfAborted();
            await JointWorkspaceInstallationState.write(owner, paths.setupFile, intent);
            // Only this known-fresh explicit attempt can initialize; every retry opens existing history without fallback.
            await ProtectedFiles.createDirectory(paths.stateDirectory);
            await JointWorkspaceJournal.initialize(
                paths.stateDirectory,
                identity.key,
                journalIdentity,
                signal,
            );
        }
        signal.throwIfAborted();
        const journal: JointWorkspaceJournal = resources.use(
            await JointWorkspaceJournal.open(
                paths.stateDirectory,
                identity.key,
                journalIdentity,
                signal,
            ),
        );
        this.#mapped(journal, requested);
        const existing: Map<string, JointWorkspaceDescriptor | null> = new Map();
        for (const pair of requested.roots) {
            signal.throwIfAborted();
            const descriptor: JointWorkspaceDescriptor | null = await journal.current(
                pair.fileRootId,
                pair.executionRootId,
                signal,
            );
            if (descriptor !== null) {
                this.#unchanged(descriptor, file, execution);
            } else if (installed !== null) {
                throw new JointWorkspaceInstallationError();
            }
            existing.set(JSON.stringify(pair), descriptor);
        }
        const capture: JointWorkspaceCapture = resources.use(
            new JointWorkspaceCapture(
                identity.key,
                journalIdentity.scope,
                file.filesystem,
                execution.policy,
            ),
        );
        const roots: JointWorkspaceInstallationRoot[] = [];
        for (const pair of requested.roots) {
            signal.throwIfAborted();
            if (!file.quiescent || !execution.quiescent) {
                throw new JointWorkspaceInstallationError();
            }
            let descriptor: JointWorkspaceDescriptor | null | undefined = existing.get(
                JSON.stringify(pair),
            );
            if (descriptor === null) {
                descriptor = await capture.capture(
                    {
                        revision: await journal.reserveRevision(signal),
                        ...pair,
                        fileJournalId: file.journalId,
                        executionJournals: execution.journals,
                        executionProfile: execution.profile,
                    },
                    signal,
                );
                descriptor = await journal.retain(descriptor, signal);
            }
            if (descriptor === undefined) {
                throw new JointWorkspaceInstallationError();
            }
            roots.push(
                Object.freeze({
                    ...pair,
                    revision: descriptor.binding.revision,
                    bindingSha256: JointWorkspaceProof.bindingSha256(descriptor.binding),
                }),
            );
        }
        signal.throwIfAborted();
        const bytes: Buffer = Buffer.from(JointWorkspaceConfiguration.encode(requested));
        try {
            const name: string = basename(paths.configurationFile);
            if (await owner.exists(name + '.partial')) {
                const partial: Buffer = await owner.read(
                    name + '.partial',
                    JointWorkspaceConfiguration.maximumBytes,
                );
                try {
                    if (!partial.equals(bytes)) {
                        throw new JointWorkspaceInstallationError();
                    }
                } finally {
                    partial.fill(0);
                }
                await owner.cleanPartial(name, JointWorkspaceConfiguration.maximumBytes);
            }
            if (installed === null) {
                await owner.write(name, bytes, JointWorkspaceConfiguration.maximumBytes, true);
            }
        } finally {
            bytes.fill(0);
        }
        signal.throwIfAborted();
        if (retained !== null || fresh) {
            await owner.remove(
                basename(paths.setupFile),
                JointWorkspaceInstallationState.maximumBytes,
            );
        }
        signal.throwIfAborted();
        return Object.freeze({ installed: true, activated: false, roots: Object.freeze(roots) });
    }

    static #mapped(
        journal: JointWorkspaceJournal,
        configuration: JointWorkspaceLocalConfiguration,
    ): void {
        if (
            journal.snapshot.pairs.some(
                (pair: JointWorkspaceJournalPair): boolean =>
                    !configuration.roots.some(
                        (requested: JointWorkspaceRootMapping): boolean =>
                            requested.fileRootId === pair.fileRootId &&
                            requested.executionRootId === pair.executionRootId,
                    ),
            )
        ) {
            throw new JointWorkspaceInstallationError();
        }
    }
    static #unchanged(
        descriptor: JointWorkspaceDescriptor,
        files: ConnectorFileWorkspaceSource,
        execution: ConnectorExecutionWorkspaceSource,
    ): void {
        if (
            descriptor.binding.filePolicySha256 !== files.profile.policySha256 ||
            descriptor.binding.executionPolicySha256 !== execution.profile.policySha256 ||
            descriptor.binding.access !== files.profile.mode
        ) {
            throw new JointWorkspaceInstallationError();
        }
    }
}
