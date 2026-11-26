// SPDX-FileCopyrightText: 2026 Dacely <business@dacely.com>
// SPDX-License-Identifier: LicenseRef-Proprietary

import { ConnectorSetupCodec } from '../runtime/ConnectorSetupCodec.js';
import { ConnectorSetupStore } from '../runtime/ConnectorSetupStore.js';
import { ConnectorInstructionsCodec } from 'nerva-connector-protocol/protocol/ConnectorInstructionsCodec.js';
import { ConnectorEnrollmentCodec } from 'nerva-connector-protocol/protocol/ConnectorEnrollmentCodec.js';
import {
    ConnectorSetupAccess,
    type ConnectorSetupPreferences,
    type ConnectorSetupProfile,
} from '../runtime/ConnectorSetupProfile.js';
import type { ConnectorPermissionQuestions } from './ConnectorPermissionPrompt.js';
import { ConnectorFailure, ConnectorFailureKind } from './ConnectorFailure.js';
import {
    ConnectorPromptAction,
    ConnectorPromptKind,
    ConnectorPromptTone,
    type ConnectorPromptChoice,
    type ConnectorPromptPanel,
    type ConnectorPromptResult,
    type ConnectorPromptStep,
} from './ConnectorPromptTypes.js';

/** Terminal setup outcomes distinguish reviewed preferences from permissions actually installed by another owner. */
export interface ConnectorSetupResult {
    readonly profile: ConnectorSetupProfile | null;
    readonly canceled: boolean;
    /** Numbered question screens in the final order, so a following step can continue the count. */
    readonly steps: number;
}

/** What this computer can offer, decided before the questions are shown. */
export interface ConnectorSetupOptions {
    /** Folder access needs the signed Linux installation. */
    readonly folderAccess: boolean;
    /** Full computer access works on Windows and Linux. */
    readonly fullComputer: boolean;
    /** Full computer access is already on for this computer. */
    readonly hostEnabled: boolean;
    /** Linking to the account follows the review as the final step. */
    readonly linkStep: boolean;
    /** Starting in the background at sign-in, offered only by the installed Windows connector. */
    readonly startup: ConnectorStartupSetting | null;
}

/** Whether the connector starts in the background when the user signs in, and how to change that. */
export interface ConnectorStartupSetting {
    /** The current setting. */
    readonly enabled: boolean;
    /** Changes the setting. */
    set(enabled: boolean, signal: AbortSignal): Promise<void>;
}

/** The two answers to the startup question. */
const ConnectorStartupChoice = {
    Background: 'background',
    Manual: 'manual',
} as const;

/**
 * The screens in display order.
 *
 * @remarks
 * The welcome screen appears only on first run and is not numbered. The access question is skipped
 * when only one option exists, and the note during first run, where /settings offers it later. The
 * folder is always asked after access, because saving creates it and its wording depends on access.
 */
const ConnectorSetupQuestion = {
    Welcome: 'welcome',
    Name: 'name',
    Access: 'access',
    Folder: 'folder',
    Startup: 'startup',
    Note: 'note',
    Review: 'review',
} as const;
/** Question names derive from their runtime mapping. */
type ConnectorSetupQuestion = (typeof ConnectorSetupQuestion)[keyof typeof ConnectorSetupQuestion];

/** The answers being edited; nothing is written until the review is confirmed. */
interface ConnectorSetupDraft {
    name: string;
    tasksDirectory: string;
    access: ConnectorSetupAccess;
    localInstructions: string;
    startAtSignIn: boolean;
}

/** First-run walkthrough and /settings: welcome, name, access, folder, an optional note and a review confirmed with Enter. */
export class ConnectorSetupWizard {
    /** The access question lists only options that work here and starts on the safest one. */
    public static async run(
        directory: string,
        previous: ConnectorSetupProfile | null,
        questions: ConnectorPermissionQuestions,
        signal: AbortSignal,
        options: ConnectorSetupOptions,
    ): Promise<ConnectorSetupResult> {
        const defaults: ConnectorSetupPreferences = previous ?? ConnectorSetupCodec.defaults();
        const choices: readonly ConnectorPromptChoice[] = this.#choices(options);
        const available: (access: ConnectorSetupAccess) => boolean = (
            access: ConnectorSetupAccess,
        ): boolean =>
            choices.some((choice: ConnectorPromptChoice): boolean => choice.value === access);
        const draft: ConnectorSetupDraft = {
            name: defaults.name,
            tasksDirectory: defaults.tasksDirectory,
            access:
                options.hostEnabled && available(ConnectorSetupAccess.FullComputer)
                    ? ConnectorSetupAccess.FullComputer
                    : defaults.access !== ConnectorSetupAccess.FullComputer &&
                        available(defaults.access)
                      ? defaults.access
                      : ConnectorSetupAccess.PairingOnly,
            localInstructions: defaults.localInstructions,
            startAtSignIn: options.startup?.enabled ?? false,
        };
        const screens: readonly ConnectorSetupQuestion[] = this.#order(options, choices.length);
        const numbered: readonly ConnectorSetupQuestion[] = this.#numbered(screens);
        const total: number = numbered.length + (options.linkStep ? 1 : 0);
        let index: number = 0;
        let error: string | null = null;
        for (;;) {
            const current: ConnectorSetupQuestion = screens[index] ?? ConnectorSetupQuestion.Review;
            const step: ConnectorPromptStep | undefined =
                current === ConnectorSetupQuestion.Welcome
                    ? undefined
                    : { current: numbered.indexOf(current) + 1, total };
            questions.show(this.#panel(current, step, error, draft, options));
            const result: ConnectorPromptResult = await this.#ask(
                current,
                index === 0,
                draft,
                choices,
                questions,
                options,
            );
            if (result.action === ConnectorPromptAction.Cancel) {
                return { profile: previous, canceled: true, steps: numbered.length };
            }
            if (result.action === ConnectorPromptAction.Back) {
                if (index === 0) {
                    return { profile: previous, canceled: true, steps: numbered.length };
                }
                index -= 1;
                error = null;
                continue;
            }
            if (current === ConnectorSetupQuestion.Review) {
                signal.throwIfAborted();
                if (options.startup !== null && options.startup.enabled !== draft.startAtSignIn) {
                    try {
                        await options.startup.set(draft.startAtSignIn, signal);
                    } catch {
                        signal.throwIfAborted();
                        error =
                            "Couldn't change whether Nerva Connector starts when you sign in. Try again.";
                        continue;
                    }
                }
                try {
                    const profile: ConnectorSetupProfile = await ConnectorSetupStore.save(
                        directory,
                        {
                            name: draft.name,
                            tasksDirectory: draft.tasksDirectory,
                            access: draft.access,
                            localInstructions: draft.localInstructions,
                        },
                        previous?.revision ?? 0n,
                        signal,
                    );
                    return { profile, canceled: false, steps: numbered.length };
                } catch (caught: unknown) {
                    signal.throwIfAborted();
                    error = this.#saveError(caught);
                    continue;
                }
            }
            error =
                current === ConnectorSetupQuestion.Welcome
                    ? null
                    : this.#accept(current, result.value, draft, directory, available);
            if (error === null) {
                index += 1;
            }
        }
    }

    static #order(
        options: ConnectorSetupOptions,
        choiceCount: number,
    ): readonly ConnectorSetupQuestion[] {
        return [
            ...(options.linkStep ? [ConnectorSetupQuestion.Welcome] : []),
            ConnectorSetupQuestion.Name,
            ...(choiceCount > 1 ? [ConnectorSetupQuestion.Access] : []),
            ConnectorSetupQuestion.Folder,
            ...(options.startup === null ? [] : [ConnectorSetupQuestion.Startup]),
            ...(options.linkStep ? [] : [ConnectorSetupQuestion.Note]),
            ConnectorSetupQuestion.Review,
        ];
    }

    static #numbered(
        screens: readonly ConnectorSetupQuestion[],
    ): readonly ConnectorSetupQuestion[] {
        return screens.filter(
            (screen: ConnectorSetupQuestion): boolean => screen !== ConnectorSetupQuestion.Welcome,
        );
    }

    /** One label serves the review screen and the console's status details. */
    public static label(access: ConnectorSetupAccess): string {
        switch (access) {
            case ConnectorSetupAccess.PairingOnly:
                return 'Just connect for now';
            case ConnectorSetupAccess.FilesRead:
                return 'One folder: open files only';
            case ConnectorSetupAccess.FilesWrite:
                return 'One folder: open and change files';
            case ConnectorSetupAccess.FullComputer:
                return 'Full computer';
        }
    }

    /** The plain safety fact shown wherever full computer access is offered. */
    public static fullComputerWarning(): string {
        return (
            'Nexa can open programs, run commands and read or change files, just like your ' +
            this.#account() +
            ' account can. You can turn this off anytime with /disable-host.'
        );
    }

    static #account(): string {
        return process.platform === 'win32'
            ? 'Windows'
            : process.platform === 'darwin'
              ? 'Mac'
              : 'Linux';
    }

    static #choices(options: ConnectorSetupOptions): readonly ConnectorPromptChoice[] {
        return [
            ...(options.fullComputer
                ? [
                      {
                          value: ConnectorSetupAccess.FullComputer,
                          label: this.label(ConnectorSetupAccess.FullComputer),
                          description: this.fullComputerWarning(),
                          caution: true,
                          badge: 'Most useful',
                      },
                  ]
                : []),
            ...(options.folderAccess
                ? [
                      {
                          value: ConnectorSetupAccess.FilesWrite,
                          label: this.label(ConnectorSetupAccess.FilesWrite),
                          description:
                              'Nexa can open, create and change files in one folder you pick. Nothing outside it.',
                      },
                      {
                          value: ConnectorSetupAccess.FilesRead,
                          label: this.label(ConnectorSetupAccess.FilesRead),
                          description:
                              "Nexa can open files in one folder you pick, but it can't change anything.",
                      },
                  ]
                : []),
            {
                value: ConnectorSetupAccess.PairingOnly,
                label: this.label(ConnectorSetupAccess.PairingOnly),
                description:
                    'Nexa can see that this computer is online and what is inside it, like its processor and memory. Nothing else.',
                badge: 'Safest',
            },
        ];
    }

    static async #ask(
        question: ConnectorSetupQuestion,
        first: boolean,
        draft: ConnectorSetupDraft,
        choices: readonly ConnectorPromptChoice[],
        questions: ConnectorPermissionQuestions,
        options: ConnectorSetupOptions,
    ): Promise<ConnectorPromptResult> {
        const back: string = first ? '' : ' · Esc back';
        switch (question) {
            case ConnectorSetupQuestion.Welcome:
                return await questions.confirm({
                    kind: ConnectorPromptKind.Confirm,
                    id: 'setup-welcome',
                    label: 'Get started',
                    hint: 'Enter start · Ctrl+C quit',
                });
            case ConnectorSetupQuestion.Name:
                return await questions.text({
                    kind: ConnectorPromptKind.Text,
                    id: 'setup-name',
                    label: 'Computer name',
                    initialValue: draft.name,
                    hint: 'Enter continue · Ctrl+U clear' + back + ' · Ctrl+C quit',
                    maximumLength: 128,
                });
            case ConnectorSetupQuestion.Access:
                return await questions.select({
                    kind: ConnectorPromptKind.Select,
                    id: 'setup-access',
                    label: 'Access',
                    initialValue: draft.access,
                    hint:
                        '↑↓ or 1-' + choices.length.toString() + ' choose · Enter continue' + back,
                    choices,
                });
            case ConnectorSetupQuestion.Folder:
                return await questions.text({
                    kind: ConnectorPromptKind.Text,
                    id: 'setup-directory',
                    label: 'Folder',
                    initialValue: draft.tasksDirectory,
                    hint: 'Enter continue · Ctrl+U clear' + back,
                    maximumLength: 32768,
                });
            case ConnectorSetupQuestion.Startup:
                return await questions.select({
                    kind: ConnectorPromptKind.Select,
                    id: 'setup-startup',
                    label: 'At sign-in',
                    initialValue: draft.startAtSignIn
                        ? ConnectorStartupChoice.Background
                        : ConnectorStartupChoice.Manual,
                    hint: '↑↓ or 1-2 choose · Enter continue' + back,
                    choices: [
                        {
                            value: ConnectorStartupChoice.Background,
                            label: 'Start in the background when I sign in',
                            description:
                                'Nerva Connector starts with Windows and waits next to the clock, so Nexa can use this computer without this window open. Click its icon to open it.',
                            badge: 'Recommended',
                        },
                        {
                            value: ConnectorStartupChoice.Manual,
                            label: 'Only when I open it',
                            description:
                                'Nexa can use this computer only while you have Nerva Connector open.',
                        },
                    ],
                });
            case ConnectorSetupQuestion.Note:
                return await questions.text({
                    kind: ConnectorPromptKind.Text,
                    id: 'setup-notes',
                    label: 'Note',
                    initialValue: draft.localInstructions,
                    hint: 'Enter continue · Ctrl+U clear' + back,
                    maximumLength: 16384,
                });
            case ConnectorSetupQuestion.Review:
                return await questions.confirm({
                    kind: ConnectorPromptKind.Confirm,
                    id: 'setup-save',
                    label: options.linkStep ? 'Link to my Nerva account' : 'Save',
                    hint: 'Enter ' + (options.linkStep ? 'continue' : 'save') + back,
                });
        }
    }

    static #accept(
        question: ConnectorSetupQuestion,
        value: string,
        draft: ConnectorSetupDraft,
        directory: string,
        available: (access: ConnectorSetupAccess) => boolean,
    ): string | null {
        try {
            if (question === ConnectorSetupQuestion.Name) {
                draft.name = value;
                const checked: string = ConnectorEnrollmentCodec.name(value);
                if (!checked.isWellFormed() || /[\p{Cc}\p{Cf}]/u.test(checked)) {
                    throw new Error('Invalid plain name');
                }
                draft.name = checked;
            } else if (question === ConnectorSetupQuestion.Folder) {
                draft.tasksDirectory = value;
                const checked: string = ConnectorSetupCodec.tasksDirectory(value);
                ConnectorSetupCodec.distinct(checked, directory);
                draft.tasksDirectory = checked;
            } else if (question === ConnectorSetupQuestion.Access) {
                const checked: ConnectorSetupAccess | undefined = Object.values(
                    ConnectorSetupAccess,
                ).find(
                    (candidate: ConnectorSetupAccess): boolean =>
                        candidate === value && available(candidate),
                );
                if (checked === undefined) {
                    throw new Error('Invalid access choice');
                }
                draft.access = checked;
            } else if (question === ConnectorSetupQuestion.Startup) {
                if (
                    value !== ConnectorStartupChoice.Background &&
                    value !== ConnectorStartupChoice.Manual
                ) {
                    throw new Error('Invalid startup choice');
                }
                draft.startAtSignIn = value === ConnectorStartupChoice.Background;
            } else if (question === ConnectorSetupQuestion.Note) {
                draft.localInstructions = value;
                ConnectorInstructionsCodec.text(value);
            }
            return null;
        } catch {
            return question === ConnectorSetupQuestion.Name
                ? 'Use 1 to 128 plain characters.'
                : question === ConnectorSetupQuestion.Folder
                  ? "Pick another folder. It can't be the top of a drive or the connector's own folder."
                  : question === ConnectorSetupQuestion.Access ||
                      question === ConnectorSetupQuestion.Startup
                    ? 'Choose one of the options.'
                    : 'Keep the note under 16 KB.';
        }
    }

    static #saveError(caught: unknown): string {
        const kind: ConnectorFailureKind = ConnectorFailure.classify({
            error: caught,
            stage: null,
            httpStatus: null,
            event: null,
            codeShown: false,
        }).kind;
        return kind === ConnectorFailureKind.StoragePermission
            ? "Couldn't save: permission denied. Choose a folder you own, then try again."
            : kind === ConnectorFailureKind.DiskFull
              ? "Couldn't save: this computer is out of disk space."
              : kind === ConnectorFailureKind.AlreadyRunning
                ? "Couldn't save: Nerva Connector is busy in another window. Close it, then try again."
                : "Couldn't save. Check that the task folder can be created, then try again.";
    }

    static #panel(
        question: ConnectorSetupQuestion,
        step: ConnectorPromptStep | undefined,
        error: string | null,
        draft: ConnectorSetupDraft,
        options: ConnectorSetupOptions,
    ): ConnectorPromptPanel {
        const status: Pick<ConnectorPromptPanel, 'status'> =
            error === null
                ? {}
                : { status: { text: error, tone: ConnectorPromptTone.Warning, busy: false } };
        const numbered: Pick<ConnectorPromptPanel, 'step'> = step === undefined ? {} : { step };
        switch (question) {
            case ConnectorSetupQuestion.Welcome:
                return {
                    context: 'Welcome',
                    title: 'Welcome to Nerva Connector',
                    description: [
                        'Nerva Connector lets Nexa, your AI agent, do work on this computer: open programs, use files and run commands.',
                        'You decide how much it can do, and you can watch everything it does. Setup takes about a minute.',
                    ],
                    ...status,
                };
            case ConnectorSetupQuestion.Name:
                return {
                    title: 'What should we call this computer?',
                    description: [
                        'This name shows up in Nerva, so you can tell your computers apart.',
                    ],
                    ...numbered,
                    ...status,
                };
            case ConnectorSetupQuestion.Access:
                return {
                    title: 'What can Nexa do here?',
                    description: ['You can change this anytime with /settings.'],
                    ...numbered,
                    ...status,
                };
            case ConnectorSetupQuestion.Folder:
                return draft.access === ConnectorSetupAccess.PairingOnly
                    ? {
                          title: 'Where should Nexa keep its work?',
                          description: [
                              'New tasks start in this folder once you let Nexa do more. Press Enter to keep it, or type another path.',
                          ],
                          ...numbered,
                          ...status,
                      }
                    : draft.access === ConnectorSetupAccess.FullComputer
                      ? {
                            title: 'Where should Nexa start?',
                            description: [
                                'New tasks start in this folder. Nexa can still use the rest of the computer. Press Enter to keep it, or type another path.',
                            ],
                            ...numbered,
                            ...status,
                        }
                      : {
                            title: 'Which folder can Nexa use?',
                            description: [
                                'Nexa can only use files inside this folder. Press Enter to keep it, or type another path.',
                            ],
                            ...numbered,
                            ...status,
                        };
            case ConnectorSetupQuestion.Startup:
                return {
                    title: 'Start Nerva Connector when you sign in?',
                    description: ['You can change this anytime with /startup.'],
                    ...numbered,
                    ...status,
                };
            case ConnectorSetupQuestion.Note:
                return {
                    title: 'Add a note (optional)',
                    description: [
                        'Saved only on this computer, just for you. Press Enter to skip.',
                    ],
                    ...numbered,
                    ...status,
                };
            case ConnectorSetupQuestion.Review:
                return {
                    title: options.linkStep ? 'Ready to connect' : 'Save these changes?',
                    description: [this.#summary(draft, options)],
                    details: [
                        { label: 'Computer', value: draft.name },
                        { label: 'Nexa can', value: this.label(draft.access) },
                        { label: 'Task folder', value: draft.tasksDirectory },
                        ...(options.startup === null
                            ? []
                            : [
                                  {
                                      label: 'At sign-in',
                                      value: draft.startAtSignIn
                                          ? 'Start in the background'
                                          : "Don't start",
                                  },
                              ]),
                        ...(draft.localInstructions === ''
                            ? []
                            : [{ label: 'Note', value: draft.localInstructions }]),
                    ],
                    ...numbered,
                    ...status,
                };
        }
    }

    static #summary(draft: ConnectorSetupDraft, options: ConnectorSetupOptions): string {
        const next: string = options.linkStep
            ? 'Next, you will link it to your Nerva account. You can change any of this later with /settings.'
            : 'Press Enter to save.';
        if (draft.access === ConnectorSetupAccess.FullComputer) {
            return (
                'Nexa will be able to use programs and files like your ' +
                this.#account() +
                ' account can. ' +
                next
            );
        }
        if (options.hostEnabled) {
            return 'Full computer access stays on until you turn it off with /disable-host.';
        }
        return next;
    }
}
