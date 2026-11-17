// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

import type { FileHandle } from 'node:fs/promises';
import { WorkspaceIdentityProcess } from '../workspace/WorkspaceIdentityProcess.js';
import type { WorkspaceIdentityResult } from '../workspace/WorkspaceIdentity.js';
import type { ConnectorFileRootCapability } from '../runtime/ConnectorFileRoots.js';
import { ConnectorFileMode } from 'nerva-connector-protocol/protocol/ConnectorFiles.js';
import {
    ConnectorEffectKind,
    type ConnectorCapturedExecutionEffect,
} from '../runtime/ConnectorEffectContext.js';
import { ConnectorEffectContextCodec } from '../runtime/ConnectorEffectContextCodec.js';
import type { ExecutionPolicyDefinition } from './ExecutionPolicyTypes.js';
import type { ExecutionCgroupIdentity } from './ExecutionCgroupIdentity.js';
import type { ExecutionEffectAdmission } from './ExecutionEffectAdmission.js';
import type { ExecutionSandboxAdmission } from './ExecutionSandboxAdmission.js';

/** One policy owner retains captures by actual capability object and shares a bounded inspector across its two lanes. */
export class ExecutionEffectCapture implements AsyncDisposable {
    readonly #capture: WorkspaceIdentityProcess = new WorkspaceIdentityProcess();
    readonly #stop: AbortController = new AbortController();
    readonly #pending: Map<ConnectorFileRootCapability, Promise<ConnectorCapturedExecutionEffect>> =
        new Map();
    readonly #tasks: Set<Promise<undefined>> = new Set();
    #delegation: Promise<ExecutionCgroupIdentity> | null = null;
    #closed: boolean = false;

    /** Directory and executable capabilities remain borrowed until this owner joins every inspection and effect caller. */
    public constructor(
        public readonly definition: ExecutionPolicyDefinition,
        public readonly policySha256: string,
        public readonly roots: ReadonlyMap<string, ConnectorFileRootCapability>,
        public readonly helper: FileHandle,
        public readonly cgroup: FileHandle,
    ) {}

    /** A failed capture remains failed for this capability; a recycled descriptor number never reuses another root's proof. */
    public async context(rootId: string): Promise<ConnectorCapturedExecutionEffect> {
        const root: ConnectorFileRootCapability | undefined = this.roots.get(rootId);
        if (this.#closed || root === undefined) {
            throw new Error('Original command workspace capture unavailable');
        }
        let pending: Promise<ConnectorCapturedExecutionEffect> | undefined =
            this.#pending.get(root);
        if (pending === undefined) {
            pending = this.#inspect(root, rootId);
            this.#pending.set(root, pending);
        }
        const context: ConnectorCapturedExecutionEffect = await pending;
        if (this.#closed) {
            throw new Error('Original command workspace owner closed');
        }
        return context;
    }

    /** Fresh execution must retain this exact original authority; only the group callback may refine it before launch. */
    public async admission(
        admission: ExecutionEffectAdmission,
    ): Promise<ExecutionSandboxAdmission> {
        admission.assertLaunch();
        const captured: ConnectorCapturedExecutionEffect = await this.context(
            admission.context.rootId,
        );
        admission.assertLaunch();
        const context: ConnectorCapturedExecutionEffect =
            admission.context.kind === ConnectorEffectKind.CapturedInteractiveExecution
                ? {
                      ...captured,
                      kind: ConnectorEffectKind.CapturedInteractiveExecution,
                      incarnation: admission.context.incarnation,
                  }
                : captured;
        if (
            ConnectorEffectContextCodec.encode(context) !==
            ConnectorEffectContextCodec.encode(admission.context)
        ) {
            throw new Error('Original command effect authority changed');
        }
        return {
            expiresAtMs: admission.expiresAtMs,
            assertLaunch: admission.assertLaunch,
            workspaceIdentity: context.root,
            delegationIdentity: context.delegation,
            capture: this.#capture,
            commit: admission.commit,
        };
    }

    async #inspect(
        root: ConnectorFileRootCapability,
        rootId: string,
    ): Promise<ConnectorCapturedExecutionEffect> {
        const finished: PromiseWithResolvers<undefined> = Promise.withResolvers<undefined>();
        this.#tasks.add(finished.promise);
        try {
            this.#delegation ??= this.#capture.cgroup({
                descriptor: this.cgroup.fd,
                helperDescriptor: this.helper.fd,
                signal: this.#stop.signal,
            });
            const delegation: ExecutionCgroupIdentity = await this.#delegation;
            const captured: WorkspaceIdentityResult = await this.#capture.inspect({
                descriptor: root.directory.fd,
                helperDescriptor: this.helper.fd,
                access: ConnectorFileMode.ReadOnly,
                signal: this.#stop.signal,
            });
            if (!captured.ok) {
                throw new Error('Original command workspace identity unavailable');
            }
            return Object.freeze({
                kind: ConnectorEffectKind.CapturedExecution,
                policySha256: this.policySha256,
                rootId,
                root: captured.identity,
                cgroupRoot: this.definition.cgroupRoot,
                cgroupHelperFile: this.definition.trampolineFile,
                cgroupHelperSha256: this.definition.trampolineSha256,
                delegation,
                group: null,
            });
        } finally {
            this.#tasks.delete(finished.promise);
            finished.resolve(undefined);
        }
    }

    /** Abort and join private inspector children before the policy releases their borrowed directory or executable descriptors. */
    public async [Symbol.asyncDispose](): Promise<void> {
        this.#closed = true;
        this.#stop.abort();
        await this.#capture[Symbol.asyncDispose]();
        await Promise.all(this.#tasks);
    }
}
