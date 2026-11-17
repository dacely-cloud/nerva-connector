// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

import {
    ConnectorPairEventKind,
    ConnectorPairIntent,
    type ConnectorPairCompleted,
    type ConnectorPairEvent,
} from '../runtime/ConnectorPairClient.js';
import {
    ConnectorStartupStage,
    type ConnectorStartupObserver,
    type ConnectorStartupProgress,
} from '../runtime/ConnectorStartup.js';
import {
    ConnectorFailure,
    ConnectorFailureRecovery,
    type ConnectorFailureReason,
} from './ConnectorFailure.js';
import type { ConnectorPermissionQuestions } from './ConnectorPermissionPrompt.js';
import {
    ConnectorPromptAction,
    ConnectorPromptKind,
    ConnectorPromptTone,
    type ConnectorPromptPanel,
    type ConnectorPromptResult,
    type ConnectorPromptStatus,
    type ConnectorPromptStep,
} from './ConnectorPromptTypes.js';

/** How the linking screen ended. */
export const ConnectorLinkOutcomeKind = {
    /** The account approved this computer and its verified configuration is saved. */
    Linked: 'linked',
    /** The person chose to link later from the console. */
    Later: 'later',
    /** Ctrl+C, or the application is closing. */
    Canceled: 'canceled',
    /** The link was declined or removed; the person asked to unlink and get a new code. */
    StartOver: 'start-over',
} as const;
/** Outcome kinds derive from their runtime mapping. */
export type ConnectorLinkOutcomeKind =
    (typeof ConnectorLinkOutcomeKind)[keyof typeof ConnectorLinkOutcomeKind];

/** A verified, saved account link. */
export interface ConnectorLinkLinked {
    readonly kind: typeof ConnectorLinkOutcomeKind.Linked;
    readonly completed: ConnectorPairCompleted;
}
/** The screen closed without a new link. */
export interface ConnectorLinkUnfinished {
    readonly kind:
        | typeof ConnectorLinkOutcomeKind.Later
        | typeof ConnectorLinkOutcomeKind.Canceled
        | typeof ConnectorLinkOutcomeKind.StartOver;
}
/** Every way the linking screen can end. */
export type ConnectorLinkOutcome = ConnectorLinkLinked | ConnectorLinkUnfinished;

/** Runs one verified pairing attempt with the same contract as `ConnectorPairClient.run`. */
export type ConnectorLinkRunner = (
    signal: AbortSignal,
    intent: ConnectorPairIntent,
    observe: (event: ConnectorPairEvent) => void,
    progress: ConnectorStartupObserver,
) => Promise<void>;

/** Everything the linking screen needs from its owner. */
export interface ConnectorLinkOptions {
    readonly questions: ConnectorPermissionQuestions;
    readonly signal: AbortSignal;
    /** The name this computer registers with. */
    readonly computerName: string;
    /** Present when linking is part of first-run setup. */
    readonly step?: ConnectorPromptStep;
    readonly pair: ConnectorLinkRunner;
    /**
     * Applies choices made earlier in this session once the link exists.
     *
     * @returns Short lines for the success screen
     */
    readonly afterLink: (completed: ConnectorPairCompleted) => Promise<readonly string[]>;
    /** How long the success screen stays up before continuing on its own. */
    readonly successPauseMs?: number;
}

/** Mutable facts gathered while one pairing attempt runs. */
interface ConnectorLinkAttempt {
    completed: ConnectorPairCompleted | null;
    error: unknown;
}

/** The "Link to your Nerva account" screen: shows the code, waits for approval, explains failures and retries. */
export class ConnectorLinkStep {
    static readonly #title: string = 'Link to your Nerva account';
    static readonly #hint: string = 'Esc link later · Ctrl+C quit';
    readonly #options: ConnectorLinkOptions;
    #code: string | null = null;
    #link: string = 'https://nervalabs.com/chat/connectors';
    #expiresAtMs: bigint | null = null;
    #stage: ConnectorStartupStage | null = null;
    #httpStatus: number | null = null;
    #event: ConnectorPairEventKind | null = null;
    #retryUntil: number | null = null;
    #retryReason: ConnectorFailureReason | null = null;
    #codeShown: boolean = false;
    #panel: (() => ConnectorPromptPanel) | null = null;

    private constructor(options: ConnectorLinkOptions) {
        this.#options = options;
    }

    /** Runs the linking screen until the computer is linked or the person leaves it. */
    public static async run(options: ConnectorLinkOptions): Promise<ConnectorLinkOutcome> {
        return await new ConnectorLinkStep(options).#run();
    }

    async #run(): Promise<ConnectorLinkOutcome> {
        const ticker: NodeJS.Timeout = setInterval((): void => {
            if (this.#panel !== null) {
                this.#options.questions.show(this.#panel());
            }
        }, 1000);
        ticker.unref();
        try {
            let intent: ConnectorPairIntent = ConnectorPairIntent.Resume;
            let retries: number = 0;
            for (;;) {
                const attempt: ConnectorLinkAttempt = { completed: null, error: null };
                const action: ConnectorPromptResult = await this.#attempt(intent, attempt);
                if (attempt.completed !== null) {
                    return await this.#finish(attempt.completed);
                }
                if (action.action === ConnectorPromptAction.Back) {
                    return { kind: ConnectorLinkOutcomeKind.Later };
                }
                if (
                    action.action === ConnectorPromptAction.Cancel ||
                    this.#options.signal.aborted
                ) {
                    return { kind: ConnectorLinkOutcomeKind.Canceled };
                }
                const reason: ConnectorFailureReason = ConnectorFailure.classify({
                    error: attempt.error,
                    stage: this.#stage,
                    httpStatus: this.#httpStatus,
                    event: this.#event,
                    codeShown: this.#codeShown,
                });
                retries = reason.recovery === ConnectorFailureRecovery.Automatic ? retries + 1 : 0;
                const next: ConnectorPromptResult = await this.#failure(reason, retries);
                if (next.action === ConnectorPromptAction.Back) {
                    return { kind: ConnectorLinkOutcomeKind.Later };
                }
                if (next.action === ConnectorPromptAction.Cancel || this.#options.signal.aborted) {
                    return { kind: ConnectorLinkOutcomeKind.Canceled };
                }
                if (reason.recovery === ConnectorFailureRecovery.StartOver) {
                    return { kind: ConnectorLinkOutcomeKind.StartOver };
                }
                intent =
                    reason.recovery === ConnectorFailureRecovery.NewCode
                        ? ConnectorPairIntent.RenewExpired
                        : ConnectorPairIntent.Resume;
            }
        } finally {
            clearInterval(ticker);
            this.#panel = null;
        }
    }

    async #attempt(
        intent: ConnectorPairIntent,
        attempt: ConnectorLinkAttempt,
    ): Promise<ConnectorPromptResult> {
        this.#code = null;
        this.#expiresAtMs = null;
        this.#stage = null;
        this.#httpStatus = null;
        this.#event = null;
        this.#retryUntil = null;
        this.#retryReason = null;
        this.#codeShown = false;
        this.#show((): ConnectorPromptPanel => this.#waiting());
        const work: AbortController = new AbortController();
        const done: AbortController = new AbortController();
        const running: Promise<void> = this.#pair(
            AbortSignal.any([this.#options.signal, work.signal]),
            intent,
            attempt,
            done,
        );
        const action: ConnectorPromptResult = await this.#options.questions.wait(
            {
                kind: ConnectorPromptKind.Wait,
                id: 'link-wait',
                label: 'Linking',
                hint: ConnectorLinkStep.#hint,
            },
            done.signal,
        );
        if (action.action !== ConnectorPromptAction.Submit) {
            work.abort();
        }
        await running;
        return action;
    }

    async #pair(
        signal: AbortSignal,
        intent: ConnectorPairIntent,
        attempt: ConnectorLinkAttempt,
        done: AbortController,
    ): Promise<void> {
        try {
            await this.#options.pair(
                signal,
                intent,
                (event: ConnectorPairEvent): void => {
                    if (event.state === ConnectorPairEventKind.Paired) {
                        attempt.completed = event;
                    } else if (event.state === ConnectorPairEventKind.Waiting) {
                        this.#code = event.code;
                        this.#link = event.verificationUri;
                        this.#expiresAtMs = event.expiresAtMs;
                        this.#codeShown = true;
                    } else if (event.state !== ConnectorPairEventKind.Reconnecting) {
                        this.#event = event.state;
                    }
                    this.#refresh();
                },
                (progress: ConnectorStartupProgress): void => {
                    this.#progress(progress);
                    this.#refresh();
                },
            );
        } catch (caught: unknown) {
            attempt.error = caught;
        } finally {
            done.abort();
        }
    }

    #progress(progress: ConnectorStartupProgress): void {
        if (progress.stage === ConnectorStartupStage.Retry) {
            this.#retryUntil = performance.now() + Math.max(0, progress.retryAfterMs ?? 0);
            this.#retryReason = ConnectorFailure.retrying(this.#stage, this.#httpStatus);
        } else if (
            progress.stage !== ConnectorStartupStage.Closing &&
            progress.stage !== ConnectorStartupStage.Ready &&
            progress.stage !== ConnectorStartupStage.Stopped
        ) {
            this.#stage = progress.stage;
            this.#httpStatus = progress.httpStatus ?? null;
            if (progress.stage !== ConnectorStartupStage.Approval) {
                this.#retryUntil = null;
                this.#retryReason = null;
            }
        }
    }

    #waiting(): ConnectorPromptPanel {
        const code: string | null = this.#code;
        return {
            context: 'Link',
            title: ConnectorLinkStep.#title,
            description:
                code === null
                    ? ['This lets Nexa use “' + this.#options.computerName + '”.']
                    : [
                          '1. Open the page below and sign in to Nerva.',
                          '2. Type the code and approve “' + this.#options.computerName + '”.',
                      ],
            ...(this.#options.step === undefined ? {} : { step: this.#options.step }),
            ...(code === null
                ? {}
                : { link: this.#link, code, caption: 'Code ' + code + ' · ' + this.#expiry() }),
            status: this.#status(),
            hint: ConnectorLinkStep.#hint,
        };
    }

    #status(): ConnectorPromptStatus {
        const remaining: number | null = this.#remaining(this.#retryUntil);
        if (remaining !== null && this.#retryReason !== null) {
            return {
                text:
                    this.#retryReason.title +
                    '. ' +
                    this.#retryReason.detail +
                    ' Retrying in ' +
                    remaining.toString() +
                    's…',
                tone: ConnectorPromptTone.Warning,
                busy: true,
            };
        }
        const stage: ConnectorStartupStage | null = this.#stage;
        return {
            text:
                stage === ConnectorStartupStage.Saving
                    ? 'Approved. Finishing up…'
                    : this.#code !== null
                      ? 'Waiting for you to approve this computer…'
                      : stage === ConnectorStartupStage.PairingRequest
                        ? 'Getting your code…'
                        : stage === null ||
                            stage === ConnectorStartupStage.LocalSecurity ||
                            stage === ConnectorStartupStage.Configuration ||
                            stage === ConnectorStartupStage.Identity ||
                            stage === ConnectorStartupStage.PairingState
                          ? 'Getting ready…'
                          : 'Connecting to Nerva…',
            tone: ConnectorPromptTone.Neutral,
            busy: true,
        };
    }

    #expiry(): string {
        const expires: bigint | null = this.#expiresAtMs;
        const left: bigint = expires === null ? 0n : expires - BigInt(Date.now());
        if (left <= 0n) {
            return 'expired';
        }
        const seconds: number = Number(left > 600000n ? 600n : left / 1000n);
        return (
            'expires in ' +
            Math.floor(seconds / 60).toString() +
            ':' +
            (seconds % 60).toString().padStart(2, '0')
        );
    }

    async #failure(
        reason: ConnectorFailureReason,
        retries: number,
    ): Promise<ConnectorPromptResult> {
        const automatic: boolean = reason.recovery === ConnectorFailureRecovery.Automatic;
        const delay: number = ConnectorFailure.backoffMs(retries);
        const until: number = performance.now() + delay;
        this.#show((): ConnectorPromptPanel => ({
            context: 'Link',
            title: reason.title,
            description: [reason.detail],
            tone: automatic ? ConnectorPromptTone.Warning : ConnectorPromptTone.Error,
            ...(this.#options.step === undefined ? {} : { step: this.#options.step }),
            ...(automatic
                ? {
                      status: {
                          text: 'Retrying in ' + (this.#remaining(until) ?? 0).toString() + 's…',
                          tone: ConnectorPromptTone.Warning,
                          busy: true,
                      },
                  }
                : {}),
        }));
        return await this.#options.questions.confirm(
            {
                kind: ConnectorPromptKind.Confirm,
                id: 'link-retry',
                label:
                    reason.recovery === ConnectorFailureRecovery.NewCode
                        ? 'Get a new code'
                        : reason.recovery === ConnectorFailureRecovery.StartOver
                          ? 'Start over'
                          : automatic
                            ? 'Try again now'
                            : 'Try again',
                hint: 'Enter continue · ' + ConnectorLinkStep.#hint,
            },
            automatic ? AbortSignal.timeout(delay) : undefined,
        );
    }

    async #finish(completed: ConnectorPairCompleted): Promise<ConnectorLinkOutcome> {
        this.#show((): ConnectorPromptPanel =>
            this.#linked(
                { text: 'Finishing setup…', tone: ConnectorPromptTone.Neutral, busy: true },
                [],
            ),
        );
        this.#panel = null;
        let lines: readonly string[];
        try {
            lines = await this.#options.afterLink(completed);
        } catch {
            if (this.#options.signal.aborted) {
                return { kind: ConnectorLinkOutcomeKind.Canceled };
            }
            lines = ["Some setup choices couldn't be applied. Use /settings to try again."];
        }
        this.#show((): ConnectorPromptPanel =>
            this.#linked(
                { text: 'All set.', tone: ConnectorPromptTone.Success, busy: false },
                lines,
            ),
        );
        this.#panel = null;
        await this.#options.questions.confirm(
            {
                kind: ConnectorPromptKind.Confirm,
                id: 'link-done',
                label: 'Continue',
                hint: 'Enter continue',
            },
            AbortSignal.any([
                this.#options.signal,
                AbortSignal.timeout(this.#options.successPauseMs ?? 2500),
            ]),
        );
        return { kind: ConnectorLinkOutcomeKind.Linked, completed };
    }

    #linked(status: ConnectorPromptStatus, lines: readonly string[]): ConnectorPromptPanel {
        return {
            context: 'Link',
            title: "You're connected!",
            tone: ConnectorPromptTone.Success,
            description: [
                '“' +
                    this.#options.computerName +
                    '” is linked to your Nerva account. Nexa can use it while this window is open.',
                ...lines,
            ],
            ...(this.#options.step === undefined ? {} : { step: this.#options.step }),
            status,
        };
    }

    #show(panel: () => ConnectorPromptPanel): void {
        this.#panel = panel;
        this.#options.questions.show(panel());
    }

    #refresh(): void {
        if (this.#panel !== null) {
            this.#options.questions.show(this.#panel());
        }
    }

    #remaining(until: number | null): number | null {
        if (until === null) {
            return null;
        }
        const left: number = until - performance.now();
        return left <= 0 ? null : Math.ceil(left / 1000);
    }
}
