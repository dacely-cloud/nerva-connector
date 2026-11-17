// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

import { join } from 'node:path';
import { ConnectorSetupStore } from '../runtime/ConnectorSetupStore.js';
import {
    ConnectorSetupAccess,
    type ConnectorSetupProfile,
} from '../runtime/ConnectorSetupProfile.js';
import { ConnectorFileMode } from 'nerva-connector-protocol/protocol/ConnectorFiles.js';
import { ProtectedFiles } from '../local/ProtectedFiles.js';
import type { ConnectorPermissionQuestions } from './ConnectorPermissionPrompt.js';
import { ConnectorHostPermissionWizard } from './ConnectorHostPermissionWizard.js';
import {
    ConnectorSetupWizard,
    type ConnectorSetupOptions,
    type ConnectorSetupResult,
    type ConnectorStartupSetting,
} from './ConnectorSetupWizard.js';
import { WindowsBackgroundStartup } from '../windows/WindowsBackgroundStartup.js';
import type { ConnectorPermissionDefaults } from './ConnectorPermissionWizard.js';
import type { ConnectorPromptStep } from './ConnectorPromptTypes.js';

/**
 * The foreground terminal owns local setup preferences separately from connection and grant lifetimes.
 *
 * @remarks
 * An access level confirmed in this process is held in memory only, so it can be applied right after
 * pairing without asking twice. It is never written as consent: after a restart, the saved choice is
 * asked about again before any grant is created.
 */
export class ConnectorSetupSession {
    #profile: ConnectorSetupProfile | null = null;
    #hostConsent: string | null = null;
    #fileConsent: ConnectorPermissionDefaults | null = null;
    #linkStep: ConnectorPromptStep | undefined;

    /** Directory resolution stays behind the caller's selected cloud, signed-installation or enterprise source. */
    public constructor(
        public readonly directory: () => Promise<string>,
        public readonly signal: AbortSignal,
    ) {}

    /** The most recently loaded or saved choices. */
    public get profile(): ConnectorSetupProfile | null {
        return this.#profile;
    }

    /** The linking screen's position when it follows the setup questions as their final step. */
    public get linkStep(): ConnectorPromptStep | undefined {
        return this.#linkStep;
    }

    /** Whether a choice confirmed in this session still has to be applied. */
    public get pending(): boolean {
        return this.#hostConsent !== null || this.#fileConsent !== null;
    }

    /** Read-only: loads saved choices without creating a folder, file or identity. */
    public async load(): Promise<ConnectorSetupProfile | null> {
        this.#profile = await ConnectorSetupStore.load(await this.directory());
        return this.#profile;
    }

    /**
     * Shows the setup questions and records the access level confirmed on the review screen.
     *
     * @param linkStep - Linking to the account follows as the final step
     * @param hostEnabled - Full computer access is currently on
     * @returns Whether the choices were saved
     */
    public async review(
        questions: ConnectorPermissionQuestions,
        linkStep: boolean,
        hostEnabled: boolean,
    ): Promise<boolean> {
        const directory: string = await this.directory();
        const previous: ConnectorSetupProfile | null = await ConnectorSetupStore.load(directory);
        this.#profile = previous;
        const options: ConnectorSetupOptions = {
            folderAccess: await this.#folderAccess(directory),
            fullComputer:
                process.platform === 'linux' ||
                process.platform === 'darwin' ||
                process.platform === 'win32',
            hostEnabled,
            linkStep,
            startup: await this.#startup(),
        };
        const result: ConnectorSetupResult = await ConnectorSetupWizard.run(
            directory,
            previous,
            questions,
            this.signal,
            options,
        );
        const total: number = result.steps + 1;
        this.#linkStep = linkStep ? { current: total, total } : undefined;
        this.#profile = result.profile;
        if (result.canceled || result.profile === null) {
            return false;
        }
        const profile: ConnectorSetupProfile = result.profile;
        this.#hostConsent =
            profile.access === ConnectorSetupAccess.FullComputer ? profile.tasksDirectory : null;
        this.#fileConsent =
            profile.access === ConnectorSetupAccess.FilesRead ||
            profile.access === ConnectorSetupAccess.FilesWrite
                ? {
                      directory: profile.tasksDirectory,
                      mode:
                          profile.access === ConnectorSetupAccess.FilesWrite
                              ? ConnectorFileMode.ReadWrite
                              : ConnectorFileMode.ReadOnly,
                      consented: true,
                  }
                : null;
        return true;
    }

    /** The task folder for full computer access confirmed in this session, once. */
    public takeHostConsent(): string | null {
        const consent: string | null = this.#hostConsent;
        this.#hostConsent = null;
        return consent;
    }

    /** The folder access confirmed in this session, once. */
    public takeFileConsent(): ConnectorPermissionDefaults | null {
        const consent: ConnectorPermissionDefaults | null = this.#fileConsent;
        this.#fileConsent = null;
        return consent;
    }

    /**
     * The task folder to ask about when full computer access was chosen but never turned on.
     *
     * @returns `null` when nothing needs asking: no such choice, a matching grant, or the person turned it off
     */
    public async hostReview(configurationFile: string): Promise<string | null> {
        const profile: ConnectorSetupProfile | null = this.#profile;
        if (
            profile?.access !== ConnectorSetupAccess.FullComputer ||
            this.#hostConsent !== null ||
            (await ConnectorHostPermissionWizard.turnedOff(configurationFile)) ||
            (await ConnectorHostPermissionWizard.matches(configurationFile, profile.tasksDirectory))
        ) {
            return null;
        }
        return profile.tasksDirectory;
    }

    /** "Not now" is saved as the safe access level so the question is not repeated at every start. */
    public async declineHost(): Promise<void> {
        const profile: ConnectorSetupProfile | null = this.#profile;
        if (profile?.access !== ConnectorSetupAccess.FullComputer) {
            return;
        }
        this.#profile = await ConnectorSetupStore.save(
            await this.directory(),
            { ...profile, access: ConnectorSetupAccess.PairingOnly },
            profile.revision,
            this.signal,
        );
    }

    /** Names apply only to pairing requests that have no retained original. */
    public async applyPairingName(pairingFile: string): Promise<void> {
        if (this.#profile !== null) {
            await ConnectorSetupStore.applyPairingName(
                pairingFile,
                this.#profile.name,
                this.signal,
            );
        }
    }

    /** Saved choices for the console's /status details. */
    public summary(): readonly string[] {
        const profile: ConnectorSetupProfile | null = this.#profile;
        return profile === null
            ? ['Use /settings to choose a name, folder and what Nexa can do.']
            : [
                  'Computer: ' + profile.name,
                  'Nexa can: ' + ConnectorSetupWizard.label(profile.access),
                  'Folder: ' + profile.tasksDirectory,
                  ...(profile.localInstructions === '' ? [] : ['Note: saved on this computer']),
              ];
    }

    /** The sign-in setting of the installed Windows connector, or `null` elsewhere or when it cannot be read. */
    async #startup(): Promise<ConnectorStartupSetting | null> {
        const program: WindowsBackgroundStartup | null = WindowsBackgroundStartup.find();
        if (program === null) {
            return null;
        }
        try {
            return {
                enabled: await program.enabled(this.signal),
                set: (enabled: boolean, signal: AbortSignal): Promise<void> =>
                    program.set(enabled, signal),
            };
        } catch {
            this.signal.throwIfAborted();
            return null;
        }
    }

    async #folderAccess(directory: string): Promise<boolean> {
        return (
            process.platform === 'linux' &&
            (await ProtectedFiles.exists(join(directory, 'ready.json')))
        );
    }
}
