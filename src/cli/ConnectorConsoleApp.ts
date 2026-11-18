// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

import { ConnectorSetupSession } from './ConnectorSetupSession.js';
import { ConnectorHostPermissionWizard } from './ConnectorHostPermissionWizard.js';
import { ConnectorConsole } from './ConnectorConsole.js';
import { ConnectorLogout } from '../runtime/ConnectorLogout.js';
import {
    ConnectorPermissionError,
    ConnectorPermissionFailure,
} from '../permissions/ConnectorPermissionError.js';
import { ConnectorPermissionPrompt } from './ConnectorPermissionPrompt.js';
import {
    ConnectorPermissionWizard,
    type ConnectorPermissionResult,
} from './ConnectorPermissionWizard.js';
import {
    ConnectorConsoleCommand,
    ConnectorConsoleModel,
    ConnectorConsolePhase,
} from './ConnectorConsoleModel.js';
import type { ConnectorPairCompleted } from '../runtime/ConnectorPairClient.js';
import { SystemInfo } from '../system/SystemInfo.js';
import type {
    SystemSpecification,
    GpuSpecification,
} from 'nerva-connector-protocol/system/SystemSpecification.js';
import { ConnectorStartupDisplay } from './ConnectorStartupDisplay.js';
import { ConnectorStartupStage } from '../runtime/ConnectorStartup.js';
import { ConnectorFailure, type ConnectorFailureReason } from './ConnectorFailure.js';
import { ConnectorLinkOutcomeKind, type ConnectorLinkOutcome } from './ConnectorLinkStep.js';
import { ConnectorLinkFlow } from './ConnectorLinkFlow.js';
import {
    ConnectorConsoleLocation,
    ConnectorConsoleSourceKind,
    type ConnectorConsoleSource,
} from './ConnectorConsoleLocation.js';
import { ConnectorConsoleConnection } from './ConnectorConsoleConnection.js';
import { ConnectorActivityFeed } from '../runtime/ConnectorActivityFeed.js';
import type { ConnectorSetupProfile } from '../runtime/ConnectorSetupProfile.js';
import { ConnectorConnectionLog } from '../runtime/ConnectorConnectionLog.js';
import { ConnectorLogSummary } from './ConnectorLogSummary.js';
import { WindowsBackgroundStartup } from '../windows/WindowsBackgroundStartup.js';
import { ConnectorUpdateChannel } from './ConnectorUpdateChannel.js';
import { ConnectorConsoleView } from './ConnectorConsoleScreen.js';

/** Foreground application: first-run setup and linking, then the console's slash commands. */
export class ConnectorConsoleApp {
    readonly #model: ConnectorConsoleModel = new ConnectorConsoleModel();
    readonly #activity: ConnectorActivityFeed = new ConnectorActivityFeed();
    readonly #log: ConnectorConnectionLog = new ConnectorConnectionLog(
        ConnectorConnectionLog.location(),
    );
    readonly #setup: ConnectorSetupSession;
    readonly #location: ConnectorConsoleLocation;
    readonly #linking: ConnectorLinkFlow;
    readonly #connection: ConnectorConsoleConnection;
    readonly #quit: PromiseWithResolvers<undefined> = Promise.withResolvers<undefined>();
    readonly #stop: AbortController = new AbortController();
    readonly #startup: WindowsBackgroundStartup | null = WindowsBackgroundStartup.find();
    #view: ConnectorConsole | null = null;
    #action: Promise<void> | null = null;
    #updates: ConnectorUpdateChannel | null = null;

    /** The installer chooses the private pairing file; the terminal never asks users to author it. */
    public constructor(public readonly source: ConnectorConsoleSource) {
        this.#location = new ConnectorConsoleLocation(source);
        this.#setup = new ConnectorSetupSession(
            (): Promise<string> => this.#location.directory(),
            this.#stop.signal,
        );
        this.#linking = new ConnectorLinkFlow(this.#location, this.#setup);
        this.#connection = new ConnectorConsoleConnection({
            model: this.#model,
            setup: this.#setup,
            location: this.#location,
            linking: this.#linking,
            stop: this.#stop.signal,
            activity: this.#activity,
            log: this.#log,
            view: (): ConnectorConsole | null => this.#view,
            busy: (): boolean => this.#action !== null,
            quit: (): void => this.#close(),
        });
    }

    /** One terminal stays responsive through setup, linking and the lifetime of an authenticated session. */
    public async run(signal: AbortSignal): Promise<void> {
        const abort: () => void = (): void => this.#close();
        signal.addEventListener('abort', abort, { once: true });
        if (signal.aborted) {
            abort();
        }
        try {
            using view: ConnectorConsole = new ConnectorConsole(
                this.#model,
                (command: ConnectorConsoleCommand): void => {
                    if (command === ConnectorConsoleCommand.Quit) {
                        abort();
                        return;
                    }
                    if (this.#action !== null) {
                        return;
                    }
                    const action: PromiseWithResolvers<undefined> =
                        Promise.withResolvers<undefined>();
                    this.#action = action.promise;
                    void this.#handle(command, action);
                },
                this.#activity,
            );
            this.#view = view;
            using updates: ConnectorUpdateChannel = new ConnectorUpdateChannel(
                (rows: readonly string[]): void => {
                    this.#model.details = rows;
                    this.#view?.draw();
                },
                (): void => this.#close(),
            );
            this.#updates = updates;
            this.#model.updates = updates.available;
            if (this.#startup !== null) {
                void this.#readStartup();
            }
            let linked: ConnectorPairCompleted | null = null;
            let start: boolean = true;
            if (
                process.stdin.isTTY &&
                process.stdout.isTTY &&
                this.source.kind !== ConnectorConsoleSourceKind.Pairing &&
                (await this.#setup.load()) === null
            ) {
                const outcome: ConnectorLinkOutcome | null = await view.withPrompt(
                    (): Promise<ConnectorLinkOutcome | null> => this.#firstRun(),
                );
                if (outcome === null || outcome.kind === ConnectorLinkOutcomeKind.Canceled) {
                    abort();
                    return;
                }
                this.#profile();
                if (outcome.kind === ConnectorLinkOutcomeKind.Linked) {
                    linked = outcome.completed;
                } else {
                    start = false;
                    this.#model.notLinked();
                    view.draw();
                }
            }
            this.#profile();
            if (start) {
                await this.#connection.restart(linked);
            }
            await this.#quit.promise;
        } finally {
            this.#stop.abort();
            await this.#connection[Symbol.asyncDispose]();
            if (this.#action !== null) {
                await Promise.allSettled([this.#action]);
            }
            await this.#log.flush();
            this.#view = null;
            this.#updates = null;
            signal.removeEventListener('abort', abort);
        }
    }

    /** Shows the saved computer name and folder; nothing else from the profile reaches the screen. */
    #profile(): void {
        const profile: ConnectorSetupProfile | null = this.#setup.profile;
        if (profile !== null) {
            this.#model.computer = profile.name;
            this.#model.folder = profile.tasksDirectory;
        }
    }

    #close(): void {
        this.#connection.cancelRetry();
        this.#stop.abort();
        this.#quit.resolve(undefined);
    }

    async #firstRun(): Promise<ConnectorLinkOutcome | null> {
        using questions: ConnectorPermissionPrompt = new ConnectorPermissionPrompt(
            this.#stop.signal,
        );
        if (!(await this.#setup.review(questions, true, false))) {
            return null;
        }
        return await this.#linking.run(
            questions,
            questions.signal,
            this.#setup.profile?.name ?? 'this computer',
            this.#setup.linkStep,
        );
    }

    async #handle(
        command: ConnectorConsoleCommand,
        action: PromiseWithResolvers<undefined>,
    ): Promise<void> {
        try {
            if (command === ConnectorConsoleCommand.Reconnect) {
                await this.#connection.restart(null);
            } else if (command === ConnectorConsoleCommand.Logout) {
                await this.#logout();
            } else if (command === ConnectorConsoleCommand.Pair) {
                if (this.#model.phase === ConnectorConsolePhase.Connected) {
                    this.#model.details = [
                        'This computer is already linked to your Nerva account.',
                    ];
                } else {
                    await this.#connection.restart(null);
                }
            } else if (command === ConnectorConsoleCommand.Settings) {
                await this.#reviewSetup();
            } else if (command === ConnectorConsoleCommand.Permissions) {
                await this.#permissions();
            } else if (command === ConnectorConsoleCommand.DisableHost) {
                await this.#disableHost();
            } else if (command === ConnectorConsoleCommand.System) {
                await this.#system();
            } else if (command === ConnectorConsoleCommand.Log) {
                await this.#showLog();
            } else if (command === ConnectorConsoleCommand.Startup) {
                await this.#toggleStartup();
            } else if (command === ConnectorConsoleCommand.Update) {
                this.#view?.show(ConnectorConsoleView.Home);
                this.#updates?.check(this.#stop.signal);
            } else {
                this.#model.details = [];
            }
        } catch (caught: unknown) {
            if (command === ConnectorConsoleCommand.Update) {
                this.#log.record('update-request-failed');
                this.#model.details = [
                    "Couldn't request an update. Reopen Nerva Connector from its installed shortcut and try /update again.",
                    'If it still fails, run the current installer to repair the update launcher.',
                ];
                return;
            }
            const reason: ConnectorFailureReason = ConnectorFailure.classify({
                error: caught,
                stage: null,
                httpStatus: null,
                event: null,
                codeShown: false,
            });
            this.#model.details =
                command === ConnectorConsoleCommand.Logout
                    ? [
                          "Couldn't confirm the unlink with Nerva, so this computer is still linked. " +
                              reason.title +
                              '. Try /logout again when you are online.',
                      ]
                    : [reason.title + '. ' + reason.detail];
        } finally {
            this.#action = null;
            this.#view?.draw();
            action.resolve(undefined);
        }
    }

    async #logout(): Promise<void> {
        await this.#connection.stop();
        this.#model.connecting();
        this.#model.message = 'Unlinking this computer…';
        this.#model.details = [];
        this.#view?.draw();
        try {
            await ConnectorLogout.run(
                await this.#location.pairingFile(this.#stop.signal, this.#setup),
                this.#stop.signal,
            );
        } catch (caught: unknown) {
            await this.#connection.restart(null);
            throw caught;
        }
        this.#model.host = false;
        this.#model.files = false;
        this.#model.execution = false;
        await this.#connection.restart(null);
    }

    async #reviewSetup(): Promise<void> {
        const view: ConnectorConsole | null = this.#view;
        if (view === null) {
            return;
        }
        const saved: boolean = await view.withPrompt(async (): Promise<boolean> => {
            using questions: ConnectorPermissionPrompt = new ConnectorPermissionPrompt(
                this.#stop.signal,
            );
            return await this.#setup.review(questions, false, this.#model.host);
        });
        this.#profile();
        await this.#readStartup();
        if (!saved) {
            this.#model.details = ['No changes were made.'];
        } else if (this.#setup.pending || this.#connection.configurationFile === null) {
            await this.#connection.restart(null);
            this.#model.details = ['Saved.'];
        } else {
            this.#model.details = ['Saved.', ...this.#setup.summary()];
        }
    }

    async #system(): Promise<void> {
        using activity: ConnectorStartupDisplay = new ConnectorStartupDisplay(
            (text: string): void => {
                this.#model.details = text === '' ? [] : [text];
                this.#view?.draw();
            },
            true,
        );
        activity.update({ stage: ConnectorStartupStage.System });
        const system: SystemSpecification = await SystemInfo.read(this.#stop.signal);
        this.#model.details = [
            system.cpuModel + ' · ' + system.logicalCpuCount.toString() + ' CPUs',
            'Memory: ' + (BigInt(system.totalMemoryBytes) / 1073741824n).toString() + ' GiB',
            ...system.gpus.map((gpu: GpuSpecification): string => gpu.model),
        ];
    }

    /** Shows the sign-in setting of the installed Windows connector; elsewhere /startup stays hidden. */
    async #readStartup(): Promise<void> {
        if (this.#startup === null) {
            return;
        }
        try {
            this.#model.startup = await this.#startup.enabled(this.#stop.signal);
        } catch {
            this.#model.startup = null;
        }
        this.#view?.draw();
    }

    async #toggleStartup(): Promise<void> {
        const program: WindowsBackgroundStartup | null = this.#startup;
        if (program === null) {
            this.#model.details = ['Starting at sign-in is part of the installed Windows app.'];
            return;
        }
        const enabled: boolean = !(await program.enabled(this.#stop.signal));
        await program.set(enabled, this.#stop.signal);
        this.#model.startup = enabled;
        this.#model.details = [
            enabled
                ? 'Nerva Connector now starts in the background when you sign in to Windows. Click its icon next to the clock to open it.'
                : 'Nerva Connector no longer starts when you sign in. Nexa can use this computer only while it is open.',
        ];
    }

    async #showLog(): Promise<void> {
        const rows: readonly string[] = ConnectorLogSummary.rows(await this.#log.recent(200), 6);
        this.#model.details = [
            'Connection log: ' + this.#log.path,
            ...(rows.length === 0 ? ['No disconnects recorded yet.'] : rows),
        ];
    }

    async #permissions(): Promise<void> {
        if (process.platform !== 'linux') {
            this.#model.details = [
                new ConnectorPermissionError(ConnectorPermissionFailure.Platform).message,
            ];
            return;
        }
        const view: ConnectorConsole | null = this.#view;
        if (view === null) {
            return;
        }
        let interrupted: boolean = false;
        const result: ConnectorPermissionResult = await view.withPrompt(
            async (): Promise<ConnectorPermissionResult> => {
                using questions: ConnectorPermissionPrompt = new ConnectorPermissionPrompt(
                    this.#stop.signal,
                );
                return await ConnectorPermissionWizard.run(
                    await this.#location.directory(),
                    questions,
                    questions.signal,
                    async (): Promise<void> => {
                        interrupted = true;
                        await this.#connection.halt();
                    },
                );
            },
        );
        if (interrupted && !this.#stop.signal.aborted) {
            await this.#connection.restart(null);
        }
        this.#model.details = [result.message];
    }

    async #disableHost(): Promise<void> {
        const configurationFile: string | null = this.#connection.configurationFile;
        const view: ConnectorConsole | null = this.#view;
        if (configurationFile === null || view === null) {
            this.#model.details = ['Link this computer to your Nerva account first.'];
            return;
        }
        if (!(await ConnectorHostPermissionWizard.enabled(configurationFile))) {
            this.#model.host = false;
            this.#model.details = ['Full computer access is already off.'];
            return;
        }
        let interrupted: boolean = false;
        try {
            const disabled: boolean = await view.withPrompt(async (): Promise<boolean> => {
                using questions: ConnectorPermissionPrompt = new ConnectorPermissionPrompt(
                    this.#stop.signal,
                );
                return await ConnectorHostPermissionWizard.disable(
                    configurationFile,
                    questions,
                    questions.signal,
                    async (): Promise<void> => {
                        interrupted = true;
                        await this.#connection.halt();
                    },
                );
            });
            if (disabled) {
                this.#model.host = false;
            }
            this.#model.details = [
                disabled ? 'Full computer access is off.' : 'Full computer access is still on.',
            ];
        } finally {
            if (interrupted && !this.#stop.signal.aborted) {
                await this.#connection.restart(null);
            }
        }
    }
}
