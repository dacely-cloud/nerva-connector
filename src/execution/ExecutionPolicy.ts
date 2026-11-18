// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

import { ExecutionInputCodec } from 'nerva-connector-protocol/execution/ExecutionInputCodec.js';
import {
    ExecutionInvocationResolution,
    type ExecutionResolvedInvocation,
} from './ExecutionResolvedInvocation.js';
import { constants } from 'node:fs';
import { open, type FileHandle } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { ProtectedFiles } from '../local/ProtectedFiles.js';
import { ConnectorNativeExecutable } from '../runtime/ConnectorNativeExecutable.js';
import {
    ConnectorFileRoots,
    type ConnectorFileRootCapability,
} from '../runtime/ConnectorFileRoots.js';
import {
    ConnectorFileMode,
    ConnectorFileLimits,
} from 'nerva-connector-protocol/protocol/ConnectorFiles.js';
import { ExecutionPolicyCodec } from './ExecutionPolicyCodec.js';
import type { ExecutionOutputSink } from 'nerva-connector-protocol/execution/ExecutionOutput.js';
import {
    ExecutionAppArmorProfile,
    ExecutionAppArmorMode,
    type ExecutionAppArmorDefinition,
} from './ExecutionAppArmorProfile.js';
import {
    ExecutionBootstrapInputKind,
    type ExecutionBootstrapInput,
} from './ExecutionBootstrapInput.js';
import { ConnectorEffectKind } from '../runtime/ConnectorEffectContext.js';
import type {
    ExecutionInteractiveNativeBinding,
    ExecutionInteractiveResolution,
} from './ExecutionInteractiveOwnershipTypes.js';
import { ExecutionInteractiveRuleCodec } from 'nerva-connector-protocol/execution/ExecutionInteractiveRuleCodec.js';
import { ExecutionSandbox, type ExecutionExecutable } from './ExecutionSandbox.js';
import {
    ExecutionWorkspaceAccess,
    type ExecutionResult,
} from 'nerva-connector-protocol/execution/ExecutionTypes.js';
import { type ExecutionBootstrap } from './ExecutionBootstrap.js';
import type { WorkspaceInspection } from '../workspace/WorkspaceInspection.js';
import type { ExecutionEffectAdmission } from './ExecutionEffectAdmission.js';
import type { ConnectorCapturedExecutionEffect } from '../runtime/ConnectorEffectContext.js';
import { ExecutionEffectCapture } from './ExecutionEffectCapture.js';
import type { ExecutionSandboxAdmission } from './ExecutionSandboxAdmission.js';
import type {
    ExecutionPolicyDefinition,
    ExecutionInvocation,
    ExecutionProgramPolicy,
    ExecutionRootPolicy,
    ExecutionBinaryPolicy,
} from 'nerva-connector-protocol/execution/ExecutionPolicyTypes.js';

interface ExecutionPolicySelection {
    readonly invocation: ExecutionInvocation;
    readonly program: ExecutionProgramPolicy;
    readonly root: ExecutionRootPolicy;
    readonly capability: ConnectorFileRootCapability;
    readonly resolved: ExecutionResolvedInvocation;
}

/** Current local-only authority pins every selected executable, directory and resource ceiling before accepting an invocation. */
export class ExecutionPolicy implements AsyncDisposable {
    readonly #running: Set<ExecutionSandbox> = new Set();
    readonly #operations: Set<Promise<void>> = new Set();
    readonly #inspections: Set<Promise<undefined>> = new Set();
    readonly #inspectionStop: AbortController = new AbortController();
    readonly #resources: AsyncDisposableStack;
    readonly #roots: ConnectorFileRoots;
    readonly #runtime: FileHandle;
    readonly #trampoline: FileHandle;
    readonly #bubblewrap: FileHandle;
    readonly #cgroup: FileHandle;
    readonly #effects: ExecutionEffectCapture;
    readonly #executables: ReadonlyMap<string, ExecutionExecutable>;
    readonly #sourceFile: string;
    readonly #protectedPaths: ReadonlySet<string>;
    #closed: boolean = false;
    #failed: boolean = false;

    /** Failed kernel cleanup closes admission; the caller must not publish a normal completed lifecycle. */
    public get failed(): boolean {
        return this.#failed;
    }
    private constructor(
        public readonly definition: ExecutionPolicyDefinition,
        public readonly policySha256: string,
        resources: AsyncDisposableStack,
        roots: ConnectorFileRoots,
        runtime: FileHandle,
        trampoline: FileHandle,
        bubblewrap: FileHandle,
        cgroup: FileHandle,
        executables: ReadonlyMap<string, ExecutionExecutable>,
        sourceFile: string,
        protectedPaths: readonly string[],
    ) {
        this.#resources = resources;
        this.#roots = roots;
        this.#runtime = runtime;
        this.#trampoline = trampoline;
        this.#bubblewrap = bubblewrap;
        this.#cgroup = cgroup;
        this.#effects = resources.use(
            new ExecutionEffectCapture(
                definition,
                policySha256,
                roots.capabilities,
                trampoline,
                cgroup,
            ),
        );
        this.#executables = executables;
        this.#sourceFile = sourceFile;
        this.#protectedPaths = new Set(protectedPaths);
    }

    /** No installer runs here. Unsupported kernels, missing delegation, mutable templates and missing grants fail explicitly. */
    public static async load(
        path: string,
        privatePaths: readonly string[],
    ): Promise<ExecutionPolicy> {
        const bytes: Buffer = await ProtectedFiles.readPrivate(path, 65536);
        const raw: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
        const definition: ExecutionPolicyDefinition = ExecutionPolicyCodec.policy(raw);
        const protectedPaths: readonly string[] = [
            path,
            ...privatePaths,
            definition.trampolineFile,
            definition.bubblewrapFile,
            definition.cgroupRoot,
        ];
        if (
            protectedPaths.some(
                (secret: string): boolean =>
                    secret === definition.runtimeDirectory ||
                    secret.startsWith(definition.runtimeDirectory + '/'),
            ) ||
            definition.roots.some(
                (root: ExecutionRootPolicy): boolean =>
                    root.path === definition.runtimeDirectory ||
                    root.path.startsWith(definition.runtimeDirectory + '/') ||
                    definition.runtimeDirectory.startsWith(root.path + '/'),
            )
        ) {
            throw new Error('Execution runtime overlaps workspace or protected authority');
        }
        const resources: AsyncDisposableStack = new AsyncDisposableStack();
        try {
            const roots: ConnectorFileRoots = resources.use(
                await ConnectorFileRoots.load(
                    definition.roots.map(
                        (root: ExecutionRootPolicy): Readonly<Record<string, string>> => ({
                            id: root.id,
                            path: root.path,
                        }),
                    ),
                    ConnectorFileMode.ReadOnly,
                    [...protectedPaths, definition.runtimeDirectory],
                ),
            );
            await ProtectedFiles.directory(definition.runtimeDirectory);
            await ProtectedFiles.directory(definition.cgroupRoot);
            const cgroup: FileHandle = resources.use(
                await open(
                    definition.cgroupRoot,
                    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
                ),
            );
            for (const target of ['workspace', 'proc', 'dev', 'tmp', 'nerva-limits']) {
                await ProtectedFiles.directory(resolve(definition.runtimeDirectory, target));
            }
            const runtime: FileHandle = resources.use(
                await open(
                    definition.runtimeDirectory,
                    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
                ),
            );
            const trampoline: FileHandle = resources.use(
                await ConnectorNativeExecutable.open(
                    definition.trampolineFile,
                    definition.trampolineSha256,
                ),
            );
            await ConnectorNativeExecutable.assertRunnable(trampoline);
            const bubblewrap: FileHandle = resources.use(
                await ConnectorNativeExecutable.open(
                    definition.bubblewrapFile,
                    definition.bubblewrapSha256,
                ),
            );
            await ConnectorNativeExecutable.assertRunnable(bubblewrap);
            const executables: Map<string, ExecutionExecutable> = new Map();
            const digests: Map<string, string> = new Map();
            for (const program of definition.programs) {
                const allowed: readonly ExecutionBinaryPolicy[] = [program, ...program.children];
                if (
                    new Set(allowed.map((binary: ExecutionBinaryPolicy): string => binary.path))
                        .size !== allowed.length
                ) {
                    throw new Error('Duplicate executable authority in program policy');
                }
                for (const binary of allowed) {
                    if (executables.has(binary.path)) {
                        if (digests.get(binary.path) !== binary.sha256) {
                            throw new Error('Conflicting executable digests');
                        }
                        continue;
                    }
                    const file: FileHandle = resources.use(
                        await ConnectorNativeExecutable.open(
                            resolve(definition.runtimeDirectory, '.' + binary.path),
                            binary.sha256,
                            268435456,
                        ),
                    );
                    await ConnectorNativeExecutable.assertRunnable(file);
                    executables.set(binary.path, { path: binary.path, file });
                    digests.set(binary.path, binary.sha256);
                }
            }
            return new ExecutionPolicy(
                definition,
                createHash('sha256').update(bytes).digest('hex'),
                resources,
                roots,
                runtime,
                trampoline,
                bubblewrap,
                cgroup,
                executables,
                path,
                [...protectedPaths, definition.runtimeDirectory],
            );
        } catch (caught: unknown) {
            await resources[Symbol.asyncDispose]();
            throw caught;
        }
    }

    /** Capture stays scoped to the live policy owner and its actual opened workspace and delegation. */
    public async effectContext(rootId: string): Promise<ConnectorCapturedExecutionEffect> {
        if (this.#closed || this.#failed) {
            throw new Error('Original command workspace capture unavailable');
        }
        const context: ConnectorCapturedExecutionEffect = await this.#effects.context(rootId);
        if (this.#closed || this.#failed) {
            throw new Error('Original command workspace owner closed');
        }
        return context;
    }

    /** Borrowers must use this live verified source and retain every required private-path exclusion. */
    public assertSource(sourceFile: string, protectedPaths: readonly string[]): void {
        if (
            this.#closed ||
            this.#failed ||
            sourceFile !== this.#sourceFile ||
            protectedPaths.some((path: string): boolean => !this.#protectedPaths.has(path))
        ) {
            throw new Error('Borrowed execution policy authority changed');
        }
    }

    /** The durable owner supplies original authority and commits the allocated group before any program is released; effects never retry. */
    public interactive(request: ExecutionInvocation): ExecutionInteractiveResolution | null {
        if (this.#closed || this.#failed || request.policySha256 !== this.policySha256) {
            throw new Error('Current execution policy resolution unavailable');
        }
        const program: ExecutionProgramPolicy | undefined = this.definition.programs.find(
            (entry: ExecutionProgramPolicy): boolean => entry.id === request.programId,
        );
        return program === undefined ||
            ExecutionInteractiveRuleCodec.placement(program.arguments) === null
            ? null
            : this.#selection(request).resolved.interactive;
    }

    #selection(request: ExecutionInvocation): ExecutionPolicySelection {
        if (this.#closed || this.#failed || request.policySha256 !== this.policySha256) {
            throw new Error('Current execution policy resolution unavailable');
        }
        const invocation: ExecutionInvocation = ExecutionInputCodec.invocation(request);
        const program: ExecutionProgramPolicy | undefined = this.definition.programs.find(
            (entry: ExecutionProgramPolicy): boolean => entry.id === invocation.programId,
        );
        const root: ExecutionRootPolicy | undefined = this.definition.roots.find(
            (entry: ExecutionRootPolicy): boolean => entry.id === invocation.rootId,
        );
        const capability: ConnectorFileRootCapability | undefined = this.#roots.capabilities.get(
            invocation.rootId,
        );
        if (
            program === undefined ||
            root === undefined ||
            capability === undefined ||
            !program.rootIds.includes(root.id)
        ) {
            throw new Error('Execution program or root was not granted');
        }
        return {
            invocation,
            program,
            root,
            capability,
            resolved: ExecutionInvocationResolution.capture(
                program,
                invocation,
                this.definition.timeoutMs,
            ),
        };
    }

    /** Native execution consumes exactly the previously prepared interactive owner when the explicit rule requires one. */
    public async execute(
        request: ExecutionInvocation,
        dispatchId: string,
        signal: AbortSignal,
        admission: ExecutionEffectAdmission,
        output: ExecutionOutputSink | null = null,
        interactive: ExecutionInteractiveNativeBinding | null = null,
    ): Promise<ExecutionResult> {
        if (
            this.#closed ||
            this.#failed ||
            this.#operations.size >= 2 ||
            request.policySha256 !== this.policySha256
        ) {
            throw new Error('Current execution policy admission unavailable');
        }
        admission.assertLaunch();
        const { invocation, program, root, capability, resolved }: ExecutionPolicySelection =
            this.#selection(request);
        if (
            (resolved.interactive === null) !== (interactive === null) ||
            (interactive === null
                ? admission.context.kind !== ConnectorEffectKind.CapturedExecution
                : admission.context.kind !== ConnectorEffectKind.CapturedInteractiveExecution ||
                  admission.context.incarnation !== interactive.incarnation)
        ) {
            throw new Error('Execution native input owner differs from captured effect authority');
        }
        if (
            admission.context.rootId !== invocation.rootId ||
            admission.context.policySha256 !== this.policySha256
        ) {
            throw new Error('Original command effect authority changed');
        }
        const selected: readonly ExecutionExecutable[] = [program, ...program.children].map(
            (binary: ExecutionBinaryPolicy): ExecutionExecutable => {
                const executable: ExecutionExecutable | undefined = this.#executables.get(
                    binary.path,
                );
                if (executable === undefined) {
                    throw new Error('Pinned executable authority is missing');
                }
                return executable;
            },
        );
        const finished: PromiseWithResolvers<undefined> = Promise.withResolvers<undefined>();
        this.#operations.add(finished.promise);
        const sandbox: ExecutionSandbox = new ExecutionSandbox({
            trampoline: this.#trampoline,
            bubblewrap: this.#bubblewrap,
            runtime: this.#runtime,
            workspace: capability.directory,
            cgroupParent: this.#cgroup,
            executables: selected,
        });
        this.#running.add(sandbox);
        try {
            await using lease: AsyncDisposableStack = new AsyncDisposableStack();
            lease.defer(async (): Promise<void> => await this.#stop(sandbox));
            const sandboxAdmission: ExecutionSandboxAdmission =
                await this.#effects.admission(admission);
            admission.assertLaunch();
            const profiles: ExecutionAppArmorDefinition = ExecutionAppArmorProfile.generate(
                this.definition,
                interactive === null
                    ? ExecutionAppArmorMode.Foreground
                    : ExecutionAppArmorMode.Pipe,
            );
            let input: ExecutionBootstrapInput = resolved.input;
            if (interactive !== null) {
                if (
                    resolved.interactive === null ||
                    profiles.guardianName === null ||
                    resolved.input.kind !== ExecutionBootstrapInputKind.Machine
                ) {
                    throw new Error('Explicit complete native Pipe resolution required');
                }
                input = Object.freeze({
                    ...resolved.input,
                    kind: ExecutionBootstrapInputKind.Pipe,
                    incarnation: interactive.incarnation,
                    guardianProfile: profiles.guardianName,
                    executionDeadlineMs: resolved.interactive.launch.executionDeadlineMs,
                    maximumInputBytes: resolved.interactive.rule.maximumInputBytes,
                    maximumControls: resolved.interactive.rule.maximumControls,
                });
            }
            const configuration: ExecutionBootstrap = {
                admissionExpiresAtMs: admission.expiresAtMs,
                apparmorProfile: profiles.name,
                program: resolved.program.path,
                arguments: resolved.arguments,
                input,
                allowedExecutables: selected.map(
                    (entry: ExecutionExecutable): string => entry.path,
                ),
                workspaceAccess: root.access,
                parentNamespaces: await ExecutionSandbox.namespaces(),
                maximumCpuSeconds: Math.ceil(resolved.timeoutMs / 1000),
                maximumAddressBytes: this.definition.maximumAddressBytes,
                maximumFileBytes: this.definition.maximumFileBytes,
            };
            admission.assertLaunch();
            if (this.#closed) {
                throw new Error('Execution policy closed before launch');
            }
            const task: Promise<ExecutionResult> = sandbox.execute(
                dispatchId,
                configuration,
                this.definition.resources,
                resolved.timeoutMs,
                signal,
                sandboxAdmission,
                output,
                interactive?.pipe ?? null,
            );
            const observed: Promise<readonly PromiseSettledResult<ExecutionResult>[]> =
                Promise.allSettled([task]);
            if (interactive !== null) {
                try {
                    await interactive.ready();
                } catch (caught: unknown) {
                    await sandbox[Symbol.asyncDispose]();
                    await observed;
                    throw caught;
                }
            }
            return await task;
        } finally {
            try {
                await interactive?.completed();
            } finally {
                this.#operations.delete(finished.promise);
                finished.resolve(undefined);
            }
        }
    }

    /** Local inspection captures the granted root's actual access and pins both borrowed descriptors through callback completion. */
    public async inspectWorkspace<T>(
        rootId: string,
        inspect: (root: WorkspaceInspection) => Promise<T>,
        signal: AbortSignal,
    ): Promise<T> {
        signal.throwIfAborted();
        const root: ExecutionRootPolicy | undefined = this.definition.roots.find(
            (entry: ExecutionRootPolicy): boolean => entry.id === rootId,
        );
        const capability: ConnectorFileRootCapability | undefined =
            this.#roots.capabilities.get(rootId);
        if (
            this.#closed ||
            this.#failed ||
            root === undefined ||
            capability === undefined ||
            this.#inspections.size >= ConnectorFileLimits.children
        ) {
            throw new Error('Local workspace inspection is unavailable');
        }
        const finished: PromiseWithResolvers<undefined> = Promise.withResolvers<undefined>();
        this.#inspections.add(finished.promise);
        const combined: AbortSignal = AbortSignal.any([signal, this.#inspectionStop.signal]);
        try {
            combined.throwIfAborted();
            const result: T = await inspect({
                descriptor: capability.directory.fd,
                helperDescriptor: this.#trampoline.fd,
                access:
                    root.access === ExecutionWorkspaceAccess.ReadOnly
                        ? ConnectorFileMode.ReadOnly
                        : ConnectorFileMode.ReadWrite,
                signal: combined,
            });
            combined.throwIfAborted();
            return result;
        } finally {
            this.#inspections.delete(finished.promise);
            finished.resolve(undefined);
        }
    }

    async #stop(sandbox: ExecutionSandbox): Promise<void> {
        try {
            await sandbox[Symbol.asyncDispose]();
            this.#running.delete(sandbox);
        } catch (caught: unknown) {
            this.#failed = true;
            throw caught;
        }
    }

    /** Caller shutdown joins every local execution before releasing the verified code and directory capabilities. */
    public async [Symbol.asyncDispose](): Promise<void> {
        this.#closed = true;
        this.#inspectionStop.abort();
        const stopped: readonly PromiseSettledResult<void>[] = await Promise.allSettled(
            this.#running
                .values()
                .map((sandbox: ExecutionSandbox): Promise<void> => sandbox[Symbol.asyncDispose]()),
        );
        await Promise.all(this.#operations);
        await Promise.all(this.#inspections);
        if (
            stopped.some(
                (result: PromiseSettledResult<void>): boolean => result.status === 'rejected',
            )
        ) {
            throw new Error('Execution policy still owns unverified resources');
        }
        await this.#resources[Symbol.asyncDispose]();
    }
}
