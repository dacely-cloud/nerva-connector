// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

import {
    ConnectorPairClient,
    ConnectorPairEventKind,
    type ConnectorPairCompleted,
    type ConnectorPairEvent,
} from '../runtime/ConnectorPairClient.js';
import { ConnectorClient } from '../runtime/ConnectorClient.js';
import type { ConnectorClientState } from '../runtime/ConnectorClientState.js';
import {
    ConnectorStartupStage,
    type ConnectorStartupObserver,
    type ConnectorStartupProgress,
} from '../runtime/ConnectorStartup.js';
import { ConnectorStartupDisplay } from './ConnectorStartupDisplay.js';
import {
    ConnectorFailure,
    ConnectorFailureRecovery,
    type ConnectorFailureReason,
} from './ConnectorFailure.js';
import { ConnectorLinkStatus, type ConnectorLinkView } from './ConnectorLinkStatus.js';
import { ConnectorLinkOutcomeKind, type ConnectorLinkOutcome } from './ConnectorLinkStep.js';
import type { ConnectorLinkFlow } from './ConnectorLinkFlow.js';
import type { ConnectorConsoleLocation } from './ConnectorConsoleLocation.js';
import type { ConnectorSetupSession } from './ConnectorSetupSession.js';
import type { ConnectorConsoleModel } from './ConnectorConsoleModel.js';
import type { ConnectorConsole } from './ConnectorConsole.js';
import { ConnectorAccessSetup } from './ConnectorAccessSetup.js';
import { ConnectorPermissionPrompt } from './ConnectorPermissionPrompt.js';
import type { ConnectorActivitySink } from '../runtime/ConnectorActivity.js';
import type { ConnectorConnectionLog } from '../runtime/ConnectorConnectionLog.js';

/** What the connection supervisor borrows from the console application. */
export interface ConnectorConsoleConnectionOptions {
    readonly model: ConnectorConsoleModel;
    readonly setup: ConnectorSetupSession;
    readonly location: ConnectorConsoleLocation;
    readonly linking: ConnectorLinkFlow;
    /** Aborted when the application closes. */
    readonly stop: AbortSignal;
    /** Records what Nexa does on this computer for the console's activity lists. */
    readonly activity: ConnectorActivitySink;
    /** Records why each connection ended, for `/log` and for matching against the Nerva server journal. */
    readonly log: ConnectorConnectionLog;
    readonly view: () => ConnectorConsole | null;
    /** Whether a slash command is running; automatic retries wait for it. */
    readonly busy: () => boolean;
    /** Ctrl+C on the linking screen closes the application. */
    readonly quit: () => void;
}

/**
 * Owns one connection attempt at a time: linking when needed, applying setup choices, running the
 * authenticated client, and explaining failures with automatic retries for transient ones.
 */
export class ConnectorConsoleConnection implements AsyncDisposable {
    readonly #options: ConnectorConsoleConnectionOptions;
    #session: AbortController | null = null;
    #running: Promise<void> | null = null;
    #configurationFile: string | null = null;
    #retry: NodeJS.Timeout | null = null;
    #retries: number = 0;
    #stage: ConnectorStartupStage | null = null;
    #signedIn: boolean = false;
    #httpStatus: number | null = null;
    #event: ConnectorPairEventKind | null = null;
    readonly #progress: ConnectorStartupDisplay;

    /** Progress is shown only while this supervisor is actually working. */
    public constructor(options: ConnectorConsoleConnectionOptions) {
        this.#options = options;
        this.#progress = new ConnectorStartupDisplay((text: string): void => {
            options.model.activity = text;
            options.view()?.draw();
        }, true);
    }

    /** The linked computer's device configuration, once known in this process. */
    public get configurationFile(): string | null {
        return this.#configurationFile;
    }

    /** Startup and runtime progress for the console's activity line and retry headline. */
    public readonly observe: ConnectorStartupObserver = (event: ConnectorStartupProgress): void => {
        const model: ConnectorConsoleModel = this.#options.model;
        if (event.stage === ConnectorStartupStage.Closing) {
            if (this.#options.stop.aborted) {
                return;
            }
            model.closing();
        } else if (event.stage === ConnectorStartupStage.Retry) {
            model.retrying(
                this.#signedIn && event.disconnect !== undefined
                    ? ConnectorFailure.dropped(event.disconnect)
                    : ConnectorFailure.retrying(this.#stage, this.#httpStatus),
                performance.now() + Math.max(0, event.retryAfterMs ?? 0),
            );
            this.#signedIn = false;
        } else if (
            event.stage !== ConnectorStartupStage.Ready &&
            event.stage !== ConnectorStartupStage.Stopped
        ) {
            if (model.retryAt !== null) {
                model.connecting();
            }
            this.#stage = event.stage;
            this.#httpStatus = event.httpStatus ?? null;
            if (event.stage === ConnectorStartupStage.WorkspacePublication) {
                this.#signedIn = true;
            }
        } else if (event.stage === ConnectorStartupStage.Ready) {
            this.#retries = 0;
            this.#signedIn = true;
        }
        this.#progress.update(event);
    };

    /**
     * Stops any current attempt, waits for it, then starts a new one.
     *
     * @param linked - A link verified moments ago on the setup screens, so pairing is not repeated
     */
    public async restart(linked: ConnectorPairCompleted | null): Promise<void> {
        this.cancelRetry();
        if (this.#running !== null) {
            this.observe({ stage: ConnectorStartupStage.Closing });
        }
        this.#session?.abort();
        if (this.#running !== null) {
            await this.#running;
        }
        if (this.#options.stop.aborted) {
            return;
        }
        this.#options.model.connecting();
        this.#options.model.details = [];
        this.#stage = null;
        this.#httpStatus = null;
        this.#event = null;
        const session: AbortController = new AbortController();
        this.#session = session;
        this.#running = this.#connect(
            AbortSignal.any([session.signal, this.#options.stop]),
            linked,
        );
        this.#options.view()?.draw();
    }

    /** Stops the running connection before local access changes; the caller restarts afterwards. */
    public async halt(): Promise<void> {
        this.cancelRetry();
        this.observe({ stage: ConnectorStartupStage.Closing });
        this.#session?.abort();
        if (this.#running !== null) {
            await this.#running;
        }
    }

    /** Stops the attempt without showing a closing state; used before unlinking. */
    public async stop(): Promise<void> {
        this.cancelRetry();
        this.#session?.abort();
        if (this.#running !== null) {
            await this.#running;
        }
        this.#configurationFile = null;
    }

    /** Cancels a scheduled automatic retry. */
    public cancelRetry(): void {
        if (this.#retry !== null) {
            clearTimeout(this.#retry);
            this.#retry = null;
        }
    }

    /** Releases the retry timer and progress display and joins the current attempt. */
    public async [Symbol.asyncDispose](): Promise<void> {
        this.cancelRetry();
        this.#progress[Symbol.dispose]();
        this.#session?.abort();
        if (this.#running !== null) {
            await Promise.allSettled([this.#running]);
        }
    }

    async #connect(signal: AbortSignal, linked: ConnectorPairCompleted | null): Promise<void> {
        const model: ConnectorConsoleModel = this.#options.model;
        try {
            const completed: ConnectorPairCompleted | null = linked ?? (await this.#pair(signal));
            if (completed === null || signal.aborted) {
                return;
            }
            const configurationFile: string = completed.configurationFile;
            this.#configurationFile = configurationFile;
            if (await ConnectorAccessSetup.needed(this.#options.setup, configurationFile)) {
                this.#quiet();
                model.details = await this.#prompt(
                    async (questions: ConnectorPermissionPrompt): Promise<readonly string[]> =>
                        await ConnectorAccessSetup.apply(this.#options.setup, {
                            configurationFile,
                            installationDirectory: await this.#options.location.directory(),
                            questions,
                            signal: questions.signal,
                        }),
                );
            }
            signal.throwIfAborted();
            await using client: ConnectorClient = await ConnectorClient.load(
                configurationFile,
                (state: ConnectorClientState): void => {
                    model.connection(state);
                    this.#options.view()?.draw();
                },
                this.observe,
                signal,
                this.#options.activity,
                this.#options.log,
            );
            model.files = client.identity.settings.files !== null;
            model.execution = client.identity.settings.execution !== null;
            model.host = client.hostEnabled;
            this.#options.view()?.draw();
            await client.run(signal);
        } catch (caught: unknown) {
            this.#fail(caught, signal);
        }
    }

    async #pair(signal: AbortSignal): Promise<ConnectorPairCompleted | null> {
        const model: ConnectorConsoleModel = this.#options.model;
        this.observe({ stage: ConnectorStartupStage.LocalSecurity });
        const pairingFile: string = await this.#options.location.pairingFile(
            signal,
            this.#options.setup,
        );
        this.observe({ stage: ConnectorStartupStage.Configuration });
        const status: ConnectorLinkView = await ConnectorLinkStatus.inspect(pairingFile);
        if (!status.linked) {
            this.#quiet();
            const outcome: ConnectorLinkOutcome = await this.#prompt(
                async (questions: ConnectorPermissionPrompt): Promise<ConnectorLinkOutcome> =>
                    await this.#options.linking.run(
                        questions,
                        questions.signal,
                        status.deviceName,
                        undefined,
                    ),
            );
            if (outcome.kind === ConnectorLinkOutcomeKind.Canceled) {
                this.#options.quit();
                return null;
            }
            if (outcome.kind !== ConnectorLinkOutcomeKind.Linked) {
                model.notLinked();
                this.#options.view()?.draw();
                return null;
            }
            model.connecting();
            return outcome.completed;
        }
        const completed: ConnectorPairCompleted[] = [];
        await ConnectorPairClient.run(
            pairingFile,
            signal,
            (event: ConnectorPairEvent): void => {
                model.pairing(event);
                if (event.state === ConnectorPairEventKind.Paired) {
                    completed[0] = event;
                } else if (event.state !== ConnectorPairEventKind.Reconnecting) {
                    this.#event = event.state;
                }
                this.#options.view()?.draw();
            },
            undefined,
            this.observe,
        );
        return completed[0] ?? null;
    }

    async #prompt<T>(operation: (questions: ConnectorPermissionPrompt) => Promise<T>): Promise<T> {
        const view: ConnectorConsole | null = this.#options.view();
        if (view === null) {
            throw new Error('Connector terminal is unavailable');
        }
        return await view.withPrompt(async (): Promise<T> => {
            using questions: ConnectorPermissionPrompt = new ConnectorPermissionPrompt(
                this.#options.stop,
            );
            return await operation(questions);
        });
    }

    #fail(caught: unknown, signal: AbortSignal): void {
        if (signal.aborted) {
            return;
        }
        this.#quiet();
        const reason: ConnectorFailureReason = ConnectorFailure.classify({
            error: caught,
            stage: this.#stage,
            httpStatus: this.#httpStatus,
            event: this.#event,
            codeShown: false,
        });
        if (reason.recovery !== ConnectorFailureRecovery.Automatic) {
            this.#options.model.failure(reason, null);
            this.#options.view()?.draw();
            return;
        }
        this.#retries += 1;
        const delay: number = ConnectorFailure.backoffMs(this.#retries);
        this.#options.model.failure(reason, performance.now() + delay);
        this.#options.view()?.draw();
        this.#schedule(delay);
    }

    #schedule(delay: number): void {
        this.cancelRetry();
        this.#retry = setTimeout((): void => {
            this.#retry = null;
            if (this.#options.stop.aborted) {
                return;
            }
            if (this.#options.busy()) {
                this.#schedule(1000);
            } else {
                void this.restart(null);
            }
        }, delay);
        this.#retry.unref();
    }

    #quiet(): void {
        this.#progress.update({ stage: ConnectorStartupStage.Stopped });
    }
}
