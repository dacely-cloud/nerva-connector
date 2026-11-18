// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

import type { SigningKey } from '../identity/SigningKey.js';
import type { ExecutionPolicy } from '../execution/ExecutionPolicy.js';
import type { ExecutionProfile } from 'nerva-connector-protocol/execution/ExecutionJobs.js';
import { ExecutionJobsCodec } from '../execution/ExecutionJobsCodec.js';
import { Boundary } from 'nerva-connector-protocol/protocol/Boundary.js';
import { ConnectorEnrollmentCodec } from 'nerva-connector-protocol/protocol/ConnectorEnrollmentCodec.js';
import type { ConnectorFilesystem } from '../runtime/ConnectorFilesystem.js';
import { JointWorkspaceAssembly } from './JointWorkspaceAssembly.js';
import { JointWorkspaceCodec } from 'nerva-connector-protocol/workspace/JointWorkspaceCodec.js';
import type {
    JointWorkspaceDescriptor,
    JointWorkspaceExecutionJournals,
    JointWorkspacePhysicalScope,
} from 'nerva-connector-protocol/workspace/JointWorkspaceBinding.js';
import type { WorkspaceInspection } from './WorkspaceInspection.js';
import type { WorkspaceIdentityResult } from './WorkspaceIdentity.js';
import { WorkspaceIdentityProcess } from './WorkspaceIdentityProcess.js';

/** The installation supplies its permanent journals and current command profile, never inferred aliases or fresh counters. */
export interface JointWorkspaceCaptureRequest {
    readonly revision: bigint;
    readonly fileRootId: string;
    readonly executionRootId: string;
    readonly fileJournalId: string;
    readonly executionJournals: JointWorkspaceExecutionJournals;
    readonly executionProfile: ExecutionProfile;
}

/** Joins both borrowed policy capabilities while real native inspectors capture the actual roots before descriptor signing. */
export class JointWorkspaceCapture implements AsyncDisposable {
    readonly #inspector: WorkspaceIdentityProcess = new WorkspaceIdentityProcess();
    readonly #stop: AbortController = new AbortController();
    readonly #operations: Set<Promise<undefined>> = new Set();
    readonly #scope: JointWorkspacePhysicalScope;
    #closed: boolean = false;

    /** The installation must keep the key and both policy owners alive until this owner's joined disposal completes. */
    public constructor(
        public readonly key: SigningKey,
        scope: JointWorkspacePhysicalScope,
        public readonly filesystem: ConnectorFilesystem,
        public readonly commands: ExecutionPolicy,
    ) {
        this.#scope = JointWorkspaceCodec.physicalScope(scope);
        if (this.#scope.devicePublicKey !== key.publicKey) {
            throw new Error('Joint workspace device identity changed');
        }
    }

    /** Neither a matching pathname nor caller-supplied physical metadata can substitute for the two opened-directory inspections. */
    public async capture(
        request: JointWorkspaceCaptureRequest,
        signal: AbortSignal,
    ): Promise<JointWorkspaceDescriptor> {
        if (this.#closed || this.commands.failed) {
            throw new Error('Joint workspace capture is closed');
        }
        if (this.#operations.size !== 0) {
            throw new Error('Joint workspace capture is already active');
        }
        const stopped: AbortSignal = AbortSignal.any([signal, this.#stop.signal]);
        stopped.throwIfAborted();
        const profile: unknown = JSON.parse(ExecutionJobsCodec.encode(request.executionProfile));
        const input: JointWorkspaceCaptureRequest = {
            revision: Boundary.integer(request.revision.toString()),
            fileRootId: Boundary.id(request.fileRootId),
            executionRootId: Boundary.id(request.executionRootId),
            fileJournalId: ConnectorEnrollmentCodec.digest(request.fileJournalId),
            executionJournals: JointWorkspaceCodec.journals(request.executionJournals),
            executionProfile: ExecutionJobsCodec.profile(profile),
        };
        if (
            input.revision === 0n ||
            input.executionProfile.policySha256 !== this.commands.policySha256 ||
            input.executionProfile.revision !== this.commands.definition.revision
        ) {
            throw new Error('Joint workspace command profile changed');
        }
        const joined: PromiseWithResolvers<undefined> = Promise.withResolvers<undefined>();
        this.#operations.add(joined.promise);
        try {
            return await this.filesystem.inspectWorkspace(
                input.fileRootId,
                async (file: WorkspaceInspection): Promise<JointWorkspaceDescriptor> =>
                    await this.commands.inspectWorkspace(
                        input.executionRootId,
                        async (
                            execution: WorkspaceInspection,
                        ): Promise<JointWorkspaceDescriptor> => {
                            const captures: readonly [
                                PromiseSettledResult<WorkspaceIdentityResult>,
                                PromiseSettledResult<WorkspaceIdentityResult>,
                            ] = await Promise.allSettled([
                                this.#inspector.inspect(file),
                                this.#inspector.inspect(execution),
                            ]);
                            stopped.throwIfAborted();
                            file.signal.throwIfAborted();
                            execution.signal.throwIfAborted();
                            const first: PromiseSettledResult<WorkspaceIdentityResult> =
                                captures[0];
                            const second: PromiseSettledResult<WorkspaceIdentityResult> =
                                captures[1];
                            if (
                                first.status !== 'fulfilled' ||
                                second.status !== 'fulfilled' ||
                                !first.value.ok ||
                                !second.value.ok
                            ) {
                                throw new Error('Joint workspace physical capture unavailable');
                            }
                            return JointWorkspaceAssembly.create(
                                this.key,
                                this.#scope,
                                input.revision,
                                {
                                    fileProfile: this.filesystem.profile,
                                    executionProfile: input.executionProfile,
                                    file: {
                                        rootId: input.fileRootId,
                                        access: file.access,
                                        identity: first.value.identity,
                                    },
                                    execution: {
                                        rootId: input.executionRootId,
                                        access: execution.access,
                                        identity: second.value.identity,
                                    },
                                    fileJournalId: input.fileJournalId,
                                    executionJournals: input.executionJournals,
                                },
                            );
                        },
                        stopped,
                    ),
                stopped,
            );
        } finally {
            this.#operations.delete(joined.promise);
            joined.resolve(undefined);
        }
    }

    /** Abort and join every native inspection before the installation can release borrowed roots or its signing key. */
    public async [Symbol.asyncDispose](): Promise<void> {
        this.#closed = true;
        this.#stop.abort();
        await Promise.allSettled([...this.#operations]);
        await this.#inspector[Symbol.asyncDispose]();
    }
}
