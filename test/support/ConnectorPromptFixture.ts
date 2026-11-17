// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

import type { ConnectorPermissionQuestions } from '../../src/cli/ConnectorPermissionPrompt.js';
import {
    ConnectorPromptAction,
    type ConnectorPromptConfirm,
    type ConnectorPromptResult,
    type ConnectorPromptPanel,
    type ConnectorPromptText,
    type ConnectorPromptSelect,
    type ConnectorPromptWait,
} from '../../src/cli/ConnectorPromptTypes.js';

/** Explicit results distinguish cleared text, backward navigation and canceled human input. */
export type ConnectorPromptFixtureAnswer = string | ConnectorPromptResult | null;

/** Scripted human actions drive the current structured screens without replacing persistence or grant authority. */
export class ConnectorPromptFixture implements ConnectorPermissionQuestions {
    readonly #answers: readonly ConnectorPromptFixtureAnswer[];
    #index: number = 0;
    /** Every structured display remains available for review-copy and authority assertions. */
    public readonly panels: ConnectorPromptPanel[] = [];
    /** Text requests expose exact defaults without parsing English prompts. */
    public readonly texts: ConnectorPromptText[] = [];
    /** Select requests expose the actual finite values and their initial selection. */
    public readonly selections: ConnectorPromptSelect[] = [];
    /** Confirmation requests expose their action labels. */
    public readonly confirms: ConnectorPromptConfirm[] = [];
    /** Waiting controls shown while work ran. */
    public readonly waits: ConnectorPromptWait[] = [];
    /** Answers are copied so concurrent test code cannot silently change an approval. */
    public constructor(answers: readonly ConnectorPromptFixtureAnswer[]) {
        this.#answers = [...answers];
    }
    #answer(initialValue: string): ConnectorPromptResult {
        const answer: ConnectorPromptFixtureAnswer | undefined = this.#answers[this.#index++];
        if (answer === null || answer === undefined) {
            return { action: ConnectorPromptAction.Cancel };
        }
        return typeof answer === 'string'
            ? { action: ConnectorPromptAction.Submit, value: answer === '' ? initialValue : answer }
            : answer;
    }
    /** Enter submits the current prefilled value. */
    public text(question: ConnectorPromptText): Promise<ConnectorPromptResult> {
        this.texts.push(question);
        return Promise.resolve(this.#answer(question.initialValue));
    }
    /** Native keyboard choices and scripted choices return the same finite selected value. */
    public select(question: ConnectorPromptSelect): Promise<ConnectorPromptResult> {
        this.selections.push(question);
        return Promise.resolve(this.#answer(question.initialValue));
    }
    /** Consumes the next answer; once the script is exhausted, an auto-continuing screen waits for its release. */
    public async confirm(
        question: ConnectorPromptConfirm,
        release?: AbortSignal,
    ): Promise<ConnectorPromptResult> {
        this.confirms.push(question);
        if (this.#index >= this.#answers.length && release !== undefined) {
            await this.#released(release);
            return { action: ConnectorPromptAction.Submit, value: '' };
        }
        return this.#answer('');
    }
    /** Only an explicit scripted Back or Cancel interrupts waiting work; otherwise the work's completion releases it. */
    public async wait(
        question: ConnectorPromptWait,
        release: AbortSignal,
    ): Promise<ConnectorPromptResult> {
        this.waits.push(question);
        const next: ConnectorPromptFixtureAnswer | undefined = this.#answers[this.#index];
        if (
            typeof next === 'object' &&
            next !== null &&
            next.action !== ConnectorPromptAction.Submit
        ) {
            this.#index++;
            return next;
        }
        await this.#released(release);
        return { action: ConnectorPromptAction.Submit, value: '' };
    }
    /** Structured panels are captured as data rather than reconstructed from output escape sequences. */
    public show(panel: ConnectorPromptPanel): void {
        this.panels.push(panel);
    }
    /** Reviewed values are rendered only for assertions about human-readable copy. */
    public get output(): string {
        return this.panels
            .map((panel: ConnectorPromptPanel): string =>
                [
                    panel.title,
                    ...panel.description,
                    ...(panel.details ?? []).map(
                        (detail): string => detail.label + ': ' + detail.value,
                    ),
                    ...(panel.code === undefined ? [] : [panel.code]),
                    ...(panel.status === undefined ? [] : [panel.status.text]),
                ].join('\n'),
            )
            .join('\n');
    }
    async #released(signal: AbortSignal): Promise<void> {
        if (signal.aborted) {
            return;
        }
        const done: PromiseWithResolvers<undefined> = Promise.withResolvers<undefined>();
        const resolve: () => void = (): void => done.resolve(undefined);
        signal.addEventListener('abort', resolve, { once: true });
        try {
            await done.promise;
        } finally {
            signal.removeEventListener('abort', resolve);
        }
    }
}
