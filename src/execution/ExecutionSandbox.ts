// SPDX-FileCopyrightText: 2026 Dacely <business@dacely.com>
// SPDX-License-Identifier: LicenseRef-Proprietary

import { spawn, type ChildProcess } from 'node:child_process';
import { Duplex, type Stream } from 'node:stream';
import { ExecutionBootstrapLimits } from './ExecutionBootstrapLimits.js';
import { ExecutionBootstrapInputKind } from './ExecutionBootstrapInput.js';
import { ExecutionNativePipeFailure } from './ExecutionNativePipeProtocol.js';
import type { ExecutionNativePipeHandle } from './ExecutionNativePipeHandle.js';
import { readlink, type FileHandle } from 'node:fs/promises';
import { ExecutionCgroup } from './ExecutionCgroup.js';
import { ExecutionOutputCapture } from './ExecutionOutputCapture.js';
import type {
    ExecutionOutput,
    ExecutionOutputSink,
} from 'nerva-connector-protocol/execution/ExecutionOutput.js';
import type { ExecutionSandboxAdmission } from './ExecutionSandboxAdmission.js';
import type { WorkspaceIdentity } from '../workspace/WorkspaceIdentity.js';
import type { ExecutionCgroupIdentity } from './ExecutionCgroupIdentity.js';
import { ExecutionCgroupAllocationError } from './ExecutionCgroupAllocationError.js';
import {
    ExecutionTermination,
    ExecutionFailure,
    ExecutionSetupFailure,
    type ExecutionResourceLimits,
    type ExecutionResult,
} from 'nerva-connector-protocol/execution/ExecutionTypes.js';
import { type ExecutionBootstrap, type ExecutionNamespaces } from './ExecutionBootstrap.js';

/** Pinned runtime ELF content is mounted at the exact granted guest path; later host pathname replacement cannot substitute bytes. */
export interface ExecutionExecutable {
    readonly path: string;
    readonly file: FileHandle;
}

/** Descriptor numbers belong exclusively to the trusted local bootstrap and never to an external request. */
interface ExecutionDescriptor {
    readonly path: string;
    readonly descriptor: number;
}

/** Only this non-secret configuration is sealed into the isolated runtime. */
interface ExecutionNativeConfiguration extends ExecutionBootstrap {
    readonly executableDescriptors: readonly ExecutionDescriptor[];
}

/** Raw physical identities are consumed by the trusted outer helper and never enter the guest configuration. */
interface ExecutionLaunch {
    readonly configuration: ExecutionNativeConfiguration;
    readonly workspaceIdentity: WorkspaceIdentity;
    readonly cgroupIdentity: ExecutionCgroupIdentity;
}

/** All descriptors belong to the trusted local policy owner and outlive this runner; requests cannot supply paths or executable handles. */
export interface ExecutionCapabilities {
    readonly trampoline: FileHandle;
    readonly bubblewrap: FileHandle;
    readonly runtime: FileHandle;
    readonly workspace: FileHandle;
    readonly cgroupParent: FileHandle;
    readonly executables: readonly ExecutionExecutable[];
}

/** Active children retain their independently bounded descendant group until real close is observed. */
interface ExecutionChild {
    readonly process: ChildProcess;
    readonly cgroup: ExecutionCgroup;
}

/** This local execution engine is not a remote authorization API; a durable signed-operation owner must resolve and validate local policy before calling it. */
export class ExecutionSandbox implements AsyncDisposable {
    readonly #children: Set<ExecutionChild> = new Set();
    readonly #operations: Set<Promise<void>> = new Set();
    readonly #groups: Set<ExecutionCgroup> = new Set();
    readonly #allocations: Set<AsyncDisposable> = new Set();
    #reservations: number = 0;
    #closed: boolean = false;
    #failed: boolean = false;

    /** Only borrowed, verified capabilities are accepted; shutdown joins every descendant before their owner may close them. */
    public constructor(public readonly capabilities: ExecutionCapabilities) {}

    /** Capture the exact namespace identities that the native trampoline must independently prove it left. */
    public static async namespaces(): Promise<ExecutionNamespaces> {
        const paths: readonly string[] = ['mnt', 'user', 'pid', 'net', 'ipc', 'uts', 'cgroup'];
        const values: readonly string[] = await Promise.all(
            paths.map((name: string): Promise<string> => readlink('/proc/self/ns/' + name)),
        );
        const [mnt, user, pid, net, ipc, uts, cgroup]: readonly (string | undefined)[] = values;
        if (
            mnt === undefined ||
            user === undefined ||
            pid === undefined ||
            net === undefined ||
            ipc === undefined ||
            uts === undefined ||
            cgroup === undefined
        ) {
            throw new Error('Complete namespace identities required');
        }
        return { mnt, user, pid, net, ipc, uts, cgroup };
    }

    /** Never queues, falls back to ambient execution or retries an uncertain effect. */
    public async execute(
        id: string,
        configuration: ExecutionBootstrap,
        limits: ExecutionResourceLimits,
        timeoutMs: number,
        signal: AbortSignal,
        admission: ExecutionSandboxAdmission,
        output: ExecutionOutputSink | null = null,
        pipe: ExecutionNativePipeHandle | null = null,
    ): Promise<ExecutionResult> {
        try {
            return await this.#execute(
                id,
                configuration,
                limits,
                timeoutMs,
                signal,
                admission,
                output,
                pipe,
            );
        } finally {
            pipe?.close();
        }
    }

    async #execute(
        id: string,
        configuration: ExecutionBootstrap,
        limits: ExecutionResourceLimits,
        timeoutMs: number,
        signal: AbortSignal,
        admission: ExecutionSandboxAdmission,
        output: ExecutionOutputSink | null,
        pipe: ExecutionNativePipeHandle | null,
    ): Promise<ExecutionResult> {
        signal.throwIfAborted();
        admission.assertLaunch();
        if (configuration.admissionExpiresAtMs !== admission.expiresAtMs) {
            throw new Error('Native launch expiry changed its captured admission');
        }
        if (configuration.input.kind === ExecutionBootstrapInputKind.Pipe) {
            if (pipe === null) {
                throw new Error('Explicit native Pipe owner required');
            }
            pipe.assertBootstrap(
                configuration.input.incarnation,
                configuration.input.stdin,
                configuration.input.maximumInputBytes,
                configuration.input.maximumControls,
                configuration.input.executionDeadlineMs,
            );
        } else if (pipe !== null) {
            throw new Error('Native live input requires its distinct Pipe bootstrap');
        }
        if (
            this.#closed ||
            this.#failed ||
            this.#reservations >= 2 ||
            !Number.isSafeInteger(timeoutMs) ||
            timeoutMs < 100 ||
            timeoutMs > 30000
        ) {
            throw new Error('Execution sandbox admission unavailable');
        }
        const executableDescriptors: readonly ExecutionDescriptor[] =
            this.capabilities.executables.map(
                (entry: ExecutionExecutable, index: number): ExecutionDescriptor => ({
                    path: entry.path,
                    descriptor: (pipe === null ? 8 : 9) + index,
                }),
            );
        const nativeConfiguration: ExecutionNativeConfiguration = {
            ...configuration,
            executableDescriptors,
        };
        const inner: string = JSON.stringify(
            nativeConfiguration,
            (_key: string, value: unknown): unknown =>
                typeof value === 'bigint' ? value.toString() : value,
        );
        ExecutionBootstrapLimits.configuration(inner);
        this.#reservations++;
        const finished: PromiseWithResolvers<undefined> = Promise.withResolvers<undefined>();
        this.#operations.add(finished.promise);
        let verifiedCleanup: boolean = false;
        try {
            admission.assertLaunch();
            await using group: ExecutionCgroup = await ExecutionCgroup.create(
                this.capabilities.cgroupParent,
                id,
                limits,
                admission.delegationIdentity,
                {
                    helper: this.capabilities.trampoline,
                    capture: admission.capture,
                    signal,
                },
            );
            this.#groups.add(group);
            try {
                admission.assertLaunch();
                await admission.commit(group.identity);
                admission.assertLaunch();
                if (this.#closed || signal.aborted) {
                    throw new Error('Execution cancelled before launch');
                }
                const launch: ExecutionLaunch = {
                    configuration: nativeConfiguration,
                    workspaceIdentity: admission.workspaceIdentity,
                    cgroupIdentity: group.identity,
                };
                const payload: string = JSON.stringify(
                    launch,
                    (_key: string, value: unknown): unknown =>
                        typeof value === 'bigint' ? value.toString() : value,
                );
                ExecutionBootstrapLimits.launch(payload);
                return await this.#run(
                    group,
                    payload,
                    timeoutMs,
                    signal,
                    output,
                    pipe,
                    admission.assertLaunch,
                );
            } finally {
                await group[Symbol.asyncDispose]();
                this.#groups.delete(group);
                verifiedCleanup = true;
            }
        } catch (caught: unknown) {
            if (caught instanceof ExecutionCgroupAllocationError) {
                this.#allocations.add(caught.owner);
            }
            throw caught;
        } finally {
            if (verifiedCleanup) {
                this.#reservations--;
            } else {
                this.#failed = true;
            }
            this.#operations.delete(finished.promise);
            finished.resolve(undefined);
        }
    }

    /** Joined shutdown retains admission until actual child close and cgroup emptiness; borrowed descriptors remain owned by the caller. */
    public async [Symbol.asyncDispose](): Promise<void> {
        this.#closed = true;
        for (const child of this.#children) {
            child.process.kill('SIGKILL');
            void child.cgroup.kill();
        }
        await Promise.all(this.#operations);
        const groups: readonly ExecutionCgroup[] = [...this.#groups];
        const stopped: readonly PromiseSettledResult<void>[] = await Promise.allSettled(
            groups.map((group: ExecutionCgroup): Promise<void> => group[Symbol.asyncDispose]()),
        );
        for (let index: number = 0; index < groups.length; index++) {
            const group: ExecutionCgroup | undefined = groups[index];
            if (group !== undefined && stopped[index]?.status === 'fulfilled') {
                this.#groups.delete(group);
            }
        }
        for (const owner of this.#allocations) {
            try {
                await owner[Symbol.asyncDispose]();
                this.#allocations.delete(owner);
            } catch {
                continue;
            }
        }
        if (this.#groups.size !== 0 || this.#allocations.size !== 0) {
            throw new Error('Execution sandbox requires explicit failed-resource recovery');
        }
    }

    async #run(
        group: ExecutionCgroup,
        payload: string,
        timeoutMs: number,
        signal: AbortSignal,
        output: ExecutionOutputSink | null,
        pipe: ExecutionNativePipeHandle | null,
        assertLaunch: () => void,
    ): Promise<ExecutionResult> {
        assertLaunch();
        const child: ChildProcess = spawn('/proc/self/fd/3', ['--launch'], {
            env: { NERVA_CONNECTOR_PARENT_PID: process.pid.toString() },
            stdio: [
                'pipe',
                'pipe',
                'pipe',
                this.capabilities.trampoline.fd,
                this.capabilities.bubblewrap.fd,
                this.capabilities.runtime.fd,
                this.capabilities.workspace.fd,
                group.directory.fd,
                ...(pipe === null ? [] : ['pipe' as const]),
                ...this.capabilities.executables.map(
                    (entry: ExecutionExecutable): number => entry.file.fd,
                ),
            ],
        });
        const complete: PromiseWithResolvers<ExecutionResult> =
            Promise.withResolvers<ExecutionResult>();
        const record: ExecutionChild = { process: child, cgroup: group };
        this.#children.add(record);
        const stdout: Buffer[] = [];
        const stderr: Buffer[] = [];
        const prefix: Buffer = Buffer.from('NERVA_EXEC_READY\n');
        let prefixBytes: number = 0;
        let ready: boolean = false;
        let outputBytes: number = 0;
        let failure: ExecutionFailure | null = null;
        const stop: (reason: ExecutionFailure) => void = (reason: ExecutionFailure): void => {
            failure ??= reason;
            child.kill('SIGKILL');
            void group.kill();
        };
        const capture: ExecutionOutputCapture = new ExecutionOutputCapture(
            output,
            (): ExecutionOutput => ({
                stdoutBase64: ready ? Buffer.concat(stdout).toString('base64') : '',
                stderrBase64: ready ? Buffer.concat(stderr).toString('base64') : '',
            }),
            (): void => stop(ExecutionFailure.Sandbox),
        );
        const timer: NodeJS.Timeout = setTimeout(
            (): void => stop(ExecutionFailure.Timeout),
            timeoutMs,
        );
        const abort: () => void = (): void => stop(ExecutionFailure.Cancelled);
        signal.addEventListener('abort', abort, { once: true });
        if (signal.aborted) {
            abort();
        }
        child.once('error', (): void => stop(ExecutionFailure.Sandbox));
        child.stdin?.once('error', (): void => stop(ExecutionFailure.Sandbox));
        child.stdout?.on('data', (chunk: Buffer): void => {
            let offset: number = 0;
            while (pipe === null && !ready && offset < chunk.byteLength) {
                if (chunk[offset++] !== prefix[prefixBytes++]) {
                    stop(ExecutionFailure.Sandbox);
                    return;
                }
                ready = prefixBytes === prefix.byteLength;
            }
            const data: Buffer = chunk.subarray(offset);
            outputBytes += data.byteLength;
            if (outputBytes > 65536) {
                stop(ExecutionFailure.OutputLimit);
            } else if (data.byteLength > 0) {
                stdout.push(data);
            }
            if (ready) {
                capture.changed();
            }
        });
        child.stderr?.on('data', (chunk: Buffer): void => {
            outputBytes += chunk.byteLength;
            if (outputBytes > 65536) {
                stop(ExecutionFailure.OutputLimit);
            } else {
                stderr.push(chunk);
            }
            if (ready) {
                capture.changed();
            }
        });
        child.once('close', (code: number | null, processSignal: NodeJS.Signals | null): void => {
            this.#children.delete(record);
            const errorBytes: Buffer = Buffer.concat(stderr);
            const setupMessage: string = ready ? '' : errorBytes.toString('utf8');
            const observed: ExecutionFailure | null =
                failure ??
                (!ready || code === 125
                    ? ExecutionFailure.Sandbox
                    : processSignal !== null
                      ? ExecutionFailure.Signal
                      : code === null || code >= 128
                        ? ExecutionFailure.AmbiguousExit
                        : null);
            complete.resolve({
                setupFailure: ready
                    ? null
                    : (Object.values(ExecutionSetupFailure).find(
                          (stage: ExecutionSetupFailure): boolean =>
                              setupMessage === 'NERVA_EXEC_SETUP ' + stage + '\n',
                      ) ?? null),
                termination:
                    observed === null
                        ? ExecutionTermination.Exited
                        : ExecutionTermination.Indeterminate,
                failure: observed,
                exitCode: observed === null ? code : null,
                stdoutBase64: ready ? Buffer.concat(stdout).toString('base64') : '',
                stderrBase64: ready ? errorBytes.toString('base64') : '',
            });
        });
        if (pipe !== null) {
            const channel: Stream | null | undefined = child.stdio.at(8);
            if (!(channel instanceof Duplex)) {
                stop(ExecutionFailure.Sandbox);
            } else {
                pipe.attach(
                    channel,
                    (reason: ExecutionNativePipeFailure): void =>
                        stop(
                            reason === ExecutionNativePipeFailure.Timeout
                                ? ExecutionFailure.Timeout
                                : ExecutionFailure.Sandbox,
                        ),
                    (): void => {
                        ready = true;
                        capture.changed();
                    },
                );
            }
        }
        try {
            if (child.pid === undefined || child.stdin === null) {
                stop(ExecutionFailure.Sandbox);
            } else {
                await group.attach(child.pid);
                assertLaunch();
                if (failure === null) {
                    child.stdin.end(payload);
                }
            }
        } catch {
            stop(ExecutionFailure.Sandbox);
        }
        const result: ExecutionResult = await complete.promise;
        try {
            await group.kill();
            await capture.finish();
            return result;
        } finally {
            clearTimeout(timer);
            signal.removeEventListener('abort', abort);
        }
    }
}
