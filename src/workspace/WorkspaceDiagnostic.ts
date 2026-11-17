// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

import { timingSafeEqual } from 'node:crypto';
import {
    ConnectorClientConfiguration,
    type ConnectorClientIdentity,
} from '../runtime/ConnectorClientConfiguration.js';
import { ConnectorFilesystem } from '../runtime/ConnectorFilesystem.js';
import { ExecutionPolicy } from '../execution/ExecutionPolicy.js';
import { ExecutionConfiguration } from '../execution/ExecutionConfiguration.js';
import { Boundary } from 'nerva-connector-protocol/protocol/Boundary.js';
import { ProtectedFiles } from '../local/ProtectedFiles.js';
import { ConnectorFilePolicy } from '../runtime/ConnectorFilePolicy.js';
import type { ConnectorLocalCapabilitySettings } from '../runtime/ConnectorClientSettings.js';
import type { WorkspaceInspection } from './WorkspaceInspection.js';
import { WorkspaceIdentityProcess } from './WorkspaceIdentityProcess.js';
import { WorkspaceIdentityFailure, type WorkspaceIdentityResult } from './WorkspaceIdentity.js';
import { WorkspaceCommitment } from './WorkspaceCommitment.js';

/** Inspection is local evidence only; no outcome grants a joint Machine or command capability. */
export enum WorkspaceCompatibility {
    Compatible = 'compatible',
    DifferentRoot = 'different-root',
    AccessMismatch = 'access-mismatch',
    Unsupported = 'unsupported',
    Unavailable = 'unavailable',
}

/** Operator input names an existing runtime configuration and already granted aliases. */
export interface WorkspaceDiagnosticRequest {
    readonly configurationFile: string;
    readonly fileRootId: string;
    readonly executionRootId: string;
}

/** This is the complete public diagnostic output; paths, identities and commitments are deliberately absent. */
export interface WorkspaceDiagnosticReport {
    readonly fileRootId: string;
    readonly executionRootId: string;
    readonly status: WorkspaceCompatibility;
}

/** Loads existing authority and policies without sockets, command execution or capability-journal creation. */
export class WorkspaceDiagnostic {
    /** Missing, malformed or changed authority reports unavailable; it is never reconstructed or reset. */
    public static async inspect(
        request: WorkspaceDiagnosticRequest,
        signal: AbortSignal,
    ): Promise<WorkspaceDiagnosticReport> {
        const fileRootId: string = Boundary.id(request.fileRootId);
        const executionRootId: string = Boundary.id(request.executionRootId);
        let status: WorkspaceCompatibility = WorkspaceCompatibility.Unavailable;
        try {
            if (signal.aborted) {
                return { fileRootId, executionRootId, status };
            }
            const identity: ConnectorClientIdentity = await ConnectorClientConfiguration.load(
                ProtectedFiles.path(request.configurationFile),
            );
            using key: typeof identity.key = identity.key;
            const files: ConnectorLocalCapabilitySettings | null = identity.settings.files;
            const execution: ConnectorLocalCapabilitySettings | null = identity.settings.execution;
            if (files !== null && execution !== null && !signal.aborted) {
                const protectedPaths: readonly string[] = [
                    identity.configurationFile,
                    identity.settings.privateKeyFile,
                    identity.settings.authorityPublicKeyFile,
                    files.policyFile,
                    files.stateDirectory,
                    execution.policyFile,
                    execution.stateDirectory,
                    ...(identity.settings.serverCaFile === null
                        ? []
                        : [identity.settings.serverCaFile]),
                ];
                await using filesystem: ConnectorFilesystem = await ConnectorFilesystem.load(
                    files.policyFile,
                    [
                        ...protectedPaths,
                        ...(await ExecutionConfiguration.protectedPaths(execution)),
                    ],
                );
                if (signal.aborted) {
                    return { fileRootId, executionRootId, status };
                }
                await using commands: ExecutionPolicy = await ExecutionPolicy.load(
                    execution.policyFile,
                    [...protectedPaths, ...(await ConnectorFilePolicy.protectedPaths(files))],
                );
                if (signal.aborted) {
                    return { fileRootId, executionRootId, status };
                }
                await using inspector: WorkspaceIdentityProcess = new WorkspaceIdentityProcess();
                using commitments: WorkspaceCommitment = new WorkspaceCommitment(key, {
                    authorityId: identity.authority.authorityId,
                    authorityPublicKey: identity.authority.publicKey,
                    enrollmentId: identity.settings.enrollmentId,
                    environmentId: identity.settings.environmentId,
                });
                status = await filesystem.inspectWorkspace(
                    fileRootId,
                    async (file: WorkspaceInspection): Promise<WorkspaceCompatibility> =>
                        await commands.inspectWorkspace(
                            executionRootId,
                            async (
                                command: WorkspaceInspection,
                            ): Promise<WorkspaceCompatibility> => {
                                if (file.access !== command.access) {
                                    return WorkspaceCompatibility.AccessMismatch;
                                }
                                const results: readonly WorkspaceIdentityResult[] =
                                    await Promise.all([
                                        inspector.inspect(file),
                                        inspector.inspect(command),
                                    ]);
                                if (
                                    signal.aborted ||
                                    file.signal.aborted ||
                                    command.signal.aborted
                                ) {
                                    return WorkspaceCompatibility.Unavailable;
                                }
                                return this.#compare(results, commitments);
                            },
                            signal,
                        ),
                    signal,
                );
            }
        } catch {
            status = WorkspaceCompatibility.Unavailable;
        }
        if (signal.aborted) {
            status = WorkspaceCompatibility.Unavailable;
        }
        return { fileRootId, executionRootId, status };
    }

    static #compare(
        results: readonly WorkspaceIdentityResult[],
        commitments: WorkspaceCommitment,
    ): WorkspaceCompatibility {
        if (
            results.some(
                (result: WorkspaceIdentityResult): boolean =>
                    !result.ok && result.error !== WorkspaceIdentityFailure.Unsupported,
            )
        ) {
            return WorkspaceCompatibility.Unavailable;
        }
        const file: WorkspaceIdentityResult | undefined = results[0];
        const execution: WorkspaceIdentityResult | undefined = results[1];
        if (file === undefined || execution === undefined) {
            return WorkspaceCompatibility.Unavailable;
        }
        if (!file.ok || !execution.ok) {
            return WorkspaceCompatibility.Unsupported;
        }
        const first: Buffer = commitments.commitment(file.identity);
        let second: Buffer | null = null;
        try {
            second = commitments.commitment(execution.identity);
            return timingSafeEqual(first, second)
                ? WorkspaceCompatibility.Compatible
                : WorkspaceCompatibility.DifferentRoot;
        } finally {
            first.fill(0);
            second?.fill(0);
        }
    }
}
