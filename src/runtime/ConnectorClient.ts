// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

import { randomInt } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import type { ConnectorDisconnect } from './ConnectorDisconnect.js';
import { ConnectorConnectionLog } from './ConnectorConnectionLog.js';
import { ConnectorClientState } from './ConnectorClientState.js';
import { ConnectorClientHost } from './ConnectorClientHost.js';
import {
    ConnectorClientConfiguration,
    type ConnectorClientIdentity,
} from './ConnectorClientConfiguration.js';
import { ConnectorClientConnection } from './ConnectorClientConnection.js';
import { ConnectorClientExecution } from './ConnectorClientExecution.js';
import { ConnectorClientFiles } from './ConnectorClientFiles.js';
import { ConnectorClientWorkspaces } from './ConnectorClientWorkspaces.js';
import { dirname } from 'node:path';
import { ConnectorStartupStage, type ConnectorStartupObserver } from './ConnectorStartup.js';
import type { ConnectorActivitySink } from './ConnectorActivity.js';
import { ConnectorHistoryMigration } from './ConnectorHistoryMigration.js';
import {
    ConnectorPrivateDirectory,
    ConnectorDirectoryPurpose,
} from './ConnectorPrivateDirectory.js';

/** One current standalone device owner retains local capability state across authenticated socket replacement. */
export class ConnectorClient implements AsyncDisposable {
    #connection: ConnectorClientConnection | null = null;
    #running: boolean = false;
    readonly #stop: AbortController = new AbortController();
    readonly #done: PromiseWithResolvers<undefined> = Promise.withResolvers<undefined>();
    readonly #files: ConnectorClientFiles | null;
    readonly #execution: ConnectorClientExecution | null;
    readonly #workspaces: ConnectorClientWorkspaces | null;
    readonly #host: ConnectorClientHost | null;
    readonly #observe: (state: ConnectorClientState) => void;
    readonly #resources: AsyncDisposableStack;
    readonly #log: ConnectorConnectionLog | null;
    /** Reports verified local full-computer consent, independently from server scope and online publication. */
    public get hostEnabled(): boolean {
        return this.#host?.grant.profile.enabled === true;
    }
    private constructor(
        public readonly identity: ConnectorClientIdentity,
        files: ConnectorClientFiles | null,
        execution: ConnectorClientExecution | null,
        workspaces: ConnectorClientWorkspaces | null,
        host: ConnectorClientHost | null,
        observe: (state: ConnectorClientState) => void,
        resources: AsyncDisposableStack,
        log: ConnectorConnectionLog | null,
        public readonly progress?: ConnectorStartupObserver,
    ) {
        this.#log = log;
        this.#files = files;
        this.#execution = execution;
        this.#workspaces = workspaces;
        this.#host = host;
        this.#observe = observe;
        this.#resources = resources;
    }
    /**
     * Dedicated communication code loads neither Nexa source nor controller signing/SSH/account credentials.
     *
     * @param activity - Receives every request the file, command and host lanes are about to run, for the local
     * activity screen only; recording never changes, delays or fails a request
     * @param log - Records each connection, why it ended and each retry; `null` records nothing
     */
    public static async load(
        path: string,
        observe: (state: ConnectorClientState) => void,
        progress?: ConnectorStartupObserver,
        signal: AbortSignal = new AbortController().signal,
        activity: ConnectorActivitySink | null = null,
        log: ConnectorConnectionLog | null = null,
    ): Promise<ConnectorClient> {
        signal.throwIfAborted();
        progress?.({ stage: ConnectorStartupStage.Identity });
        const identity: ConnectorClientIdentity = await ConnectorClientConfiguration.load(path);
        await using resources: AsyncDisposableStack = new AsyncDisposableStack();
        resources.use(identity.key);
        resources.use(
            await ConnectorPrivateDirectory.open(
                dirname(identity.settings.privateKeyFile),
                ConnectorDirectoryPurpose.Runtime,
            ),
        );
        await ConnectorLogout.requireActive(dirname(identity.settings.privateKeyFile));
        await ConnectorHistoryMigration.requireComplete(identity);
        if (identity.settings.files !== null) {
            progress?.({ stage: ConnectorStartupStage.FileAccess });
        }
        const files: ConnectorClientFiles | null =
            identity.settings.files === null
                ? null
                : resources.use(await ConnectorClientFiles.load(identity, activity));
        if (identity.settings.execution !== null) {
            progress?.({ stage: ConnectorStartupStage.CommandAccess });
        }
        const execution: ConnectorClientExecution | null =
            identity.settings.execution === null
                ? null
                : resources.use(await ConnectorClientExecution.load(identity, activity));
        const workspaces: ConnectorClientWorkspaces | null = await ConnectorClientWorkspaces.load(
            identity,
            files,
            execution,
            signal,
            progress,
        );
        if (workspaces !== null) {
            resources.use(workspaces);
            if (files === null || execution === null) {
                throw new Error(
                    'Joint workspace admission requires both existing capability owners',
                );
            }
            files.bindJointAdmission(workspaces);
            execution.bindJointAdmission(workspaces);
        }
        const host: ConnectorClientHost | null = await ConnectorClientHost.load(
            identity,
            null,
            activity,
        );
        if (host !== null) {
            resources.use(host);
        }
        const client: ConnectorClient = new ConnectorClient(
            identity,
            files,
            execution,
            workspaces,
            host,
            observe,
            resources.move(),
            log,
            progress,
        );
        return client;
    }

    /** Endpoint rotation and capped jittered backoff always start a new key proof; no execution is replayed. */
    public async run(signal: AbortSignal): Promise<void> {
        if (this.#running) {
            throw new Error('Connector client already running');
        }
        this.#running = true;
        const stopped: AbortSignal = AbortSignal.any([signal, this.#stop.signal]);
        let attempt: number = 0;
        let failures: number = 0;
        using _stalls: Disposable | null = this.#log?.watchStalls() ?? null;
        this.#log?.record('started', {
            platform: process.platform,
            node: process.versions.node,
            host: this.#host !== null,
            files: this.#files !== null,
            execution: this.#execution !== null,
        });
        try {
            while (!stopped.aborted) {
                const endpoint: string | undefined =
                    this.identity.settings.endpoints[
                        attempt % this.identity.settings.endpoints.length
                    ];
                if (endpoint === undefined) {
                    throw new Error('Missing connector endpoint');
                }
                this.#observe(ConnectorClientState.Connecting);
                this.#log?.record('connecting', {
                    endpoint: new URL(endpoint).host,
                    attempt: attempt + 1,
                });
                const started: number = performance.now();
                const connection: ConnectorClientConnection = new ConnectorClientConnection(
                    this.identity,
                    this.#files,
                    this.#execution,
                    this.#observe,
                    this.progress,
                    this.#workspaces,
                    this.#host,
                    this.#log,
                );
                this.#connection = connection;
                const disconnect: ConnectorDisconnect = await connection.run(endpoint, stopped);
                this.#connection = null;
                if (
                    this.#files?.failed === true ||
                    this.#execution?.failed === true ||
                    this.#workspaces?.failed === true ||
                    this.#host?.failed === true
                ) {
                    throw new Error('Connector retained-result durability failed');
                }
                if (stopped.aborted) {
                    break;
                }
                this.#observe(ConnectorClientState.Disconnected);
                failures = performance.now() - started > 30000 ? 0 : Math.min(7, failures + 1);
                attempt = (attempt + 1) % (this.identity.settings.endpoints.length * 1000000);
                const backoff: number = Math.min(30000, 250 * 2 ** failures) + randomInt(250);
                this.#log?.record('retry', { reason: disconnect, inMs: backoff, failures });
                this.progress?.({
                    stage: ConnectorStartupStage.Retry,
                    attempt: attempt + 1,
                    retryAfterMs: backoff,
                    disconnect,
                });
                try {
                    await delay(backoff, undefined, {
                        signal: stopped,
                    });
                } catch {
                    if (!stopped.aborted) {
                        throw new Error('Connector reconnect timer failed');
                    }
                }
            }
        } catch (caught: unknown) {
            this.#log?.record('failed', { error: ConnectorConnectionLog.error(caught) });
            throw caught;
        } finally {
            this.#connection?.terminate();
            this.#log?.record('stopped');
            try {
                this.#observe(ConnectorClientState.Stopped);
                this.progress?.({ stage: ConnectorStartupStage.Stopped });
            } finally {
                this.#done.resolve(undefined);
            }
        }
    }
    /** Explicit shutdown terminates the exact owned socket and joins its reconnect loop. */
    public async [Symbol.asyncDispose](): Promise<void> {
        this.#stop.abort();
        this.#connection?.terminate();
        if (this.#running) {
            await this.#done.promise;
        }
        await this.#resources[Symbol.asyncDispose]();
    }
}
import { ConnectorLogout } from './ConnectorLogout.js';
