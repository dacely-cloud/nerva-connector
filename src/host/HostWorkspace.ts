// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

import { HostProgramWatch } from './HostProgramWatch.js';
import { randomUUID } from 'node:crypto';
import { stat, realpath } from 'node:fs/promises';
import { HostDesktop } from './HostDesktop.js';
import { HostOperationError } from './HostOperationError.js';
import { ConnectorHostErrorCode } from '../protocol/ConnectorHost.js';
import type { HostApplicationResult, HostDesktopFrame } from './HostApplication.js';
import { HostEnvironmentInspection } from './HostEnvironmentInspection.js';
import { HostEnvironmentValidation } from './HostEnvironmentValidation.js';
import type { HostEnvironmentReport, HostEnvironmentRequest } from './HostEnvironmentTypes.js';
import { HostHttpPool } from './HostHttpPool.js';
import type { HostHttpHead, HostHttpRead, HostHttpRequest } from './HostHttpTypes.js';
import type {
    HostDesktopInfo,
    HostDesktopScreenshot,
    HostDesktopPointerRequest,
    HostDesktopKeyRequest,
} from './HostDesktopTypes.js';
import { HostFileDigest } from './HostFileDigest.js';
import { HostFilesystem } from './HostFilesystem.js';
import { HostProcess } from './HostProcess.js';
import { HostPtyPool } from './HostPtyPool.js';
import type { HostReadObservationStart } from './HostReadObservationStart.js';
import {
    HostReadObservation,
    HostReadObservationKind,
    type HostReadObservationSource,
} from './HostReadObservation.js';
import { HostWorkspaceValidation } from './HostWorkspaceValidation.js';
import {
    HostOperation,
    HostWorkspaceLimits,
    type HostWorkspaceOptions,
    type HostWorkspaceAccess,
    type HostProcessRequest,
    type HostProcessSnapshot,
    type HostFileRead,
    type HostFileSnapshot,
    type HostFileDigestResult,
    type HostWriteMode,
    type HostFileMetadata,
    type HostDirectoryPage,
} from './HostWorkspaceTypes.js';

/** A pending process registers its exact owner before native launch admission can settle. */
interface HostProcessAdmission {
    owner: HostProcess | null;
    reserved: boolean;
}

/** Full-computer workspace owner keeps authorization, process lifetime and pending I/O under one explicit session. */
export class HostWorkspace implements AsyncDisposable {
    /** The terminal pool shares this workspace's authority, shutdown and native process admission budget. */
    public readonly terminals: HostPtyPool;
    /** This is the actual current workspace lifetime, never a last-known or response-selected native instance. */
    public get observationRuntimeId(): string {
        return this.#observations.runtimeId;
    }
    readonly #processes: Map<string, HostProcess> = new Map();
    readonly #http: HostHttpPool = new HostHttpPool();
    readonly #observations: HostReadObservation = new HostReadObservation();
    readonly #pending: Set<Promise<void>> = new Set();
    readonly #lateCleanupFailures: Map<HostProcess, Error> = new Map();
    readonly #options: HostWorkspaceOptions;
    #desktop: HostDesktop | null = null;
    #closed: boolean = false;
    #starting: number = 0;
    #digests: number = 0;
    readonly #operationsStop: AbortController = new AbortController();
    #disposal: Promise<void> | null = null;

    private constructor(
        options: HostWorkspaceOptions,
        public readonly directory: string,
    ) {
        this.#options = options;
        this.terminals = new HostPtyPool({
            directory,
            observations: this.#observations,
            ...(options.windowsLauncher === undefined
                ? {}
                : { windowsLauncher: options.windowsLauncher }),
            ended: (processId: string): void => this.#ended(processId),
            signal: this.#operationsStop.signal,
            owner: {
                run: <T>(access: HostWorkspaceAccess, action: () => Promise<T>): Promise<T> =>
                    this.#run(access, action),
                reserve: (): void => {
                    if (
                        this.#closed ||
                        this.#processes.size + this.#starting + this.terminals.size >=
                            HostWorkspaceLimits.processes
                    ) {
                        throw new Error('Host process limit reached; release completed processes');
                    }
                    this.#starting += 1;
                },
                releaseReservation: (): void => {
                    this.#starting -= 1;
                },
            },
        });
    }

    /** Construction validates the selected OS directory but grants no access by itself. */
    public static async create(options: HostWorkspaceOptions): Promise<HostWorkspace> {
        const directory: string = await realpath(
            HostWorkspaceValidation.directory(options.directory),
        );
        if (
            !(await stat(directory)).isDirectory() ||
            typeof options.authorization?.authorize !== 'function'
        ) {
            throw new Error(
                'Host workspace requires an existing directory and explicit authorization',
            );
        }
        if (options.windowsLauncher !== undefined) {
            HostWorkspaceValidation.directory(options.windowsLauncher);
        }
        return new HostWorkspace(options, directory);
    }

    /** Read-only PATH and variable presence uses this runtime's own environment without a subprocess. */
    public async inspectEnvironment(
        request: HostEnvironmentRequest,
        signal?: AbortSignal,
    ): Promise<HostEnvironmentReport> {
        const valid: HostEnvironmentRequest = HostEnvironmentValidation.request(
            request.programs,
            request.variables,
        );
        return await this.#run(
            {
                operation: HostOperation.EnvironmentInspect,
                path: null,
                destinationPath: null,
                processId: null,
            },
            (): Promise<HostEnvironmentReport> =>
                HostEnvironmentInspection.runtime().inspect(valid, this.#signal(signal)),
        );
    }

    /** Native DNS belongs to this authorized workspace rather than the controller resolver. */
    public resolveNetwork(hostname: string, signal?: AbortSignal): Promise<readonly string[]> {
        return this.#run(
            {
                operation: HostOperation.NetworkResolve,
                path: null,
                destinationPath: null,
                processId: null,
            },
            (): Promise<readonly string[]> => this.#http.resolve(hostname, this.#signal(signal)),
        );
    }

    /** A signed host operation opens a private pinned socket without redirect or proxy authority. */
    public openHttp(request: HostHttpRequest, signal?: AbortSignal): Promise<HostHttpHead> {
        return this.#run(
            {
                operation: HostOperation.HttpOpen,
                path: null,
                destinationPath: null,
                processId: null,
            },
            (): Promise<HostHttpHead> => this.#http.open(request, this.#signal(signal)),
        );
    }

    /** Sequential body pulls retain their exact transfer identity and bounded native backpressure. */
    public readHttp(transferId: string, offset: bigint, maximum: number): Promise<HostHttpRead> {
        return this.#run(
            {
                operation: HostOperation.HttpRead,
                path: null,
                destinationPath: null,
                processId: null,
                transferId,
            },
            (): Promise<HostHttpRead> =>
                Promise.resolve(this.#http.read(transferId, offset, maximum)),
        );
    }

    /** Cleanup must reauthorize the same transfer and join its actual connection lifetime. */
    public closeHttp(transferId: string): Promise<void> {
        return this.#run(
            {
                operation: HostOperation.HttpClose,
                path: null,
                destinationPath: null,
                processId: null,
                transferId,
            },
            (): Promise<void> => this.#http.close(transferId),
        );
    }

    /** Reads remain bounded even when the selected file is much larger than memory. */
    public async read(
        path: string,
        offset: bigint,
        maximum: number,
        snapshot?: HostFileSnapshot,
        signal?: AbortSignal,
    ): Promise<HostFileRead> {
        return await this.#file(
            HostOperation.Read,
            path,
            (absolute: string): Promise<HostFileRead> =>
                HostFilesystem.read(absolute, offset, maximum, snapshot, this.#signal(signal)),
        );
    }

    /** A complete-file digest uses one opened generation, finite runtime and bounded concurrent buffers. */
    public async digest(
        path: string,
        snapshot: HostFileSnapshot,
        signal?: AbortSignal,
    ): Promise<HostFileDigestResult> {
        return await this.#file(
            HostOperation.Digest,
            path,
            async (absolute: string): Promise<HostFileDigestResult> => {
                if (this.#digests >= HostWorkspaceLimits.digests) {
                    throw new Error('Host file digest limit reached');
                }
                this.#digests += 1;
                try {
                    return await HostFileDigest.read(absolute, snapshot, this.#signal(signal));
                } finally {
                    this.#digests -= 1;
                }
            },
        );
    }

    /** Every write independently rechecks current full-computer authority. */
    public async write(
        path: string,
        bytes: Buffer,
        mode: HostWriteMode,
        offset: bigint,
    ): Promise<bigint> {
        return await this.#file(HostOperation.Write, path, (absolute: string): Promise<bigint> =>
            HostFilesystem.write(absolute, bytes, mode, offset),
        );
    }

    /** Stat observes ordinary host metadata, including links. */
    public async stat(path: string, follow: boolean = false): Promise<HostFileMetadata> {
        return await this.#file(
            HostOperation.Stat,
            path,
            (absolute: string): Promise<HostFileMetadata> => HostFilesystem.stat(absolute, follow),
        );
    }

    /** Streaming listing returns a bounded page. */
    public async list(path: string, offset: number, maximum: number): Promise<HostDirectoryPage> {
        return await this.#file(
            HostOperation.List,
            path,
            (absolute: string): Promise<HostDirectoryPage> =>
                HostFilesystem.list(absolute, offset, maximum),
        );
    }

    /** Directory creation honors explicit recursive intent. */
    public async mkdir(path: string, recursive: boolean): Promise<void> {
        await this.#file(HostOperation.Mkdir, path, (absolute: string): Promise<void> =>
            HostFilesystem.mkdir(absolute, recursive),
        );
    }

    /** Removal may affect the whole granted host and requires the same current authority as execution. */
    public async remove(path: string, recursive: boolean): Promise<void> {
        await this.#file(HostOperation.Remove, path, (absolute: string): Promise<void> =>
            HostFilesystem.remove(absolute, recursive),
        );
    }

    /** Atomic no-clobber publication authorizes both paths and reports post-publication cleanup uncertainty explicitly. */
    public async publish(source: string, destination: string): Promise<void> {
        const absoluteSource: string = HostWorkspaceValidation.path(source, this.directory);
        const absoluteDestination: string = HostWorkspaceValidation.path(
            destination,
            this.directory,
        );
        await this.#run(
            {
                operation: HostOperation.Publish,
                path: absoluteSource,
                destinationPath: absoluteDestination,
                processId: null,
            },
            (): Promise<void> => HostFilesystem.publish(absoluteSource, absoluteDestination),
        );
    }

    /** Rename authorizes both absolute endpoints before requesting the OS-native atomic replacement operation. */
    public async rename(source: string, destination: string): Promise<void> {
        const absoluteSource: string = HostWorkspaceValidation.path(source, this.directory);
        const absoluteDestination: string = HostWorkspaceValidation.path(
            destination,
            this.directory,
        );
        await this.#run(
            {
                operation: HostOperation.Rename,
                path: absoluteSource,
                destinationPath: absoluteDestination,
                processId: null,
            },
            (): Promise<void> => HostFilesystem.rename(absoluteSource, absoluteDestination),
        );
    }

    /** Explicit POSIX mode changes never become an incomplete Windows ACL substitute. */
    public async chmod(path: string, mode: number): Promise<void> {
        await this.#file(HostOperation.Chmod, path, (absolute: string): Promise<void> =>
            HostFilesystem.chmod(absolute, mode),
        );
    }

    /** Observe actual interactive desktop availability under current host authority. */
    public async desktopInfo(): Promise<HostDesktopInfo> {
        return await this.#run(
            {
                operation: HostOperation.DesktopInfo,
                path: null,
                destinationPath: null,
                processId: null,
            },
            (): Promise<HostDesktopInfo> => this.#desktopOwner().info(),
        );
    }

    /** The current full-computer authority covers one installed application launch and its screen observation. */
    public async openApplication(name: string): Promise<HostApplicationResult> {
        if (
            typeof name !== 'string' ||
            name.trim().length === 0 ||
            name.length > 4096 ||
            /[\0\r\n]/u.test(name)
        ) {
            throw new HostOperationError(
                ConnectorHostErrorCode.InvalidRequest,
                'Invalid application name',
                true,
            );
        }
        return await this.#run(
            {
                operation: HostOperation.ApplicationOpen,
                path: null,
                destinationPath: null,
                processId: null,
            },
            (): Promise<HostApplicationResult> => this.#desktopOwner().openApplication(name),
        );
    }

    /** Capture under fresh native authorization, without using a path or writing a screenshot artifact. */
    public async desktopSnapshot(): Promise<HostDesktopFrame> {
        return await this.#run(
            {
                operation: HostOperation.DesktopSnapshot,
                path: null,
                destinationPath: null,
                processId: null,
            },
            (): Promise<HostDesktopFrame> => this.#desktopOwner().snapshot(),
        );
    }

    /** Capture an intentional PNG file; large images use existing chunked file retrieval. */
    public async desktopScreenshot(
        path: string,
        mode: HostWriteMode,
        maximumWidth: number = 1920,
        maximumHeight: number = 1080,
    ): Promise<HostDesktopScreenshot> {
        return await this.#file(
            HostOperation.Screenshot,
            path,
            (absolute: string): Promise<HostDesktopScreenshot> =>
                this.#desktopOwner().screenshot(absolute, mode, maximumWidth, maximumHeight),
        );
    }

    /** Pointer effects require an independently checked live full-computer grant. */
    public async desktopPointer(request: HostDesktopPointerRequest): Promise<void> {
        await this.#run(
            {
                operation: HostOperation.Pointer,
                path: null,
                destinationPath: null,
                processId: null,
            },
            (): Promise<void> => this.#desktopOwner().pointer(request),
        );
    }

    /** Key effects require an independently checked live full-computer grant. */
    public async desktopKey(request: HostDesktopKeyRequest): Promise<void> {
        await this.#run(
            { operation: HostOperation.Key, path: null, destinationPath: null, processId: null },
            (): Promise<void> => this.#desktopOwner().key(request),
        );
    }

    /** Text entry sends data to the actual foreground desktop application. */
    public async desktopText(text: string): Promise<void> {
        await this.#run(
            { operation: HostOperation.Text, path: null, destinationPath: null, processId: null },
            (): Promise<void> => this.#desktopOwner().text(text),
        );
    }

    /** Shells, desktop applications and MCP servers share the same owned command process API. */
    public async start(
        request: HostProcessRequest,
        maximum: number = HostWorkspaceLimits.chunkBytes,
        observation?: HostReadObservationStart,
    ): Promise<HostProcessSnapshot> {
        HostWorkspaceValidation.process(request);
        HostWorkspaceValidation.count(maximum, 1, HostWorkspaceLimits.chunkBytes);
        const directory: string = HostWorkspaceValidation.path(
            request.directory ?? this.directory,
            this.directory,
        );
        return await this.#run(
            {
                operation: HostOperation.Start,
                path: directory,
                destinationPath: null,
                processId: null,
            },
            async (): Promise<HostProcessSnapshot> => {
                if (
                    this.#processes.size + this.#starting + this.terminals.size >=
                    HostWorkspaceLimits.processes
                ) {
                    throw new Error('Host process limit reached; release completed processes');
                }
                const id: string = randomUUID();
                this.#starting += 1;
                const admission: HostProcessAdmission = { owner: null, reserved: true };
                try {
                    observation?.reserve(id);
                    const process: HostProcess = await HostProcess.create(
                        id,
                        request,
                        directory,
                        this.#options.windowsLauncher,
                        (expired: HostProcess): void => {
                            if (this.#processes.get(id) === expired) {
                                this.#processes.delete(id);
                            }
                            this.#lateCleanupFailures.delete(expired);
                        },
                        (created: HostProcess): void => {
                            admission.owner = created;
                            this.#processes.set(id, created);
                            if (admission.reserved) {
                                admission.reserved = false;
                                this.#starting -= 1;
                            }
                            observation?.created(
                                this.#observations.capture(
                                    id,
                                    HostReadObservationKind.Process,
                                    created.changes,
                                ),
                            );
                        },
                    );
                    if (this.#closed) {
                        this.#processes.set(id, process);
                        try {
                            await process[Symbol.asyncDispose]();
                        } catch (caught: unknown) {
                            this.#lateCleanupFailures.set(
                                process,
                                caught instanceof Error
                                    ? caught
                                    : new Error('Late process cleanup is unconfirmed', {
                                          cause: caught,
                                      }),
                            );
                            throw caught;
                        }
                        this.#processes.delete(id);
                        throw new Error('Host workspace closed before process admission');
                    }
                    this.#processes.set(id, process);
                    HostProgramWatch.watch(
                        process,
                        (processId: string): void => this.#ended(processId),
                        this.#operationsStop.signal,
                    );
                    return process.snapshot(0n, 0n, maximum);
                } catch (caught: unknown) {
                    const captured: HostProcess | null = admission.owner;
                    if (captured !== null && this.#processes.get(id) === captured) {
                        try {
                            await captured[Symbol.asyncDispose]();
                            this.#processes.delete(id);
                            this.#lateCleanupFailures.delete(captured);
                        } catch (cleanup: unknown) {
                            this.#lateCleanupFailures.set(
                                captured,
                                cleanup instanceof Error
                                    ? cleanup
                                    : new Error('Failed process launch cleanup is unconfirmed'),
                            );
                            throw new AggregateError(
                                [caught, cleanup],
                                'Failed process launch ownership was retained',
                                { cause: cleanup },
                            );
                        }
                    }
                    throw caught;
                } finally {
                    if (admission.reserved) {
                        this.#starting -= 1;
                    }
                }
            },
        );
    }

    /** Retained output survives initial command exit until explicit release. */
    public async output(
        processId: string,
        stdoutOffset: bigint,
        stderrOffset: bigint,
        maximum: number,
    ): Promise<HostProcessSnapshot> {
        return await this.#process(
            HostOperation.Output,
            processId,
            (process: HostProcess): Promise<HostProcessSnapshot> =>
                Promise.resolve(process.snapshot(stdoutOffset, stderrOffset, maximum)),
        );
    }

    /** Piped binary input supports persistent command and stdio MCP sessions. */
    public async input(processId: string, bytes: Buffer, end: boolean): Promise<void> {
        await this.#process(HostOperation.Input, processId, (process: HostProcess): Promise<void> =>
            process.input(bytes, end),
        );
    }

    /** Capture only the exact authorized retained process; hints never substitute for a freshly authorized byte read or signed delivery. */
    public async observe(processId: string): Promise<HostReadObservationSource> {
        return await this.#process(
            HostOperation.Output,
            processId,
            (owner: HostProcess): Promise<HostReadObservationSource> =>
                Promise.resolve(
                    this.#observations.capture(
                        processId,
                        HostReadObservationKind.Process,
                        owner.changes,
                    ),
                ),
        );
    }

    /** Stop joins owned processes before returning. */
    public async stop(processId: string): Promise<void> {
        await this.#process(HostOperation.Stop, processId, (process: HostProcess): Promise<void> =>
            process.stop(),
        );
    }

    /** Release stops the process and removes its retained buffers; IDs are never reused. */
    public async release(processId: string): Promise<void> {
        await this.#process(
            HostOperation.Release,
            processId,
            async (process: HostProcess): Promise<void> => {
                await process[Symbol.asyncDispose]();
                this.#processes.delete(processId);
            },
        );
    }

    /** Closing rejects new work, joins admitted operations, then releases every owned process. */
    public async [Symbol.asyncDispose](): Promise<void> {
        const disposal: Promise<void> = this.#disposal ?? this.#dispose();
        this.#disposal = disposal;
        try {
            await disposal;
        } catch (caught: unknown) {
            if (this.#disposal === disposal) {
                this.#disposal = null;
            }
            throw caught;
        }
    }

    #signal(signal: AbortSignal | undefined): AbortSignal {
        return signal === undefined
            ? this.#operationsStop.signal
            : AbortSignal.any([signal, this.#operationsStop.signal]);
    }

    #desktopOwner(): HostDesktop {
        this.#desktop ??= new HostDesktop({
            windowsLauncher: this.#options.windowsLauncher,
            environment: this.#options.desktopEnvironment,
        });
        return this.#desktop;
    }

    async #file<T>(
        operation: HostOperation,
        path: string,
        action: (absolute: string) => Promise<T>,
    ): Promise<T> {
        const absolute: string = HostWorkspaceValidation.path(path, this.directory);
        return await this.#run(
            { operation, path: absolute, destinationPath: null, processId: null },
            (): Promise<T> => action(absolute),
        );
    }

    async #process<T>(
        operation: HostOperation,
        processId: string,
        action: (process: HostProcess) => Promise<T>,
    ): Promise<T> {
        if (typeof processId !== 'string' || processId.length > 128) {
            throw new Error('Invalid host process identifier');
        }
        return await this.#run(
            { operation, path: null, destinationPath: null, processId },
            (): Promise<T> => {
                const process: HostProcess | undefined = this.#processes.get(processId);
                if (process === undefined) {
                    throw new Error('Host process is unavailable');
                }
                return action(process);
            },
        );
    }

    async #run<T>(access: HostWorkspaceAccess, action: () => Promise<T>): Promise<T> {
        if (this.#closed || this.#pending.size >= HostWorkspaceLimits.operations) {
            throw new Error('Host workspace is closed or busy');
        }
        const pending: PromiseWithResolvers<undefined> = Promise.withResolvers<undefined>();
        this.#pending.add(pending.promise);
        try {
            await this.#options.authorization.authorize(access);
            if (this.#closed) {
                throw new Error('Host workspace closed before operation admission');
            }
            return await action();
        } finally {
            pending.resolve(undefined);
            this.#pending.delete(pending.promise);
        }
    }

    /**
     * Closure revokes metadata, closes terminal admission and captures every current owner in the same synchronous step.
     *
     * @remarks
     * Observation revocation is synchronous; its metadata-waiter join runs beside native cleanup and never delays
     * the terminal pool's initial sweep, so an admitted startup cannot register into a pool that a closed workspace
     * still reports open. Owners registered after that sweep are joined once every admitted operation has settled.
     */
    /** Reports a program's end to the owner; a failing observer never affects the program. */
    #ended(processId: string): void {
        try {
            this.#options.ended?.(processId);
        } catch {
            /** The observer only feeds the connector screen. */
            return;
        }
    }

    async #dispose(): Promise<void> {
        this.#closed = true;
        this.#lateCleanupFailures.clear();
        this.#operationsStop.abort(new Error('Host workspace closed'));
        const observations: Promise<readonly PromiseSettledResult<void>[]> = Promise.allSettled([
            this.#observations[Symbol.asyncDispose](),
        ]);
        const terminals: Promise<readonly PromiseSettledResult<void>[]> = Promise.allSettled([
            this.terminals[Symbol.asyncDispose](),
        ]);
        const desktop: Promise<readonly PromiseSettledResult<void>[]> = Promise.allSettled([
            this.#desktop?.[Symbol.asyncDispose]() ?? Promise.resolve(),
        ]);
        const http: Promise<readonly PromiseSettledResult<void>[]> = Promise.allSettled([
            this.#http[Symbol.asyncDispose](),
        ]);
        const captured: ReadonlySet<HostProcess> = new Set(this.#processes.values());
        const outcomes: readonly PromiseSettledResult<void>[] =
            await this.#releaseProcesses(captured);
        await Promise.all(this.#pending);
        const lateTerminals: readonly PromiseSettledResult<void>[] = await Promise.allSettled([
            this.terminals[Symbol.asyncDispose](),
        ]);
        const late: readonly HostProcess[] = Array.from(this.#processes.values()).filter(
            (process: HostProcess): boolean =>
                !captured.has(process) && !this.#lateCleanupFailures.has(process),
        );
        const lateOutcomes: readonly PromiseSettledResult<void>[] =
            await this.#releaseProcesses(late);
        const errors: readonly unknown[] = [
            ...outcomes,
            ...lateOutcomes,
            ...(await observations),
            ...(await desktop),
            ...(await http),
            ...(await terminals),
            ...lateTerminals,
        ]
            .filter(
                (outcome: PromiseSettledResult<void>): outcome is PromiseRejectedResult =>
                    outcome.status === 'rejected',
            )
            .map((outcome: PromiseRejectedResult): unknown => outcome.reason);
        const failures: readonly Error[] = Array.from(this.#lateCleanupFailures.values());
        if (errors.length !== 0 || failures.length !== 0) {
            throw new AggregateError(
                [...errors, ...failures],
                'Host processes could not all be released',
            );
        }
    }

    async #releaseProcesses(
        processes: Iterable<HostProcess>,
    ): Promise<readonly PromiseSettledResult<void>[]> {
        return await Promise.allSettled(
            Array.from(processes, async (process: HostProcess): Promise<void> => {
                await process[Symbol.asyncDispose]();
                if (this.#processes.get(process.id) === process) {
                    this.#processes.delete(process.id);
                }
                this.#lateCleanupFailures.delete(process);
            }),
        );
    }
}
