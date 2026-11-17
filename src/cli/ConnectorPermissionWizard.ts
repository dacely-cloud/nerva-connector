// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

import { homedir } from 'node:os';
import { join } from 'node:path';
import { ConnectorFileMode } from 'nerva-connector-protocol/protocol/ConnectorFiles.js';
import {
    ConnectorFileGrant,
    type ConnectorFileApproval,
    type ConnectorFileGrantContext,
} from '../permissions/ConnectorFileGrant.js';
import { ConnectorPermissionError } from '../permissions/ConnectorPermissionError.js';
import type { ConnectorPermissionQuestions } from './ConnectorPermissionPrompt.js';
import {
    ConnectorApproval,
    ConnectorPromptAction,
    ConnectorPromptKind,
    ConnectorPromptTone,
    type ConnectorPromptPanel,
    type ConnectorPromptResult,
} from './ConnectorPromptTypes.js';

/** Canceling, prerequisite failure and successful installation have distinct UI outcomes. */
export const ConnectorPermissionOutcome = {
    Canceled: 'canceled',
    Unavailable: 'unavailable',
    Installed: 'installed',
} as const;
/** Outcome values derive from their runtime mapping. */
export type ConnectorPermissionOutcome =
    (typeof ConnectorPermissionOutcome)[keyof typeof ConnectorPermissionOutcome];
/** Human-readable completion contains no policy bytes or private identity. */
export interface ConnectorPermissionResult {
    readonly outcome: ConnectorPermissionOutcome;
    readonly message: string;
}
/** A folder and mode chosen in setup; `consented` means the person confirmed that choice earlier in this session. */
export interface ConnectorPermissionDefaults {
    readonly directory: string;
    readonly mode: ConnectorFileMode;
    readonly consented: boolean;
}

/** Folder sharing: choose a folder, choose read or read-and-change, then explicitly allow it. */
export class ConnectorPermissionWizard {
    /** Native preparation starts only after an explicit Allow (or this session's setup choice) and the caller's runtime shutdown. */
    public static async run(
        directory: string,
        questions: ConnectorPermissionQuestions,
        signal: AbortSignal,
        beforeInstall?: () => Promise<void>,
        defaults?: ConnectorPermissionDefaults,
    ): Promise<ConnectorPermissionResult> {
        let approved: boolean = false;
        try {
            const context: ConnectorFileGrantContext = await ConnectorFileGrant.inspect(
                directory,
                signal,
            );
            let approval: ConnectorFileApproval | null = context.retained;
            let folder: string = context.retained?.path ?? defaults?.directory ?? '';
            let mode: ConnectorFileMode =
                context.retained?.mode ?? defaults?.mode ?? ConnectorFileMode.ReadOnly;
            let step: number = approval === null ? 0 : 2;
            let error: string | null = null;
            if (approval === null && defaults?.consented === true) {
                try {
                    approval = await ConnectorFileGrant.review(context, this.#path(folder), mode);
                    approved = true;
                } catch {
                    error = "That folder can't be shared. Choose another one.";
                }
            }
            while (!approved) {
                questions.show(this.#panel(step, error, mode, approval, context.retained !== null));
                const result: ConnectorPromptResult = await this.#ask(
                    questions,
                    step,
                    folder,
                    mode,
                );
                if (result.action === ConnectorPromptAction.Cancel) {
                    return this.#cancel();
                }
                if (result.action === ConnectorPromptAction.Back) {
                    if (step === 0 || context.retained !== null) {
                        return this.#cancel();
                    }
                    step -= 1;
                    error = null;
                    continue;
                }
                if (step === 2) {
                    if (result.value !== ConnectorApproval.Allow || approval === null) {
                        return this.#cancel();
                    }
                    approved = true;
                    break;
                }
                try {
                    if (step === 0) {
                        folder = result.value;
                    } else {
                        const checked: ConnectorFileMode | undefined = Object.values(
                            ConnectorFileMode,
                        ).find(
                            (candidate: ConnectorFileMode): boolean =>
                                candidate.toString() === result.value,
                        );
                        if (checked === undefined) {
                            throw new Error('Invalid folder access');
                        }
                        mode = checked;
                    }
                    approval = await ConnectorFileGrant.review(context, this.#path(folder), mode);
                    folder = approval.path;
                    step += 1;
                    error = null;
                } catch {
                    error =
                        "That folder can't be shared. Choose an existing folder outside the connector's own files.";
                    step = 0;
                }
            }
            if (approval === null) {
                return this.#cancel();
            }
            signal.throwIfAborted();
            questions.show({
                title: 'Setting up folder access…',
                description: [],
                status: {
                    text: 'Keep the connector open.',
                    tone: ConnectorPromptTone.Neutral,
                    busy: true,
                },
            });
            await beforeInstall?.();
            await ConnectorFileGrant.approve(context, approval, signal);
            const message: string =
                (approval.mode === ConnectorFileMode.ReadOnly
                    ? 'Nexa can now read files in '
                    : 'Nexa can now read and change files in ') +
                approval.path +
                '.';
            questions.show({
                title: 'Folder access is on',
                tone: ConnectorPromptTone.Success,
                description: [message],
            });
            return { outcome: ConnectorPermissionOutcome.Installed, message };
        } catch (caught: unknown) {
            if (signal.aborted && !approved) {
                return this.#cancel();
            }
            const message: string =
                caught instanceof ConnectorPermissionError
                    ? caught.message
                    : approved
                      ? 'Folder access setup was interrupted, so it may already be on. Try again with the same folder and access.'
                      : "Couldn't check folder access. Nothing was changed.";
            questions.show({
                title: "Folder access isn't available",
                tone: ConnectorPromptTone.Error,
                description: [message],
            });
            return { outcome: ConnectorPermissionOutcome.Unavailable, message };
        }
    }

    static async #ask(
        questions: ConnectorPermissionQuestions,
        step: number,
        folder: string,
        mode: ConnectorFileMode,
    ): Promise<ConnectorPromptResult> {
        if (step === 0) {
            return await questions.text({
                kind: ConnectorPromptKind.Text,
                id: 'files-directory',
                label: 'Folder',
                initialValue: folder,
                hint: 'Enter continue · Ctrl+U clear · Esc cancel',
                maximumLength: 32768,
            });
        }
        if (step === 1) {
            return await questions.select({
                kind: ConnectorPromptKind.Select,
                id: 'files-access',
                label: 'Folder access',
                initialValue: mode,
                hint: '↑↓ choose · Enter continue · Esc back',
                choices: [
                    {
                        value: ConnectorFileMode.ReadOnly,
                        label: 'Read only',
                        description: 'Nexa can open files here, but not change them.',
                    },
                    {
                        value: ConnectorFileMode.ReadWrite,
                        label: 'Read and change',
                        description: 'Nexa can read, create, change and delete files here.',
                    },
                ],
            });
        }
        return await questions.select({
            kind: ConnectorPromptKind.Select,
            id: 'files-allow',
            label: 'Folder access',
            initialValue: ConnectorApproval.NotNow,
            hint: '↑↓ choose · Enter confirm · Esc cancel',
            choices: [
                {
                    value: ConnectorApproval.NotNow,
                    label: 'Not now',
                    description: 'Nothing is shared.',
                },
                {
                    value: ConnectorApproval.Allow,
                    label: 'Allow access',
                    description: 'Nexa can use this folder as shown above.',
                },
            ],
        });
    }

    static #panel(
        step: number,
        error: string | null,
        mode: ConnectorFileMode,
        approval: ConnectorFileApproval | null,
        retained: boolean,
    ): ConnectorPromptPanel {
        const status: Pick<ConnectorPromptPanel, 'status'> =
            error === null
                ? {}
                : { status: { text: error, tone: ConnectorPromptTone.Warning, busy: false } };
        const progress: Pick<ConnectorPromptPanel, 'step'> = retained
            ? {}
            : { step: { current: step + 1, total: 3 } };
        if (step === 0) {
            return {
                title: 'Choose a folder to share',
                description: ['Nexa can only use files inside this folder.'],
                ...progress,
                ...status,
            };
        }
        if (step === 1) {
            return {
                title: 'What can Nexa do in this folder?',
                description: ['Pick the least access Nexa needs.'],
                ...progress,
                ...status,
            };
        }
        return {
            title: retained ? 'Finish setting up folder access' : 'Allow access to this folder?',
            description: [
                retained
                    ? 'Your earlier approval is saved. Allow it again to finish.'
                    : "Nexa can use only this folder. It can't run programs.",
                ...(mode === ConnectorFileMode.ReadWrite
                    ? ['Uploads briefly use extra disk space next to this folder.']
                    : []),
            ],
            ...(approval === null
                ? {}
                : {
                      details: [
                          { label: 'Folder', value: approval.path },
                          {
                              label: 'Access',
                              value:
                                  approval.mode === ConnectorFileMode.ReadOnly
                                      ? 'Read only'
                                      : 'Read and change',
                          },
                          { label: 'Programs', value: 'Not allowed' },
                      ],
                  }),
            ...progress,
            ...status,
        };
    }

    static #path(value: string): string {
        return value === '~'
            ? homedir()
            : value.startsWith('~/')
              ? join(homedir(), value.slice(2))
              : value;
    }
    static #cancel(): ConnectorPermissionResult {
        return {
            outcome: ConnectorPermissionOutcome.Canceled,
            message: "Folder access wasn't changed.",
        };
    }
}
