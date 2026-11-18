// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

import { constants } from 'node:fs';
import { mkdir, open, readFile, writeFile, rmdir, statfs, type FileHandle } from 'node:fs/promises';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { ProtectedFiles } from '../local/ProtectedFiles.js';
import type { ExecutionResourceLimits } from 'nerva-connector-protocol/execution/ExecutionTypes.js';
import type { ExecutionCgroupIdentity } from './ExecutionCgroupIdentity.js';
import { ExecutionCgroupIdentityCodec } from './ExecutionCgroupIdentityCodec.js';
import type { ConnectorCapturedExecutionEffect } from '../runtime/ConnectorEffectContext.js';
import { ConnectorNativeExecutable } from '../runtime/ConnectorNativeExecutable.js';
import { WorkspaceIdentityProcess } from '../workspace/WorkspaceIdentityProcess.js';
import { ExecutionCgroupAllocationError } from './ExecutionCgroupAllocationError.js';
import { ExecutionCgroupReservation } from './ExecutionCgroupReservation.js';

/** Inspection borrows the current audited helper and shares its owner's bounded child process budget. */
export interface ExecutionCgroupInspection {
    readonly helper: FileHandle;
    readonly capture: WorkspaceIdentityProcess;
    readonly signal: AbortSignal;
}

/** Owns one newly created job cgroup under an operator-delegated root; never changes controllers or unrelated workloads. */
export class ExecutionCgroup implements AsyncDisposable {
    #killTask: Promise<boolean> | null = null;
    #attachment: Promise<boolean> | null = null;
    #disposal: Promise<void> | null = null;
    #stopping: boolean = false;
    #closed: boolean = false;
    #removed: boolean = false;
    #directoryClosed: boolean = false;
    #parentClosed: boolean = false;
    readonly #parent: FileHandle;
    readonly #name: string;
    #identity: ExecutionCgroupIdentity | null;
    private constructor(
        public readonly directory: FileHandle,
        parent: FileHandle,
        name: string,
        identity: ExecutionCgroupIdentity | null,
        public readonly inspection: ExecutionCgroupInspection,
    ) {
        this.#parent = parent;
        this.#name = name;
        this.#identity = identity;
    }

    /** A provisional empty allocation cannot authorize attachment or release until the native identity is captured. */
    public get identity(): ExecutionCgroupIdentity {
        if (this.#identity === null) {
            throw new Error('Original execution group identity is unconfirmed');
        }
        return this.#identity;
    }

    /** Only recovery of an already durable original dispatch may stop an existing group; no fresh job adopts it or executes again. */
    public static async recover(
        context: ConnectorCapturedExecutionEffect,
        id: string,
    ): Promise<void> {
        await using resources: AsyncDisposableStack = new AsyncDisposableStack();
        const helper: FileHandle = resources.use(
            await ConnectorNativeExecutable.open(
                context.cgroupHelperFile,
                context.cgroupHelperSha256,
            ),
        );
        const capture: WorkspaceIdentityProcess = resources.use(new WorkspaceIdentityProcess());
        const inspection: ExecutionCgroupInspection = {
            helper,
            capture,
            signal: new AbortController().signal,
        };
        const parent: FileHandle = await this.#openParent(context.cgroupRoot, id);
        const name: string = 'exec-' + id;
        let directory: FileHandle | null = null;
        try {
            await this.#match(parent, context.delegation, inspection);
            try {
                directory = await open(
                    '/proc/self/fd/' + parent.fd.toString() + '/' + name,
                    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
                );
            } catch (caught: unknown) {
                if (caught instanceof Error && 'code' in caught && caught.code === 'ENOENT') {
                    return;
                }
                throw caught;
            }
            if (context.group === null) {
                throw new Error('Original command group capture was not committed');
            }
            await this.#match(directory, context.group, inspection);
            const group: ExecutionCgroup = new ExecutionCgroup(
                directory,
                parent,
                name,
                context.group,
                inspection,
            );
            await group[Symbol.asyncDispose]();
        } finally {
            await directory?.close();
            await parent.close();
        }
    }

    /** An existing group is never adopted as a fresh execution or silently emptied. */
    public static async create(
        parentCapability: FileHandle,
        id: string,
        limits: ExecutionResourceLimits,
        delegation: ExecutionCgroupIdentity,
        inspection: ExecutionCgroupInspection,
    ): Promise<ExecutionCgroup> {
        if (
            limits.memoryBytes < 33554432n ||
            limits.memoryBytes > 1073741824n ||
            !Number.isSafeInteger(limits.maximumTasks) ||
            limits.maximumTasks < 2 ||
            limits.maximumTasks > 64 ||
            !Number.isSafeInteger(limits.cpuQuotaMicros) ||
            limits.cpuQuotaMicros < 1000 ||
            limits.cpuQuotaMicros > 100000
        ) {
            throw new Error('Invalid explicit execution cgroup delegation or limits');
        }
        if (!/^[a-f0-9]{64}$/u.test(id)) {
            throw new Error('Invalid original execution identity');
        }
        const parent: FileHandle = await open(
            '/proc/self/fd/' + parentCapability.fd.toString(),
            constants.O_RDONLY | constants.O_DIRECTORY,
        );
        const name: string = 'exec-' + id;
        const path: string = '/proc/self/fd/' + parent.fd.toString() + '/' + name;
        let created: boolean = false;
        let group: ExecutionCgroup | null = null;
        let directory: FileHandle | null = null;
        try {
            await this.#match(parent, delegation, inspection);
            await mkdir(path);
            created = true;
            directory = await open(
                path,
                constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
            );
            group = new ExecutionCgroup(directory, parent, name, null, inspection);
            const identity: ExecutionCgroupIdentity = await inspection.capture.cgroup({
                descriptor: directory.fd,
                helperDescriptor: inspection.helper.fd,
                signal: inspection.signal,
            });
            group.#identity = identity;
            for (const [file, value] of [
                ['memory.max', limits.memoryBytes.toString()],
                ['memory.swap.max', '0'],
                ['memory.oom.group', '1'],
                ['pids.max', limits.maximumTasks.toString()],
                ['cpu.max', limits.cpuQuotaMicros.toString() + ' 100000'],
            ]) {
                if (file === undefined || value === undefined) {
                    throw new Error('Incomplete execution control');
                }
                await writeFile(group.#path(file), value);
            }
            return group;
        } catch (caught: unknown) {
            if (group !== null) {
                try {
                    await group[Symbol.asyncDispose]();
                } catch {
                    throw new ExecutionCgroupAllocationError(group);
                }
            } else {
                try {
                    if (created) {
                        await rmdir(path);
                    }
                    await directory?.close();
                    await parent.close();
                } catch {
                    throw new ExecutionCgroupAllocationError(
                        new ExecutionCgroupReservation(parent, name),
                    );
                }
            }
            throw caught;
        }
    }

    /** The native bootstrap waits on stdin until this exact PID has joined the bounded group. */
    public async attach(pid: number): Promise<void> {
        if (
            this.#closed ||
            this.#identity === null ||
            this.#stopping ||
            this.#attachment !== null ||
            !Number.isSafeInteger(pid) ||
            pid <= 0
        ) {
            throw new Error('Invalid execution process attachment');
        }
        this.#attachment = this.#attach(pid);
        if (!(await this.#attachment)) {
            throw new Error('Execution process attachment failed');
        }
    }

    /** Killing is idempotent and its failure remains observable to the joined owner. */
    public async kill(): Promise<boolean> {
        if (this.#closed || this.#removed) {
            return true;
        }
        this.#stopping = true;
        this.#killTask ??= this.#kill();
        const task: Promise<boolean> = this.#killTask;
        try {
            return await task;
        } finally {
            if (this.#killTask === task) {
                this.#killTask = null;
            }
        }
    }

    /** Actual kernel emptiness is joined before the cgroup is removed or an admission slot can be released. */
    public async [Symbol.asyncDispose](): Promise<void> {
        this.#disposal ??= this.#dispose();
        try {
            await this.#disposal;
        } catch (caught: unknown) {
            this.#disposal = null;
            throw caught;
        }
    }

    async #dispose(): Promise<void> {
        if (this.#closed) {
            return;
        }
        if (!this.#removed) {
            if (!(await this.kill())) {
                throw new Error('Execution cgroup termination was not proven');
            }
            const deadline: number = performance.now() + 3000;
            while (true) {
                const events: string = await readFile(this.#path('cgroup.events'), 'utf8');
                if (events.length <= 256 && /^populated 0$/mu.test(events)) {
                    break;
                }
                if (performance.now() >= deadline) {
                    throw new Error('Execution descendants did not terminate');
                }
                await delay(20);
            }
            await rmdir('/proc/self/fd/' + this.#parent.fd.toString() + '/' + this.#name);
            this.#removed = true;
        }
        const outcomes: readonly [PromiseSettledResult<void>, PromiseSettledResult<void>] =
            await Promise.allSettled([
                this.#directoryClosed ? Promise.resolve() : this.directory.close(),
                this.#parentClosed ? Promise.resolve() : this.#parent.close(),
            ]);
        this.#directoryClosed ||= outcomes[0].status === 'fulfilled';
        this.#parentClosed ||= outcomes[1].status === 'fulfilled';
        if (!this.#directoryClosed || !this.#parentClosed) {
            throw new Error('Execution cgroup descriptor closure was not confirmed');
        }
        this.#closed = true;
    }

    static async #match(
        directory: FileHandle,
        expected: ExecutionCgroupIdentity,
        inspection: ExecutionCgroupInspection,
    ): Promise<void> {
        const actual: ExecutionCgroupIdentity = await inspection.capture.cgroup({
            descriptor: directory.fd,
            helperDescriptor: inspection.helper.fd,
            signal: inspection.signal,
        });
        if (!ExecutionCgroupIdentityCodec.same(actual, expected)) {
            throw new Error('Original physical command group changed');
        }
    }

    #path(name: string): string {
        return '/proc/self/fd/' + this.directory.fd.toString() + '/' + name;
    }
    static async #openParent(root: string, id: string): Promise<FileHandle> {
        if (
            resolve(root) !== root ||
            !root.startsWith('/sys/fs/cgroup/') ||
            !/^[a-f0-9]{64}$/u.test(id)
        ) {
            throw new Error('Invalid explicit execution cgroup identity');
        }
        await ProtectedFiles.directory(root);
        const parent: FileHandle = await open(
            root,
            constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
        );
        try {
            if (
                (await statfs('/proc/self/fd/' + parent.fd.toString(), { bigint: true })).type !==
                0x63677270n
            ) {
                throw new Error('Real cgroup v2 delegation required');
            }
            return parent;
        } catch (caught: unknown) {
            await parent.close();
            throw caught;
        }
    }
    async #kill(): Promise<boolean> {
        try {
            await this.#attachment;
            await writeFile(this.#path('cgroup.kill'), '1');
            return true;
        } catch {
            return false;
        }
    }
    async #attach(pid: number): Promise<boolean> {
        try {
            await writeFile(this.#path('cgroup.procs'), pid.toString());
            return true;
        } catch {
            return false;
        }
    }
}
