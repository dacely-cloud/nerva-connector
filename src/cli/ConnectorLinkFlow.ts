// SPDX-FileCopyrightText: 2026 Dacely <business@dacely.com>
// SPDX-License-Identifier: LicenseRef-Proprietary

import {
    ConnectorPairClient,
    type ConnectorPairCompleted,
    type ConnectorPairEvent,
    type ConnectorPairIntent,
} from '../runtime/ConnectorPairClient.js';
import { ConnectorLogout } from '../runtime/ConnectorLogout.js';
import {
    ConnectorStartupStage,
    type ConnectorStartupObserver,
} from '../runtime/ConnectorStartup.js';
import { ConnectorAccessSetup } from './ConnectorAccessSetup.js';
import { ConnectorFailure, type ConnectorFailureReason } from './ConnectorFailure.js';
import type { ConnectorConsoleLocation } from './ConnectorConsoleLocation.js';
import {
    ConnectorLinkOutcomeKind,
    ConnectorLinkStep,
    type ConnectorLinkOutcome,
} from './ConnectorLinkStep.js';
import type { ConnectorPermissionQuestions } from './ConnectorPermissionPrompt.js';
import type { ConnectorSetupSession } from './ConnectorSetupSession.js';
import {
    ConnectorPromptKind,
    ConnectorPromptTone,
    type ConnectorPromptStep,
} from './ConnectorPromptTypes.js';

/** Connects the linking screen to the real pairing client, setup choices and the start-over path. */
export class ConnectorLinkFlow {
    /** The flow reads the console's location and this session's setup choices. */
    public constructor(
        public readonly location: ConnectorConsoleLocation,
        public readonly setup: ConnectorSetupSession,
    ) {}

    /**
     * Shows the linking screen until the computer is linked or the person leaves it.
     *
     * @remarks
     * A declined or removed link can be started over: the old identity is unlinked with a
     * device-signed request and a fresh code is shown.
     */
    public async run(
        questions: ConnectorPermissionQuestions,
        signal: AbortSignal,
        computerName: string,
        step: ConnectorPromptStep | undefined,
    ): Promise<ConnectorLinkOutcome> {
        for (;;) {
            const outcome: ConnectorLinkOutcome = await ConnectorLinkStep.run({
                questions,
                signal,
                computerName,
                ...(step === undefined ? {} : { step }),
                pair: async (
                    attempt: AbortSignal,
                    intent: ConnectorPairIntent,
                    observe: (event: ConnectorPairEvent) => void,
                    progress: ConnectorStartupObserver,
                ): Promise<void> => {
                    progress({ stage: ConnectorStartupStage.LocalSecurity });
                    await ConnectorPairClient.run(
                        await this.location.pairingFile(attempt, this.setup),
                        attempt,
                        observe,
                        intent,
                        progress,
                    );
                },
                afterLink: async (completed: ConnectorPairCompleted): Promise<readonly string[]> =>
                    await ConnectorAccessSetup.apply(this.setup, {
                        configurationFile: completed.configurationFile,
                        installationDirectory: await this.location.directory(),
                        questions,
                        signal,
                    }),
            });
            if (outcome.kind !== ConnectorLinkOutcomeKind.StartOver) {
                return outcome;
            }
            if (!(await this.#startOver(questions, signal))) {
                return { kind: ConnectorLinkOutcomeKind.Later };
            }
        }
    }

    async #startOver(
        questions: ConnectorPermissionQuestions,
        signal: AbortSignal,
    ): Promise<boolean> {
        questions.show({
            title: 'Starting over…',
            description: ['Unlinking this computer so it can get a new code.'],
            status: { text: 'Contacting Nerva…', tone: ConnectorPromptTone.Neutral, busy: true },
        });
        try {
            await ConnectorLogout.run(await this.location.pairingFile(signal, this.setup), signal);
            return true;
        } catch (caught: unknown) {
            signal.throwIfAborted();
            const reason: ConnectorFailureReason = ConnectorFailure.classify({
                error: caught,
                stage: null,
                httpStatus: null,
                event: null,
                codeShown: false,
            });
            questions.show({
                title: "Couldn't start over",
                tone: ConnectorPromptTone.Error,
                description: [reason.title + '. ' + reason.detail],
            });
            await questions.confirm({
                kind: ConnectorPromptKind.Confirm,
                id: 'link-start-over-failed',
                label: 'Back to the console',
                hint: 'Enter continue',
            });
            return false;
        }
    }
}
