// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

import { ConnectorHostPermissionWizard } from './ConnectorHostPermissionWizard.js';
import {
    ConnectorPermissionWizard,
    type ConnectorPermissionDefaults,
    type ConnectorPermissionResult,
} from './ConnectorPermissionWizard.js';
import type { ConnectorPermissionQuestions } from './ConnectorPermissionPrompt.js';
import type { ConnectorSetupSession } from './ConnectorSetupSession.js';
import { ConnectorPromptTone } from './ConnectorPromptTypes.js';

/** Where and how access is applied; the connection runtime must not be running. */
export interface ConnectorAccessContext {
    /** The linked computer's published device configuration. */
    readonly configurationFile: string;
    /** The connector's own installation directory, for folder access. */
    readonly installationDirectory: string;
    readonly questions: ConnectorPermissionQuestions;
    readonly signal: AbortSignal;
}

/** Applies access chosen during setup once the computer is linked, because grants are signed for the linked device. */
export class ConnectorAccessSetup {
    /** Whether `apply` has anything to do for this linked computer. */
    public static async needed(
        session: ConnectorSetupSession,
        configurationFile: string,
    ): Promise<boolean> {
        return session.pending || (await session.hostReview(configurationFile)) !== null;
    }

    /**
     * Turns on what was confirmed in this session without asking again; asks once about a saved
     * full computer choice that was never confirmed after a restart.
     *
     * @remarks
     * Failures are reported as lines rather than thrown, so a linked computer still connects.
     * Canceling the question (Ctrl+C) changes nothing and the question returns next time.
     *
     * @returns Short lines describing what changed
     */
    public static async apply(
        session: ConnectorSetupSession,
        context: ConnectorAccessContext,
    ): Promise<readonly string[]> {
        const lines: string[] = [];
        try {
            lines.push(...(await this.#host(session, context)));
        } catch {
            if (context.signal.aborted) {
                return lines;
            }
            lines.push("Full computer access couldn't be turned on. Try again with /settings.");
        }
        const files: ConnectorPermissionDefaults | null = session.takeFileConsent();
        if (files !== null && !context.signal.aborted) {
            const result: ConnectorPermissionResult = await ConnectorPermissionWizard.run(
                context.installationDirectory,
                context.questions,
                context.signal,
                undefined,
                files,
            );
            lines.push(result.message);
        }
        return lines;
    }

    static async #host(
        session: ConnectorSetupSession,
        context: ConnectorAccessContext,
    ): Promise<readonly string[]> {
        const consent: string | null = session.takeHostConsent();
        if (consent !== null) {
            if (
                !(await ConnectorHostPermissionWizard.matches(context.configurationFile, consent))
            ) {
                context.questions.show({
                    title: 'Turning on full computer access…',
                    description: [],
                    status: {
                        text: 'Signing the approval on this computer…',
                        tone: ConnectorPromptTone.Neutral,
                        busy: true,
                    },
                });
                await ConnectorHostPermissionWizard.enable(
                    context.configurationFile,
                    consent,
                    context.signal,
                );
            }
            return this.#on();
        }
        const review: string | null = await session.hostReview(context.configurationFile);
        if (review === null) {
            return [];
        }
        if (
            await ConnectorHostPermissionWizard.run(
                context.configurationFile,
                review,
                context.questions,
                context.signal,
            )
        ) {
            return this.#on();
        }
        if (context.signal.aborted) {
            return [];
        }
        await session.declineHost();
        return ['Full computer access is off. You can turn it on later with /settings.'];
    }

    static #on(): readonly string[] {
        return [
            'Full computer access is on. Turn it off anytime with /disable-host.',
            ...(process.platform === 'linux' && process.env['WAYLAND_DISPLAY'] !== undefined
                ? [
                      'The first time Nexa needs your screen, your desktop will ask which monitor to share.',
                  ]
                : []),
            ...(process.platform === 'darwin'
                ? [
                      'To let Nexa see your screen and use the mouse and keyboard, your Mac will ask once. You can also turn on Screen Recording and Accessibility for this terminal app in System Settings › Privacy & Security, then restart the connector.',
                  ]
                : []),
        ];
    }
}
