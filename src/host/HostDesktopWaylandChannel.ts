// SPDX-FileCopyrightText: 2026 Dacely <business@dacely.com>
// SPDX-License-Identifier: LicenseRef-Proprietary

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ConnectorHostErrorCode } from 'nerva-connector-protocol/protocol/ConnectorHost.js';
import { HostOperationError } from './HostOperationError.js';
import { HostDesktopLimits } from './HostDesktopTypes.js';
import { HostDesktopWaylandScript } from './HostDesktopWaylandScript.js';
import {
    HostDesktopWaylandOperation,
    HostDesktopWaylandFailure,
    HostDesktopWaylandProtocol,
    type HostDesktopWaylandCommand,
    type HostDesktopWaylandResponse,
    type HostDesktopWaylandResult,
} from './HostDesktopWaylandProtocol.js';

/** A single outstanding operation bounds private pipe memory and prevents input replay across consent generations. */
interface HostDesktopWaylandPending {
    readonly id: bigint;
    readonly deferred: PromiseWithResolvers<HostDesktopWaylandResponse>;
    consumed: boolean;
}

/** One persistent interpreter owns the unique portal sender and all its approved native resources. */
export class HostDesktopWaylandChannel implements AsyncDisposable {
    readonly #child: ChildProcessWithoutNullStreams;
    readonly #closed: PromiseWithResolvers<undefined> = Promise.withResolvers<undefined>();
    #pending: HostDesktopWaylandPending | null = null;
    #sequence: bigint = 0n;
    #buffer: Buffer = Buffer.alloc(0);
    #length: number = 0;
    #failure: Error | null = null;
    #ended: boolean = false;
    #disposal: Promise<void> | null = null;
    #cacheFailure: Error | null = null;
    #exitFailure: Error | null = null;
    #cleanup: Promise<void> | null = null;

    /** The local owner retains its exact private cache path until native closure is observed. */
    private constructor(
        environment: NodeJS.ProcessEnv,
        public readonly cacheDirectory: string,
    ) {
        this.#child = spawn('python3', ['-I', '-B', '-c', HostDesktopWaylandScript.source], {
            env: environment,
            stdio: 'pipe',
            windowsHide: true,
        });
        this.#child.stdout.on('data', (chunk: Buffer): void => this.#output(chunk));
        this.#child.stderr.resume();
        this.#child.stdin.on('error', (): void =>
            this.#fail(new Error('Wayland portal input pipe failed; an effect may be partial')),
        );
        this.#child.once('error', (): void =>
            this.#fail(new Error('Wayland portal helper could not start')),
        );
        this.#child.once('close', (code: number | null, signal: NodeJS.Signals | null): void => {
            if (code !== 0 || signal !== null) {
                this.#exitFailure = new Error(
                    'Wayland helper exited without confirmed held-input cleanup',
                );
            }
            this.#cleanup = this.#finish();
        });
    }

    /** One private registry contains any GStreamer cold-start cache and is removed after observed helper closure. */
    public static async create(environment: NodeJS.ProcessEnv): Promise<HostDesktopWaylandChannel> {
        const directory: string = await mkdtemp(join(tmpdir(), 'nerva-wayland-'));
        try {
            const childEnvironment: NodeJS.ProcessEnv = {
                ...environment,
                XDG_CACHE_HOME: directory,
                GST_REGISTRY: join(directory, 'registry.bin'),
                GST_REGISTRY_1_0: join(directory, 'registry.bin'),
                GST_REGISTRY_FORK: 'no',
                GST_REGISTRY_MODE: '0600',
                GST_DEBUG: '0',
            };
            for (const key of [
                'GST_DEBUG_FILE',
                'GST_DEBUG_DUMP_DOT_DIR',
                'GST_TRACE',
                'GST_TRACERS',
                'GST_PLUGIN_SCANNER',
                'GST_PLUGIN_SCANNER_1_0',
            ]) {
                delete childEnvironment[key];
            }
            return new HostDesktopWaylandChannel(childEnvironment, directory);
        } catch (caught: unknown) {
            await rm(directory, { recursive: true, force: true });
            throw caught;
        }
    }

    async #finish(): Promise<void> {
        this.#fail(new Error('Wayland portal helper closed'));
        try {
            await rm(this.cacheDirectory, { recursive: true, force: true });
        } catch {
            this.#cacheFailure = new Error('Wayland helper private registry cleanup failed');
        } finally {
            this.#ended = true;
            this.#closed.resolve(undefined);
        }
    }

    /** Complete exactly one bounded request; a timeout ends this consent generation instead of replaying effects. */
    public async request(command: HostDesktopWaylandCommand): Promise<HostDesktopWaylandResult> {
        if (this.#disposal !== null || this.#failure !== null || this.#pending !== null) {
            throw this.#failure ?? new Error('Wayland portal session is closed or busy');
        }
        const id: bigint = ++this.#sequence;
        const input: string = JSON.stringify({ id: id.toString(), ...command }) + '\n';
        if (Buffer.byteLength(input) > HostDesktopLimits.inputBytes) {
            throw new Error('Wayland portal request exceeds input bound');
        }
        const pending: HostDesktopWaylandPending = {
            id,
            consumed: false,
            deferred: Promise.withResolvers<HostDesktopWaylandResponse>(),
        };
        this.#pending = pending;
        const timeoutMs: number =
            command.operation === HostDesktopWaylandOperation.Open
                ? 75000
                : HostDesktopLimits.timeoutMs;
        const timer: ReturnType<typeof setTimeout> = setTimeout((): void => {
            this.#fail(
                new Error(
                    'Wayland portal operation exceeded its deadline; an effect may be partial',
                ),
            );
        }, timeoutMs);
        try {
            this.#child.stdin.write(input, (error?: Error | null): void => {
                if (error !== null && error !== undefined) {
                    this.#fail(new Error('Wayland portal input failed; an effect may be partial'));
                }
            });
            const response: HostDesktopWaylandResponse = await pending.deferred.promise;
            if (this.#failure !== null) {
                throw this.#failure;
            }
            if (response.error !== null) {
                if (
                    command.operation === HostDesktopWaylandOperation.Open &&
                    response.error === HostDesktopWaylandFailure.Denied
                ) {
                    throw new HostOperationError(
                        ConnectorHostErrorCode.PermissionDenied,
                        'Wayland desktop sharing was declined before the requested desktop effect',
                        true,
                    );
                }
                throw new Error('Wayland portal operation failed: ' + response.error);
            }
            if (response.result === null) {
                throw new Error('Wayland portal result missing');
            }
            return response.result;
        } catch (error: unknown) {
            if (this.#failure !== null) {
                try {
                    await this[Symbol.asyncDispose]();
                } catch {
                    /** Preserve the original bounded operation failure after joining the helper. */
                }
            }
            throw error;
        } finally {
            clearTimeout(timer);
            if (this.#pending === pending) {
                this.#pending = null;
            }
        }
    }

    /** Closing the private connection cancels pending consent and joins interpreter termination before releasing ownership. */
    public async [Symbol.asyncDispose](): Promise<void> {
        this.#disposal ??= this.#dispose();
        await this.#disposal;
    }

    async #dispose(): Promise<void> {
        this.#pending?.deferred.reject(
            new Error('Wayland portal operation canceled by session cleanup'),
        );
        if (this.#ended) {
            await this.#cleanup;
            if (this.#cacheFailure !== null) {
                throw this.#cacheFailure;
            }
            if (this.#exitFailure !== null) {
                throw this.#exitFailure;
            }
            return;
        }
        this.#child.stdin.end('{"id":"0","operation":"close"}\n');
        let forced: boolean = false;
        let joinTimer: ReturnType<typeof setTimeout> | null = null;
        const deadline: PromiseWithResolvers<undefined> = Promise.withResolvers<undefined>();
        const timer: ReturnType<typeof setTimeout> = setTimeout((): void => {
            forced = true;
            this.#child.kill('SIGKILL');
            joinTimer = setTimeout(
                (): void =>
                    deadline.reject(
                        new Error(
                            'Wayland helper termination could not be confirmed; native ownership retained',
                        ),
                    ),
                5000,
            );
        }, 5000);
        try {
            await Promise.race([this.#closed.promise, deadline.promise]);
        } finally {
            clearTimeout(timer);
            if (joinTimer !== null) {
                clearTimeout(joinTimer);
            }
            this.#buffer = Buffer.alloc(0);
            this.#length = 0;
        }
        if (this.#cacheFailure !== null) {
            throw this.#cacheFailure;
        }
        if (this.#exitFailure !== null) {
            throw this.#exitFailure;
        }
        if (forced) {
            throw new Error(
                'Wayland portal helper joined after forced shutdown; held-input cleanup is uncertain',
            );
        }
    }

    #fail(error: Error): void {
        this.#failure ??= error;
        this.#pending?.deferred.reject(this.#failure);
    }

    #output(chunk: Buffer): void {
        if (this.#failure !== null || this.#disposal !== null) {
            return;
        }
        const maximum: number = Math.ceil(HostDesktopLimits.imageBytes / 3) * 4 + 4096;
        if (this.#length + chunk.length > maximum) {
            this.#fail(new Error('Wayland portal output exceeds its bound'));
            return;
        }
        const required: number = this.#length + chunk.length;
        if (required > this.#buffer.length) {
            const next: Buffer = Buffer.allocUnsafe(
                Math.min(maximum, Math.max(4096, required, this.#buffer.length * 2)),
            );
            this.#buffer.copy(next, 0, 0, this.#length);
            this.#buffer = next;
        }
        chunk.copy(this.#buffer, this.#length);
        this.#length = required;
        const newline: number = chunk.indexOf(10);
        if (newline < 0) {
            return;
        }
        try {
            if (newline !== chunk.length - 1 || this.#pending === null || this.#pending.consumed) {
                throw new Error('Unexpected Wayland portal output');
            }
            const raw: unknown = JSON.parse(
                this.#buffer.subarray(0, this.#length - 1).toString('utf8'),
            );
            const response: HostDesktopWaylandResponse = HostDesktopWaylandProtocol.response(raw);
            if (response.id !== this.#pending.id) {
                throw new Error('Wayland portal response correlation failed');
            }
            this.#buffer = Buffer.alloc(0);
            this.#length = 0;
            this.#pending.consumed = true;
            this.#pending.deferred.resolve(response);
        } catch {
            this.#fail(new Error('Invalid Wayland portal helper response'));
        }
    }
}
