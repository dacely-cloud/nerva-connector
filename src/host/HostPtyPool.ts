// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

import { HostProgramWatch } from './HostProgramWatch.js';
import { randomUUID } from 'node:crypto';
import { HostTerminal } from './HostTerminal.js';
import type { HostReadObservationStart } from './HostReadObservationStart.js';
import {
    HostReadObservation,
    HostReadObservationKind,
    type HostReadObservationSource,
} from './HostReadObservation.js';
import type { HostTerminalRequest, HostTerminalSnapshot } from './HostTerminalTypes.js';
import {
    HostOperation,
    HostWorkspaceLimits,
    type HostWorkspaceAccess,
} from './HostWorkspaceTypes.js';
import { HostWorkspaceValidation } from './HostWorkspaceValidation.js';
import { HostOperationError } from './HostOperationError.js';
import { ConnectorHostErrorCode } from '../protocol/ConnectorHost.js';

/** The workspace retains authorization, shared operation admission and the combined native process budget. */
export interface HostPtyPoolOwner {
    /** Authorize and join this operation under the same workspace lifetime as ordinary files and processes. */
    run<T>(access: HostWorkspaceAccess, action: () => Promise<T>): Promise<T>;
    /** Reserve one startup against the workspace's combined process and terminal capacity. */
    reserve(): void;
    /** A startup reservation ends when its exact native owner enters the retained map, or construction fails. */
    releaseReservation(): void;
}

/** Trusted local options never come from a terminal tool's JSON arguments. */
export interface HostPtyPoolOptions {
    readonly directory: string;
    readonly observations: HostReadObservation;
    readonly windowsLauncher?: string;
    readonly owner: HostPtyPoolOwner;
    /** Called once with a terminal's ID when it ends, is released or the workspace closes. */
    readonly ended: (processId: string) => void;
    /** Aborted when the owning workspace closes. */
    readonly signal: AbortSignal;
}

/** Real terminals own separate byte streams and never masquerade as stdio pipes or managed native ownership. */
export class HostPtyPool implements AsyncDisposable {
    readonly #entries: Map<string, HostTerminal> = new Map();
    #closed: boolean = false;
    #availability: Promise<boolean> | null = null;
    #supported: boolean = false;

    /** The parent workspace owns this pool and supplies every operation-boundary authorization. */
    public constructor(public readonly options: HostPtyPoolOptions) {}

    /** Retained and uncertain owners both consume a shared native process cell. */
    public get size(): number {
        return this.#entries.size;
    }

    /** Tool discovery uses only completed native capability evidence. */
    public get supported(): boolean {
        return this.#supported && !this.#closed;
    }

    /** Capability is probed once per live local workspace, never inferred from an operating-system label. */
    public async available(): Promise<boolean> {
        if (this.#closed) {
            return false;
        }
        const pending: Promise<boolean> = (this.#availability ??= this.options.owner.run(
            {
                operation: HostOperation.Start,
                path: this.options.directory,
                destinationPath: null,
                processId: null,
            },
            async (): Promise<boolean> => {
                this.#supported = await HostTerminal.available(this.options.windowsLauncher);
                return this.#supported;
            },
        ));
        try {
            return await pending;
        } catch (error: unknown) {
            if (this.#availability === pending) {
                this.#availability = null;
            }
            throw error;
        }
    }

    /** A bounded terminal launch remains visible even if startup or late cleanup becomes unconfirmed. */
    public async start(
        request: HostTerminalRequest,
        maximum: number = HostWorkspaceLimits.chunkBytes,
        observation?: HostReadObservationStart,
    ): Promise<HostTerminalSnapshot> {
        try {
            HostWorkspaceValidation.process(request);
            HostWorkspaceValidation.count(request.cols, 2, 500);
            HostWorkspaceValidation.count(request.rows, 1, 200);
            HostWorkspaceValidation.count(maximum, 1, HostWorkspaceLimits.chunkBytes);
        } catch (error: unknown) {
            throw new HostOperationError(
                ConnectorHostErrorCode.InvalidRequest,
                'Invalid native terminal launch',
                true,
                { cause: error },
            );
        }
        const directory: string = HostWorkspaceValidation.path(
            request.directory ?? this.options.directory,
            this.options.directory,
        );
        if (!(await this.available())) {
            throw new HostOperationError(
                ConnectorHostErrorCode.Unsupported,
                'Native host terminal support is unavailable',
                true,
            );
        }
        return await this.options.owner.run(
            {
                operation: HostOperation.Start,
                path: directory,
                destinationPath: null,
                processId: null,
            },
            async (): Promise<HostTerminalSnapshot> => {
                if (this.#closed) {
                    throw new Error('Host terminal owner is closed');
                }
                this.options.owner.reserve();
                let reserved: boolean = true;
                let created: HostTerminal | null = null;
                const id: string = randomUUID();
                try {
                    observation?.reserve(id);
                    const terminal: HostTerminal = await HostTerminal.create(
                        id,
                        request,
                        directory,
                        this.options.windowsLauncher,
                        (expired: HostTerminal): void => this.#forget(expired),
                        (owner: HostTerminal): void => {
                            created = owner;
                            this.#entries.set(id, owner);
                            reserved = false;
                            this.options.owner.releaseReservation();
                            observation?.created(
                                this.options.observations.capture(
                                    id,
                                    HostReadObservationKind.Terminal,
                                    owner.changes,
                                ),
                            );
                        },
                    );
                    if (this.#closed) {
                        throw new Error('Host workspace closed before terminal admission');
                    }
                    HostProgramWatch.watch(terminal, this.options.ended, this.options.signal);
                    return terminal.snapshot(0n, maximum);
                } catch (error: unknown) {
                    const owner: HostTerminal | undefined = created ?? this.#entries.get(id);
                    if (owner !== undefined && owner !== null) {
                        try {
                            await owner[Symbol.asyncDispose]();
                            this.#forget(owner);
                        } catch (cleanup: unknown) {
                            throw new AggregateError(
                                [error, cleanup],
                                'Terminal startup and owned cleanup are unconfirmed',
                                { cause: cleanup },
                            );
                        }
                    }
                    throw error;
                } finally {
                    if (reserved) {
                        this.options.owner.releaseReservation();
                    }
                }
            },
        );
    }

    /** Reads expose exact offsets and any bytes overwritten by the bounded output ring. */
    public async output(
        processId: string,
        offset: bigint,
        maximum: number,
    ): Promise<HostTerminalSnapshot> {
        return await this.#run(
            HostOperation.Output,
            processId,
            (terminal: HostTerminal): Promise<HostTerminalSnapshot> =>
                Promise.resolve(terminal.snapshot(offset, maximum)),
        );
    }

    /** Terminal input is exact bytes; Ctrl-D remains data and never becomes pipe EOF. */
    public async input(processId: string, bytes: Buffer): Promise<void> {
        if (bytes.byteLength > HostWorkspaceLimits.chunkBytes) {
            throw new Error('Terminal input exceeds its chunk bound');
        }
        await this.#run(HostOperation.Input, processId, (terminal: HostTerminal): Promise<void> =>
            terminal.input(bytes),
        );
    }

    /** Metadata captures an exact authorized terminal owner, not a guessed process-family or latest connection. */
    public async observe(processId: string): Promise<HostReadObservationSource> {
        return await this.#run(
            HostOperation.Output,
            processId,
            (owner: HostTerminal): Promise<HostReadObservationSource> =>
                Promise.resolve(
                    this.options.observations.capture(
                        processId,
                        HostReadObservationKind.Terminal,
                        owner.changes,
                    ),
                ),
        );
    }

    /** Native resize changes the real terminal rather than injecting shell commands. */
    public async resize(processId: string, cols: number, rows: number): Promise<void> {
        try {
            HostWorkspaceValidation.count(cols, 2, 500);
            HostWorkspaceValidation.count(rows, 1, 200);
        } catch (error: unknown) {
            throw new HostOperationError(
                ConnectorHostErrorCode.InvalidRequest,
                'Invalid native terminal geometry',
                true,
                { cause: error },
            );
        }
        await this.#run(HostOperation.Input, processId, (terminal: HostTerminal): Promise<void> =>
            terminal.resize(cols, rows),
        );
    }

    /** A stop preserves output and never turns unknown cleanup into successful completion. */
    public async stop(processId: string): Promise<void> {
        await this.#run(HostOperation.Stop, processId, (terminal: HostTerminal): Promise<void> =>
            terminal.stop(),
        );
    }

    /** Explicit release removes a cell only after its exact native owner finishes disposal. */
    public async release(processId: string): Promise<void> {
        await this.#run(
            HostOperation.Release,
            processId,
            async (terminal: HostTerminal): Promise<void> => {
                await terminal[Symbol.asyncDispose]();
                this.#forget(terminal);
            },
        );
    }

    /** Workspace shutdown stops new admission, joins every current owner and retains uncertain cells for retry. */
    public async [Symbol.asyncDispose](): Promise<void> {
        this.#closed = true;
        for (const terminal of this.#entries.values()) {
            terminal.changes[Symbol.dispose]();
        }
        const outcomes: readonly PromiseSettledResult<void>[] = await Promise.allSettled(
            Array.from(this.#entries.values(), async (terminal: HostTerminal): Promise<void> => {
                await terminal[Symbol.asyncDispose]();
                this.#forget(terminal);
            }),
        );
        const failed: readonly PromiseRejectedResult[] = outcomes.filter(
            (outcome: PromiseSettledResult<void>): outcome is PromiseRejectedResult =>
                outcome.status === 'rejected',
        );
        if (failed.length !== 0) {
            throw new AggregateError(
                failed.map((outcome: PromiseRejectedResult): unknown => outcome.reason),
                'Host terminals could not all be released',
            );
        }
    }

    async #run<T>(
        operation: HostOperation,
        processId: string,
        action: (terminal: HostTerminal) => Promise<T>,
    ): Promise<T> {
        if (typeof processId !== 'string' || processId.length > 128) {
            throw new Error('Invalid host terminal identifier');
        }
        return await this.options.owner.run(
            { operation, path: null, destinationPath: null, processId },
            (): Promise<T> => {
                const terminal: HostTerminal | undefined = this.#entries.get(processId);
                if (this.#closed || terminal === undefined) {
                    throw new HostOperationError(
                        ConnectorHostErrorCode.NotFound,
                        'Host terminal is unavailable',
                        true,
                    );
                }
                return action(terminal);
            },
        );
    }

    #forget(terminal: HostTerminal): void {
        if (this.#entries.get(terminal.id) === terminal) {
            this.#entries.delete(terminal.id);
        }
    }
}
