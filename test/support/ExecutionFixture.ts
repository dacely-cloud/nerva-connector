// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

import { ExecutionBootstrapInputKind } from '../../src/execution/ExecutionBootstrapInput.js';
import { constants } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import {
    mkdtemp,
    mkdir,
    writeFile,
    copyFile,
    open,
    rm,
    rmdir,
    readdir,
    readFile,
    type FileHandle,
} from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { ExecutionSandbox } from '../../src/execution/ExecutionSandbox.js';
import {
    ExecutionAppArmorProfile,
    ExecutionAppArmorMode,
} from '../../src/execution/ExecutionAppArmorProfile.js';
import { ExecutionAppArmorInstaller } from '../../src/execution/ExecutionAppArmorInstaller.js';
import type { ExecutionPolicy } from '../../src/execution/ExecutionPolicy.js';
import type { ExecutionEffectAdmission } from '../../src/execution/ExecutionEffectAdmission.js';
import type { ExecutionSandboxAdmission } from '../../src/execution/ExecutionSandboxAdmission.js';
import type { ExecutionCgroupIdentity } from '../../src/execution/ExecutionCgroupIdentity.js';
import { WorkspaceIdentityProcess } from '../../src/workspace/WorkspaceIdentityProcess.js';
import type {
    WorkspaceIdentity,
    WorkspaceIdentityResult,
} from '../../src/workspace/WorkspaceIdentity.js';
import { ConnectorFileMode } from 'nerva-connector-protocol/protocol/ConnectorFiles.js';
import { ExecutionPolicyCodec } from '../../src/execution/ExecutionPolicyCodec.js';
import type { ExecutionPolicyDefinition } from 'nerva-connector-protocol/execution/ExecutionPolicyTypes.js';
import {
    ExecutionWorkspaceAccess,
    type ExecutionResourceLimits,
} from 'nerva-connector-protocol/execution/ExecutionTypes.js';
import { type ExecutionBootstrap } from '../../src/execution/ExecutionBootstrap.js';

/** Only local test setup selects these existing parents and the finite prepared probe executable. */
export interface ExecutionFixtureOptions {
    readonly workspaceParent?: string;
    /** A unique private child of this exec-capable parent keeps runtime code separate from workspace mount flags. */
    readonly runtimeParent?: string;
    readonly delegationParent?: string;
    readonly probeFile?: string | null;
}

/** One captured capability pair is reused only while its original fixture descriptors remain owned. */
interface ExecutionFixtureCapture {
    readonly workspaceIdentity: WorkspaceIdentity;
    readonly delegationIdentity: ExecutionCgroupIdentity;
}
/** A test removes exactly the same explicit policy mode that it installed. */
interface ExecutionFixtureProfile {
    readonly definition: ExecutionPolicyDefinition;
    readonly mode: ExecutionAppArmorMode;
}

/** The owned test runtime includes only this probe, the trampoline's finite OS libraries and empty mount targets. */
export class ExecutionFixture implements AsyncDisposable {
    readonly #handles: Set<FileHandle>;
    readonly #capture: WorkspaceIdentityProcess = new WorkspaceIdentityProcess();
    readonly #workspace: FileHandle;
    readonly #helper: FileHandle;
    readonly #delegation: FileHandle;
    readonly #externalRuntime: string | null;
    #captured: Promise<ExecutionFixtureCapture> | null = null;
    /** The fixture owns a finite private start window, separate from each native command timeout. */
    public readonly admissionExpiresAtMs: bigint = BigInt(Date.now()) + 30000n;
    /** Native tests cannot silently refresh admission during a delayed capture. */
    public assertLaunch(): void {
        if (BigInt(Date.now()) >= this.admissionExpiresAtMs) {
            throw new Error('Fixture launch admission expired');
        }
    }

    #closed: boolean = false;
    #release: Promise<void> | null = null;
    #retainFiles: boolean | null = null;
    #sandboxJoined: boolean = false;
    #captureJoined: boolean = false;
    #groupRemoved: boolean = false;
    #released: boolean = false;
    readonly #profiles: Map<string, ExecutionFixtureProfile> = new Map();
    /** Namespace ownership prevents one simultaneous test from replacing or removing another test's MAC policy. */
    public readonly installationId: string = crypto.randomUUID().replaceAll('-', '');
    private constructor(
        public readonly directory: string,
        public readonly delegation: string,
        public readonly runtime: string,
        public readonly workspace: string,
        public readonly sandbox: ExecutionSandbox,
        handles: readonly FileHandle[],
        public readonly helperFile: string,
        workspaceCapability: FileHandle,
        helperDescriptor: FileHandle,
        delegationCapability: FileHandle,
        externalRuntime: string | null,
    ) {
        this.#handles = new Set(handles);
        this.#workspace = workspaceCapability;
        this.#helper = helperDescriptor;
        this.#delegation = delegationCapability;
        this.#externalRuntime = externalRuntime;
    }

    /** Neither a dependency tree nor a host root is cloned into the runtime; the cgroup subtree is exclusive to this fixture. */
    public static async create(
        helper: string,
        options: ExecutionFixtureOptions = {},
    ): Promise<ExecutionFixture> {
        const directory: string = await mkdtemp(
            join(options.workspaceParent ?? homedir(), '.nerva-exec-qualification-'),
        );
        const delegation: string = join(
            options.delegationParent ?? '/sys/fs/cgroup',
            'nerva-connector-qualification-' + crypto.randomUUID(),
        );
        let runtime: string = join(directory, 'runtime');
        let externalRuntime: string | null = null;
        const workspace: string = join(directory, 'workspace');
        const handles: FileHandle[] = [];
        let ownCgroup: boolean = false;
        try {
            if (options.runtimeParent !== undefined) {
                externalRuntime = await mkdtemp(
                    join(options.runtimeParent, '.nerva-exec-runtime-'),
                );
                runtime = join(externalRuntime, 'runtime');
            }
            await mkdir(delegation);
            ownCgroup = true;
            await writeFile(join(delegation, 'cgroup.subtree_control'), '+cpu +memory +pids');
            for (const path of [
                workspace,
                runtime,
                ...['usr/bin', 'workspace', 'proc', 'dev', 'tmp', 'nerva-limits'].map(
                    (name: string): string => join(runtime, name),
                ),
            ]) {
                await mkdir(path, { recursive: true, mode: 0o755 });
            }
            await writeFile(join(runtime, 'nerva-exec'), '', { mode: 0o600 });
            await writeFile(join(runtime, 'nerva-execution.json'), '', { mode: 0o600 });
            await writeFile(join(workspace, 'input'), 'safe', { mode: 0o600 });
            const canary: string = join(directory, 'host-private');
            await writeFile(canary, 'HOST_PRIVATE_CANARY', { mode: 0o600 });
            await writeFile(join(workspace, 'host-path'), canary, { mode: 0o600 });
            handles.push(await open(canary, constants.O_RDONLY | constants.O_NOFOLLOW));
            if (options.probeFile === undefined || options.probeFile === null) {
                await promisify(execFile)(
                    'cc',
                    [
                        '-O2',
                        '-static',
                        '-Wall',
                        '-Wextra',
                        '-Werror',
                        '-o',
                        join(runtime, 'usr/bin/probe'),
                        fileURLToPath(
                            new URL('../../native/test/execution_probe.c', import.meta.url),
                        ),
                    ],
                    { timeout: 10000, maxBuffer: 16384 },
                );
            } else {
                await copyFile(
                    options.probeFile,
                    join(runtime, 'usr/bin/probe'),
                    constants.COPYFILE_FICLONE,
                );
            }
            await copyFile(join(runtime, 'usr/bin/probe'), join(runtime, 'usr/bin/forbidden'));
            await this.#libraries(helper, runtime);
            for (const path of [
                helper,
                '/usr/bin/bwrap',
                runtime,
                workspace,
                join(runtime, 'usr/bin/probe'),
                delegation,
            ]) {
                handles.push(await open(path, constants.O_RDONLY | constants.O_NOFOLLOW));
            }
            const [
                ,
                trampoline,
                bubblewrap,
                runtimeHandle,
                workspaceHandle,
                program,
                delegationHandle,
            ]: readonly (FileHandle | undefined)[] = handles;
            if (
                trampoline === undefined ||
                bubblewrap === undefined ||
                runtimeHandle === undefined ||
                workspaceHandle === undefined ||
                program === undefined ||
                delegationHandle === undefined
            ) {
                throw new Error('Pinned execution capabilities required');
            }
            return new ExecutionFixture(
                directory,
                delegation,
                runtime,
                workspace,
                new ExecutionSandbox({
                    trampoline,
                    bubblewrap,
                    runtime: runtimeHandle,
                    workspace: workspaceHandle,
                    cgroupParent: delegationHandle,
                    executables: [{ path: '/usr/bin/probe', file: program }],
                }),
                handles,
                helper,
                workspaceHandle,
                trampoline,
                delegationHandle,
                externalRuntime,
            );
        } catch (caught: unknown) {
            const closed: readonly PromiseSettledResult<void>[] = await Promise.allSettled(
                handles.map((handle: FileHandle): Promise<void> => handle.close()),
            );
            if (
                closed.some(
                    (result: PromiseSettledResult<void>): boolean => result.status === 'rejected',
                )
            ) {
                throw new Error('Execution fixture setup descriptor release was not proven', {
                    cause: caught,
                });
            }
            if (ownCgroup) {
                await rmdir(delegation);
            }
            await rm(directory, { recursive: true, force: true });
            if (externalRuntime !== null) {
                await rm(externalRuntime, { recursive: true, force: true });
            }
            throw caught;
        }
    }

    /** Local sandbox tests commit no remote journal; their real capture owner outlives every admitted child. */
    public async admission(
        commit: (group: ExecutionCgroupIdentity) => Promise<void> = async (
            _group: ExecutionCgroupIdentity,
        ): Promise<void> => {},
    ): Promise<ExecutionSandboxAdmission> {
        if (this.#closed) {
            throw new Error('Execution fixture capture is closed');
        }
        this.#captured ??= this.#captureCapabilities();
        const captured: ExecutionFixtureCapture = await this.#captured;
        if (this.#closed) {
            throw new Error('Execution fixture capture closed before admission');
        }
        return {
            ...captured,
            capture: this.#capture,
            commit,
            expiresAtMs: this.admissionExpiresAtMs,
            assertLaunch: (): void => this.assertLaunch(),
        };
    }

    /** This trusted local policy test captures genuine authority but makes no remote durability claim. */
    public async policyAdmission(
        policy: ExecutionPolicy,
        rootId: string = 'project',
    ): Promise<ExecutionEffectAdmission> {
        return {
            context: await policy.effectContext(rootId),
            expiresAtMs: this.admissionExpiresAtMs,
            assertLaunch: (): void => this.assertLaunch(),
            commit: async (_group: ExecutionCgroupIdentity): Promise<void> => {},
        };
    }

    async #captureCapabilities(): Promise<ExecutionFixtureCapture> {
        const signal: AbortSignal = AbortSignal.timeout(3000);
        const [workspace, delegation]: readonly [WorkspaceIdentityResult, ExecutionCgroupIdentity] =
            await Promise.all([
                this.#capture.inspect({
                    descriptor: this.#workspace.fd,
                    helperDescriptor: this.#helper.fd,
                    access: ConnectorFileMode.ReadOnly,
                    signal,
                }),
                this.#capture.cgroup({
                    descriptor: this.#delegation.fd,
                    helperDescriptor: this.#helper.fd,
                    signal,
                }),
            ]);
        if (!workspace.ok) {
            throw new Error('Real execution fixture workspace capture failed');
        }
        return { workspaceIdentity: workspace.identity, delegationIdentity: delegation };
    }

    /** Real application binaries are deliberate temporary fixtures, with finite OS dependencies rather than installed package trees. */
    public async installProgram(source: string, path: string): Promise<void> {
        if (!/^\/usr\/bin\/[A-Za-z0-9_.-]+$/u.test(path)) {
            throw new Error('Explicit finite test program path required');
        }
        await copyFile(source, join(this.runtime, path), constants.COPYFILE_FICLONE);
        await ExecutionFixture.#libraries(source, this.runtime);
    }

    static async #libraries(source: string, runtime: string): Promise<void> {
        const libraries: Awaited<ReturnType<typeof execFile.__promisify__>> = await promisify(
            execFile,
        )('ldd', [source], { timeout: 5000, maxBuffer: 8192 });
        const paths: Set<string> = new Set(
            Array.from(
                libraries.stdout.toString().matchAll(/(?:=>\s+|^\s*)(\/[^\s]+)\s+\(/gmu),
                (match: RegExpExecArray): string => match[1] ?? '',
            ),
        );
        if (paths.size < 1 || paths.size > 8) {
            throw new Error('Explicit finite native OS runtime libraries required');
        }
        for (const path of paths) {
            if (!/^\/(?:usr\/)?lib(?:64)?\//u.test(path)) {
                throw new Error('Unsupported native runtime library');
            }
            const target: string = join(runtime, path);
            await mkdir(dirname(target), { recursive: true, mode: 0o755 });
            await copyFile(path, target, constants.COPYFILE_FICLONE);
        }
    }

    /** These are trusted local test grants; no remote request chooses runtime paths or kernel policy. */
    public async configuration(
        action: string,
        workspaceAccess: ExecutionWorkspaceAccess = ExecutionWorkspaceAccess.ReadOnly,
        mode: ExecutionAppArmorMode = ExecutionAppArmorMode.Foreground,
    ): Promise<ExecutionBootstrap> {
        const path: string = await this.policy(this.helperFile, workspaceAccess, mode);
        const raw: unknown = JSON.parse(await readFile(path, 'utf8'));
        const definition: ExecutionPolicyDefinition = ExecutionPolicyCodec.policy(raw);
        return {
            admissionExpiresAtMs: this.admissionExpiresAtMs,
            apparmorProfile: ExecutionAppArmorProfile.generate(definition, mode).name,
            program: '/usr/bin/probe',
            arguments: [action],
            input: { kind: ExecutionBootstrapInputKind.Fixed },
            allowedExecutables: ['/usr/bin/probe'],
            workspaceAccess,
            parentNamespaces: await ExecutionSandbox.namespaces(),
            maximumCpuSeconds: 3,
            maximumAddressBytes: 1073741824n,
            maximumFileBytes: 4096n,
        };
    }

    /** Every tested process tree has a real aggregate ceiling, regardless of UID or namespace-local root. */
    public readonly limits: ExecutionResourceLimits = {
        memoryBytes: 67108864n,
        maximumTasks: 8,
        cpuQuotaMicros: 50000,
    };

    /** A real protected local policy pins the same finite runtime and helper bytes used by the kernel probes. */
    public async policy(
        helper: string,
        access: ExecutionWorkspaceAccess,
        mode: ExecutionAppArmorMode = ExecutionAppArmorMode.Foreground,
    ): Promise<string> {
        const digest: (path: string) => Promise<string> = async (path: string): Promise<string> =>
            createHash('sha256')
                .update(await readFile(path))
                .digest('hex');
        const path: string = join(this.directory, 'execution-policy.json');
        await writeFile(
            path,
            JSON.stringify({
                installationId: this.installationId,
                revision: '1',
                trampolineFile: helper,
                trampolineSha256: await digest(helper),
                bubblewrapFile: '/usr/bin/bwrap',
                bubblewrapSha256: await digest('/usr/bin/bwrap'),
                runtimeDirectory: this.runtime,
                cgroupRoot: this.delegation,
                roots: [{ id: 'project', path: this.workspace, access }],
                programs: [
                    {
                        id: 'probe',
                        rootIds: ['project'],
                        path: '/usr/bin/probe',
                        sha256: await digest(join(this.runtime, 'usr/bin/probe')),
                        arguments: [{ kind: 'literal', value: access }],
                        children: [],
                    },
                ],
                resources: { ...this.limits, memoryBytes: this.limits.memoryBytes.toString() },
                timeoutMs: 5000,
                maximumAddressBytes: '1073741824',
                maximumFileBytes: '4096',
            }),
            { mode: 0o600 },
        );
        const raw: unknown = JSON.parse(await readFile(path, 'utf8'));
        await this.installProfile(ExecutionPolicyCodec.policy(raw), mode);
        return path;
    }

    /** Privileged setup is explicit and test-owned; the normal runner never installs profiles. */
    public async installProfile(
        definition: ExecutionPolicyDefinition,
        mode: ExecutionAppArmorMode = ExecutionAppArmorMode.Foreground,
    ): Promise<void> {
        const name: string = ExecutionAppArmorProfile.generate(definition, mode).name;
        if (!this.#profiles.has(name)) {
            await ExecutionAppArmorInstaller.install(definition, mode);
            this.#profiles.set(name, { definition, mode });
        }
    }

    /** Normal source tests prune their owned artifacts after exact kernel cleanup. */
    public async [Symbol.asyncDispose](): Promise<void> {
        await this.release(false);
    }

    /** Finite external qualification retains files for controller cleanup while joining all kernel owners and private descriptors. */
    public async release(retainFiles: boolean): Promise<void> {
        this.#retainFiles ??= retainFiles;
        this.#closed = true;
        if (this.#released) {
            return;
        }
        let task: Promise<void> | null = this.#release;
        if (task === null) {
            task = this.#releaseOwned();
            this.#release = task;
        }
        try {
            await task;
        } finally {
            if (this.#release === task) {
                this.#release = null;
            }
        }
    }

    async #releaseOwned(): Promise<void> {
        if (!this.#sandboxJoined) {
            await this.sandbox[Symbol.asyncDispose]();
            this.#sandboxJoined = true;
        }
        if (!this.#captureJoined) {
            await this.#capture[Symbol.asyncDispose]();
            this.#captureJoined = true;
        }
        if (!this.#groupRemoved) {
            const children: readonly string[] = await readdir(this.delegation);
            if (children.some((name: string): boolean => name.startsWith('exec-'))) {
                throw new Error('Execution fixture retained a live job cgroup');
            }
            for (const [name, profile] of this.#profiles) {
                await ExecutionAppArmorInstaller.remove(profile.definition, profile.mode);
                this.#profiles.delete(name);
            }
            await rmdir(this.delegation);
            this.#groupRemoved = true;
        }
        await Promise.allSettled(
            [...this.#handles].map(async (handle: FileHandle): Promise<void> => {
                await handle.close();
                this.#handles.delete(handle);
            }),
        );
        if (this.#handles.size !== 0) {
            throw new Error('Execution fixture descriptor release was not proven');
        }
        if (this.#retainFiles === false) {
            await rm(this.directory, { recursive: true, force: true });
            if (this.#externalRuntime !== null) {
                await rm(this.#externalRuntime, { recursive: true, force: true });
            }
        }
        this.#released = true;
    }
}
