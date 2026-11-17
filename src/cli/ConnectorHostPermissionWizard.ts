// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

import { realpath } from 'node:fs/promises';
import { ConnectorHostGrant } from '../runtime/ConnectorHostGrant.js';
import { type ConnectorHostLocalGrant } from '../runtime/ConnectorHostGrantTypes.js';
import {
    ConnectorClientConfiguration,
    type ConnectorClientIdentity,
} from '../runtime/ConnectorClientConfiguration.js';
import type { ConnectorPermissionQuestions } from './ConnectorPermissionPrompt.js';
import { ConnectorSetupWizard } from './ConnectorSetupWizard.js';
import {
    ConnectorApproval,
    ConnectorPromptAction,
    ConnectorPromptKind,
    ConnectorPromptTone,
    type ConnectorPromptResult,
} from './ConnectorPromptTypes.js';

/** Full computer approval names the enrolled device and task folder; it is signed by the device key and kept apart from setup preferences. */
export class ConnectorHostPermissionWizard {
    /**
     * Asks whether to turn on full computer access; the selection starts on "Not now".
     *
     * @returns Whether access was turned on
     */
    public static async run(
        configurationFile: string,
        directory: string,
        questions: ConnectorPermissionQuestions,
        signal: AbortSignal,
        beforeActivate?: () => Promise<void>,
    ): Promise<boolean> {
        const tasks: string = await realpath(directory);
        questions.show({
            title: 'Turn on full computer access?',
            description: [
                'You chose this during setup. Nexa needs your OK once more to turn it on.',
            ],
            details: [{ label: 'Task folder', value: tasks }],
        });
        const answer: ConnectorPromptResult = await questions.select({
            kind: ConnectorPromptKind.Select,
            id: 'host-allow',
            label: 'Full computer access',
            initialValue: ConnectorApproval.NotNow,
            hint: '↑↓ choose · Enter confirm · Esc not now',
            choices: [
                {
                    value: ConnectorApproval.NotNow,
                    label: 'Not now',
                    description:
                        "This computer stays linked. Nexa can't use its programs or files.",
                },
                {
                    value: ConnectorApproval.Allow,
                    label: 'Turn on full computer access',
                    description: ConnectorSetupWizard.fullComputerWarning(),
                    caution: true,
                },
            ],
        });
        if (
            answer.action !== ConnectorPromptAction.Submit ||
            answer.value !== ConnectorApproval.Allow
        ) {
            return false;
        }
        signal.throwIfAborted();
        questions.show({
            title: 'Turning on full computer access…',
            description: [],
            status: {
                text: 'Signing the approval on this computer…',
                tone: ConnectorPromptTone.Neutral,
                busy: true,
            },
        });
        await beforeActivate?.();
        await this.enable(configurationFile, tasks, signal);
        return true;
    }

    /** Signs and saves an enabled grant after an explicit choice made earlier in this session. */
    public static async enable(
        configurationFile: string,
        directory: string,
        signal: AbortSignal,
    ): Promise<void> {
        const identity: ConnectorClientIdentity =
            await ConnectorClientConfiguration.load(configurationFile);
        using resources: DisposableStack = new DisposableStack();
        resources.use(identity.key);
        await ConnectorHostGrant.install(identity, directory, true, signal);
    }

    /** Reconnects reuse existing exact consent without prompting or changing its revision. */
    public static async matches(configurationFile: string, directory: string): Promise<boolean> {
        const grant: ConnectorHostLocalGrant | null = await this.#read(configurationFile);
        return (
            grant?.profile.enabled === true &&
            grant.journalInitialized &&
            grant.profile.directory === (await realpath(directory))
        );
    }

    /** Whether a signed, enabled full computer grant exists for this device. */
    public static async enabled(configurationFile: string): Promise<boolean> {
        return (await this.#read(configurationFile))?.profile.enabled === true;
    }

    /** Whether the person turned full computer access off; that choice is respected without asking again. */
    public static async turnedOff(configurationFile: string): Promise<boolean> {
        return (await this.#read(configurationFile))?.profile.enabled === false;
    }

    /**
     * Turning access off stops the runtime first and keeps operation history; the selection starts on "Keep it on".
     *
     * @returns Whether access was turned off
     */
    public static async disable(
        configurationFile: string,
        questions: ConnectorPermissionQuestions,
        signal: AbortSignal,
        beforeActivate: () => Promise<void>,
    ): Promise<boolean> {
        const identity: ConnectorClientIdentity =
            await ConnectorClientConfiguration.load(configurationFile);
        using resources: DisposableStack = new DisposableStack();
        resources.use(identity.key);
        const grant: ConnectorHostLocalGrant | null = await ConnectorHostGrant.read(identity);
        if (grant?.profile.enabled !== true) {
            return false;
        }
        questions.show({
            title: 'Turn off full computer access?',
            description: [
                'Programs Nexa started here will stop. Your files, link and history stay as they are.',
            ],
        });
        const answer: ConnectorPromptResult = await questions.select({
            kind: ConnectorPromptKind.Select,
            id: 'host-disable',
            label: 'Full computer access',
            initialValue: ConnectorApproval.Keep,
            hint: '↑↓ choose · Enter confirm · Esc cancel',
            choices: [
                {
                    value: ConnectorApproval.Keep,
                    label: 'Keep it on',
                    description: 'Nothing changes.',
                },
                {
                    value: ConnectorApproval.TurnOff,
                    label: 'Turn it off',
                    description: "Nexa won't be able to use this computer's programs or files.",
                },
            ],
        });
        if (
            answer.action !== ConnectorPromptAction.Submit ||
            answer.value !== ConnectorApproval.TurnOff
        ) {
            return false;
        }
        signal.throwIfAborted();
        questions.show({
            title: 'Turning off full computer access…',
            description: [],
            status: {
                text: 'Stopping programs Nexa started…',
                tone: ConnectorPromptTone.Neutral,
                busy: true,
            },
        });
        await beforeActivate();
        await ConnectorHostGrant.install(identity, grant.profile.directory, false, signal);
        return true;
    }

    static async #read(configurationFile: string): Promise<ConnectorHostLocalGrant | null> {
        const identity: ConnectorClientIdentity =
            await ConnectorClientConfiguration.load(configurationFile);
        using resources: DisposableStack = new DisposableStack();
        resources.use(identity.key);
        return await ConnectorHostGrant.read(identity);
    }
}
