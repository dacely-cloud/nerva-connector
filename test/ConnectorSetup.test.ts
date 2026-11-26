// SPDX-FileCopyrightText: 2026 Dacely <business@dacely.com>
// SPDX-License-Identifier: LicenseRef-Proprietary

import { mkdtemp, readFile, writeFile, rm, lstat, readdir, symlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { ConnectorCapabilityFixture } from './support/ConnectorCapabilityFixture.js';
import {
    ConnectorPermissionWizard,
    ConnectorPermissionOutcome,
    type ConnectorPermissionResult,
} from '../src/cli/ConnectorPermissionWizard.js';
import { ConnectorFileMode } from 'nerva-connector-protocol/protocol/ConnectorFiles.js';
import {
    ConnectorFileAction,
    ConnectorWriteMode,
} from 'nerva-connector-protocol/protocol/ConnectorFileTypes.js';
import { ConnectorFileJobsCodec } from 'nerva-connector-protocol/protocol/ConnectorFileJobsCodec.js';
import { ConnectorFilesystem } from '../src/runtime/ConnectorFilesystem.js';
import { expect, it } from 'vitest';
import { ConnectorSetupCodec } from '../src/runtime/ConnectorSetupCodec.js';
import { ConnectorSetupStore } from '../src/runtime/ConnectorSetupStore.js';
import {
    ConnectorSetupAccess,
    type ConnectorSetupPreferences,
    type ConnectorSetupProfile,
} from '../src/runtime/ConnectorSetupProfile.js';
import {
    ConnectorSetupWizard,
    type ConnectorSetupOptions,
    type ConnectorSetupResult,
} from '../src/cli/ConnectorSetupWizard.js';
import { ConnectorPromptFixture } from './support/ConnectorPromptFixture.js';
import {
    ConnectorApproval,
    ConnectorPromptAction,
    ConnectorPromptTone,
    type ConnectorPromptChoice,
} from '../src/cli/ConnectorPromptTypes.js';
import { ConnectorCloudConfiguration } from '../src/runtime/ConnectorCloudConfiguration.js';
import {
    ConnectorPairConfiguration,
    type ConnectorPairIdentity,
} from '../src/runtime/ConnectorPairConfiguration.js';

/** Each setup case owns its protected state and task paths beneath one trusted home fixture. */
class SetupFixture implements AsyncDisposable {
    private constructor(public readonly directory: string) {}
    /** No dependency or build copies are needed for setup validation. */
    public static async create(): Promise<SetupFixture> {
        return new SetupFixture(await mkdtemp(join(homedir(), '.nerva-setup-')));
    }
    /** Fixture cleanup preserves every path outside this task-owned root. */
    public async [Symbol.asyncDispose](): Promise<void> {
        await rm(this.directory, { recursive: true, force: true });
    }
}

/** Linux first run from the default cloud installation: no signed installation, so no folder options. */
const firstRun: ConnectorSetupOptions = {
    folderAccess: false,
    fullComputer: true,
    hostEnabled: false,
    linkStep: true,
    startup: null,
};

/** The same computer reopening its choices from /settings, where the note is offered. */
const settings: ConnectorSetupOptions = { ...firstRun, linkStep: false };

it.skipIf(process.platform !== 'linux')(
    'the installed Windows connector asks whether to start at sign-in and applies the answer before saving',
    async (): Promise<void> => {
        await using fixture: SetupFixture = await SetupFixture.create();
        const installation: string = join(fixture.directory, 'installation');
        const changes: boolean[] = [];
        const questions: ConnectorPromptFixture = new ConnectorPromptFixture([
            '',
            'Studio PC',
            ConnectorSetupAccess.FullComputer,
            join(fixture.directory, 'Tasks'),
            'background',
            '',
        ]);
        const result: ConnectorSetupResult = await ConnectorSetupWizard.run(
            installation,
            null,
            questions,
            AbortSignal.timeout(5000),
            {
                ...firstRun,
                startup: {
                    enabled: false,
                    set: (enabled: boolean): Promise<void> => {
                        changes.push(enabled);
                        return Promise.resolve();
                    },
                },
            },
        );
        expect(result.canceled).toBe(false);
        expect(changes).toEqual([true]);
        expect(questions.selections.map((select): string => select.id)).toEqual([
            'setup-access',
            'setup-startup',
        ]);
        expect(questions.output).toContain('Start Nerva Connector when you sign in?');
        expect(
            questions.selections[1]?.choices.map(
                (choice: ConnectorPromptChoice): string => choice.label,
            ),
        ).toEqual(['Start in the background when I sign in', 'Only when I open it']);
        expect(questions.panels.at(-1)?.details).toContainEqual({
            label: 'At sign-in',
            value: 'Start in the background',
        });
    },
);

it.skipIf(process.platform !== 'linux')(
    'first setup creates one reusable task directory only after Enter on the review and initial cloud pairing uses the chosen name',
    async (): Promise<void> => {
        await using fixture: SetupFixture = await SetupFixture.create();
        const installation: string = join(fixture.directory, 'installation');
        const tasksDirectory: string = join(fixture.directory, 'Agent Tasks');
        const questions: ConnectorPromptFixture = new ConnectorPromptFixture([
            '',
            'Game workstation',
            ConnectorSetupAccess.FullComputer,
            tasksDirectory,
            '',
        ]);
        const result: ConnectorSetupResult = await ConnectorSetupWizard.run(
            installation,
            null,
            questions,
            AbortSignal.timeout(5000),
            firstRun,
        );
        expect(result.canceled).toBe(false);
        expect(result.profile).toMatchObject({
            name: 'Game workstation',
            tasksDirectory,
            access: ConnectorSetupAccess.FullComputer,
            localInstructions: '',
            revision: 1n,
        });
        expect((await lstat(tasksDirectory)).isDirectory()).toBe(true);
        expect((await lstat(join(installation, 'preferences', 'setup.json'))).mode & 0o777).toBe(
            0o600,
        );
        expect(questions.confirms.map((confirm): string => confirm.label)).toEqual([
            'Get started',
            'Link to my Nerva account',
        ]);
        expect(questions.texts.map((text): string => text.id)).toEqual([
            'setup-name',
            'setup-directory',
        ]);
        expect(questions.panels.map((panel): number | undefined => panel.step?.total)).toEqual([
            undefined,
            5,
            5,
            5,
            5,
        ]);
        expect(questions.output).toContain('Next, you will link it to your Nerva account.');
        expect(questions.output).toContain('programs and files like your Linux account can');
        expect(questions.output).not.toMatch(/SAVE|ALLOW|grant|authoritative|signed Linux/u);
        const original: Buffer = await readFile(join(installation, 'preferences', 'setup.json'));
        const pairingFile: string = await ConnectorCloudConfiguration.prepare(
            installation,
            AbortSignal.timeout(5000),
        );
        const pairing: ConnectorPairIdentity = await ConnectorPairConfiguration.load(pairingFile);
        expect(pairing.settings.deviceName).toBe('Game workstation');
        expect(pairing.settings.files).toBeNull();
        expect(pairing.settings.execution).toBeNull();
        expect(await readFile(join(installation, 'preferences', 'setup.json'))).toEqual(original);
        await writeFile(join(tasksDirectory, 'keep.txt'), 'user work');
        const next: ConnectorPromptFixture = new ConnectorPromptFixture(['', '', '', '', '']);
        const revised: ConnectorSetupResult = await ConnectorSetupWizard.run(
            installation,
            result.profile,
            next,
            AbortSignal.timeout(5000),
            settings,
        );
        expect(next.selections[0]?.initialValue).toBe(ConnectorSetupAccess.PairingOnly);
        expect(revised.profile?.access).toBe(ConnectorSetupAccess.PairingOnly);
        expect(revised.profile?.tasksDirectory).toBe(tasksDirectory);
        expect(revised.profile?.revision).toBe(2n);
        expect(next.confirms.map((confirm): string => confirm.label)).toEqual(['Save']);
        expect(await readdir(tasksDirectory)).toEqual(['keep.txt']);
        expect(await readFile(join(tasksDirectory, 'keep.txt'), 'utf8')).toBe('user work');
        expect(await readdir(join(installation, 'preferences'))).toEqual(['setup.json']);
    },
);

it.skipIf(process.platform !== 'linux')(
    'full computer starts unselected and needs an explicit move; it starts selected only when it is already on',
    async (): Promise<void> => {
        await using fixture: SetupFixture = await SetupFixture.create();
        const installation: string = join(fixture.directory, 'installation');
        const tasks: string = join(fixture.directory, 'tasks');
        const enter: ConnectorPromptFixture = new ConnectorPromptFixture(['', '', '', tasks, '']);
        const kept: ConnectorSetupResult = await ConnectorSetupWizard.run(
            installation,
            null,
            enter,
            AbortSignal.timeout(5000),
            firstRun,
        );
        expect(enter.selections[0]?.initialValue).toBe(ConnectorSetupAccess.PairingOnly);
        expect(kept.profile?.access).toBe(ConnectorSetupAccess.PairingOnly);
        const full: ConnectorPromptChoice | undefined = enter.selections[0]?.choices.find(
            (choice: ConnectorPromptChoice): boolean =>
                choice.value === ConnectorSetupAccess.FullComputer,
        );
        expect(full?.caution).toBe(true);
        expect(full?.description).toContain('/disable-host');
        const on: ConnectorPromptFixture = new ConnectorPromptFixture(['', '', '', '', '']);
        const unchanged: ConnectorSetupResult = await ConnectorSetupWizard.run(
            installation,
            kept.profile,
            on,
            AbortSignal.timeout(5000),
            { ...settings, hostEnabled: true },
        );
        expect(on.selections[0]?.initialValue).toBe(ConnectorSetupAccess.FullComputer);
        expect(unchanged.profile?.access).toBe(ConnectorSetupAccess.FullComputer);
        const lowered: ConnectorPromptFixture = new ConnectorPromptFixture([
            '',
            ConnectorSetupAccess.PairingOnly,
            '',
            '',
            '',
        ]);
        await ConnectorSetupWizard.run(
            installation,
            unchanged.profile,
            lowered,
            AbortSignal.timeout(5000),
            { ...settings, hostEnabled: true },
        );
        expect(lowered.output).toContain('stays on until you turn it off with /disable-host');
    },
);

it.skipIf(process.platform !== 'linux')(
    'only options that work here are offered: no folder options without the signed installation and no access question without full computer support',
    async (): Promise<void> => {
        await using fixture: SetupFixture = await SetupFixture.create();
        const values: (questions: ConnectorPromptFixture) => readonly string[] = (
            questions: ConnectorPromptFixture,
        ): readonly string[] =>
            questions.selections[0]?.choices.map((choice): string => choice.value) ?? [];
        const windows: ConnectorPromptFixture = new ConnectorPromptFixture([
            '',
            '',
            ConnectorSetupAccess.FilesWrite,
            ConnectorSetupAccess.PairingOnly,
            join(fixture.directory, 'tasks'),
            '',
        ]);
        const chosen: ConnectorSetupResult = await ConnectorSetupWizard.run(
            join(fixture.directory, 'windows'),
            null,
            windows,
            AbortSignal.timeout(5000),
            firstRun,
        );
        expect(values(windows)).toEqual([
            ConnectorSetupAccess.FullComputer,
            ConnectorSetupAccess.PairingOnly,
        ]);
        expect(chosen.profile?.access).toBe(ConnectorSetupAccess.PairingOnly);
        expect(
            windows.panels.filter(
                (panel): boolean => panel.status?.tone === ConnectorPromptTone.Warning,
            ),
        ).toHaveLength(1);
        const signed: ConnectorPromptFixture = new ConnectorPromptFixture([
            '',
            '',
            ConnectorSetupAccess.FilesWrite,
            join(fixture.directory, 'tasks'),
            '',
        ]);
        expect(
            (
                await ConnectorSetupWizard.run(
                    join(fixture.directory, 'signed'),
                    null,
                    signed,
                    AbortSignal.timeout(5000),
                    { ...firstRun, folderAccess: true },
                )
            ).profile?.access,
        ).toBe(ConnectorSetupAccess.FilesWrite);
        expect(values(signed)).toEqual([
            ConnectorSetupAccess.FullComputer,
            ConnectorSetupAccess.FilesWrite,
            ConnectorSetupAccess.FilesRead,
            ConnectorSetupAccess.PairingOnly,
        ]);
        const unsupported: ConnectorPromptFixture = new ConnectorPromptFixture([
            '',
            '',
            join(fixture.directory, 'tasks'),
            '',
        ]);
        expect(
            (
                await ConnectorSetupWizard.run(
                    join(fixture.directory, 'macos'),
                    null,
                    unsupported,
                    AbortSignal.timeout(5000),
                    { ...firstRun, fullComputer: false },
                )
            ).profile?.access,
        ).toBe(ConnectorSetupAccess.PairingOnly);
        expect(unsupported.selections).toEqual([]);
        expect(unsupported.panels.at(-1)?.step).toEqual({ current: 3, total: 4 });
    },
);

it.skipIf(process.platform !== 'linux')(
    'canceled or aborted setup leaves no task directory, configuration or pairing identity',
    async (): Promise<void> => {
        await using fixture: SetupFixture = await SetupFixture.create();
        const installation: string = join(fixture.directory, 'installation');
        const tasks: string = join(fixture.directory, 'tasks');
        for (const answers of [
            ['', '', ConnectorSetupAccess.FullComputer, tasks, null],
            [{ action: ConnectorPromptAction.Back }],
            [null],
        ]) {
            expect(
                await ConnectorSetupWizard.run(
                    installation,
                    null,
                    new ConnectorPromptFixture(answers),
                    AbortSignal.timeout(5000),
                    firstRun,
                ),
            ).toMatchObject({ profile: null, canceled: true });
            expect(await readdir(fixture.directory)).toEqual([]);
        }
        await expect(
            ConnectorSetupWizard.run(
                installation,
                null,
                new ConnectorPromptFixture(['', '', ConnectorSetupAccess.FullComputer, tasks, '']),
                AbortSignal.abort(),
                firstRun,
            ),
        ).rejects.toThrow();
        expect(await readdir(fixture.directory)).toEqual([]);
    },
);

it.skipIf(process.platform !== 'linux')(
    'revision conflicts, invalid state and task aliases cannot overwrite reviewed preferences or leave failed setup output',
    async (): Promise<void> => {
        await using fixture: SetupFixture = await SetupFixture.create();
        const installation: string = join(fixture.directory, 'installation');
        const preferences: ConnectorSetupPreferences = {
            ...ConnectorSetupCodec.defaults(),
            tasksDirectory: join(fixture.directory, 'tasks'),
        };
        const first: ConnectorSetupProfile = await ConnectorSetupStore.save(
            installation,
            preferences,
            0n,
            AbortSignal.timeout(5000),
        );
        await expect(
            ConnectorSetupStore.save(
                installation,
                { ...preferences, name: 'stale' },
                0n,
                AbortSignal.timeout(5000),
            ),
        ).rejects.toThrow('changed');
        expect(await ConnectorSetupStore.load(installation)).toEqual(first);
        const alias: string = join(fixture.directory, 'alias');
        await symlink(preferences.tasksDirectory, alias);
        await expect(
            ConnectorSetupStore.save(
                installation,
                { ...preferences, tasksDirectory: alias },
                1n,
                AbortSignal.timeout(5000),
            ),
        ).rejects.toThrow('symbolic link');
        await expect(
            ConnectorSetupStore.save(
                installation,
                { ...preferences, tasksDirectory: installation },
                1n,
                AbortSignal.timeout(5000),
            ),
        ).rejects.toThrow('outside');
        const conflictingFile: string = join(fixture.directory, 'file');
        await writeFile(conflictingFile, 'preserve');
        const failedParent: string = join(fixture.directory, 'failed');
        const failedInstallation: string = join(failedParent, 'parent', 'installation');
        await expect(
            ConnectorSetupStore.save(
                failedInstallation,
                { ...preferences, tasksDirectory: conflictingFile },
                0n,
                AbortSignal.timeout(5000),
            ),
        ).rejects.toThrow();
        expect(await readFile(conflictingFile, 'utf8')).toBe('preserve');
        await expect(lstat(failedParent)).rejects.toMatchObject({ code: 'ENOENT' });
        await writeFile(join(installation, 'preferences', 'setup.json'), '{}', { mode: 0o600 });
        await expect(ConnectorSetupStore.load(installation)).rejects.toThrow();
        expect(await readFile(join(installation, 'preferences', 'setup.json'), 'utf8')).toBe('{}');
    },
);

it.skipIf(process.platform !== 'linux')(
    'a retained pairing request prevents local setup from rewriting its device name',
    async (): Promise<void> => {
        await using fixture: SetupFixture = await SetupFixture.create();
        const pairingFile: string = await ConnectorCloudConfiguration.prepare(
            fixture.directory,
            AbortSignal.timeout(5000),
        );
        await ConnectorSetupStore.applyPairingName(
            pairingFile,
            'Reviewed first name',
            AbortSignal.timeout(5000),
        );
        expect((await ConnectorPairConfiguration.load(pairingFile)).settings.deviceName).toBe(
            'Reviewed first name',
        );
        await writeFile(join(fixture.directory, 'state', 'pairing-state'), 'retained history', {
            mode: 0o600,
        });
        const original: Buffer = await readFile(pairingFile);
        await ConnectorSetupStore.applyPairingName(
            pairingFile,
            'Later local name',
            AbortSignal.timeout(5000),
        );
        expect(await readFile(pairingFile)).toEqual(original);
    },
);

it.skipIf(process.platform !== 'linux')(
    'prefilled folder defaults need an explicit Allow, while a folder choice confirmed in this setup session is applied without asking again',
    async (): Promise<void> => {
        for (const consented of [false, true]) {
            await using fixture: ConnectorCapabilityFixture =
                await ConnectorCapabilityFixture.create();
            const installation: string = fixture.service.layout.installationDirectory;
            const questions: ConnectorPromptFixture = new ConnectorPromptFixture(
                consented ? [] : ['', '', ConnectorApproval.Allow],
            );
            const result: ConnectorPermissionResult = await ConnectorPermissionWizard.run(
                installation,
                questions,
                AbortSignal.timeout(10000),
                undefined,
                { directory: fixture.workspace, mode: ConnectorFileMode.ReadWrite, consented },
            );
            expect(result.outcome).toBe(ConnectorPermissionOutcome.Installed);
            if (consented) {
                expect(questions.texts).toEqual([]);
                expect(questions.selections).toEqual([]);
            } else {
                expect(questions.texts[0]?.initialValue).toBe(fixture.workspace);
                expect(questions.selections[0]?.initialValue).toBe(ConnectorFileMode.ReadWrite);
                expect(questions.selections[1]?.initialValue).toBe(ConnectorApproval.NotNow);
            }
            await using files: ConnectorFilesystem = await ConnectorFilesystem.load(
                join(installation, 'capabilities', 'files-policy.json'),
                [fixture.runtimeFile],
            );
            expect(files.profile.mode).toBe(ConnectorFileMode.ReadWrite);
            expect(
                await files.dispatch(
                    ConnectorFileJobsCodec.encode({
                        action: ConnectorFileAction.Write,
                        requestId: 'setup-default-write',
                        policySha256: files.profile.policySha256,
                        rootId: 'workspace',
                        path: 'setup-result.txt',
                        mode: ConnectorWriteMode.Create,
                        dataBase64: Buffer.from('approved through setup').toString('base64'),
                    }),
                    'd'.repeat(64),
                ),
            ).toMatchObject({ ok: true });
            expect(await readFile(join(fixture.workspace, 'setup-result.txt'), 'utf8')).toBe(
                'approved through setup',
            );
        }
    },
    60000,
);

it.skipIf(process.platform !== 'linux')(
    'structured validation retains invalid editable input, and backward review edits preserve choices without implicit access',
    async (): Promise<void> => {
        await using fixture: SetupFixture = await SetupFixture.create();
        const installation: string = join(fixture.directory, 'installation');
        const tasks: string = join(fixture.directory, 'tasks');
        const questions: ConnectorPromptFixture = new ConnectorPromptFixture([
            '',
            { action: ConnectorPromptAction.Submit, value: '' },
            'Validated name',
            ConnectorSetupAccess.FullComputer,
            '/',
            tasks,
            { action: ConnectorPromptAction.Back },
            { action: ConnectorPromptAction.Back },
            ConnectorSetupAccess.PairingOnly,
            '',
            '',
        ]);
        const result: ConnectorSetupResult = await ConnectorSetupWizard.run(
            installation,
            null,
            questions,
            AbortSignal.timeout(5000),
            firstRun,
        );
        expect(result).toMatchObject({
            canceled: false,
            profile: {
                name: 'Validated name',
                tasksDirectory: tasks,
                access: ConnectorSetupAccess.PairingOnly,
                localInstructions: '',
            },
        });
        expect(
            questions.texts
                .filter((question): boolean => question.id === 'setup-name')
                .map((question): string => question.initialValue)[1],
        ).toBe('');
        expect(
            questions.texts
                .filter((question): boolean => question.id === 'setup-directory')
                .map((question): string => question.initialValue)[1],
        ).toBe('/');
        expect(
            questions.panels.filter(
                (panel): boolean => panel.status?.tone === ConnectorPromptTone.Warning,
            ),
        ).toHaveLength(2);
        expect(questions.selections.map((question): string => question.initialValue)).toEqual([
            ConnectorSetupAccess.PairingOnly,
            ConnectorSetupAccess.FullComputer,
        ]);
        expect(questions.confirms).toHaveLength(3);
        expect((await readdir(installation)).sort()).toEqual(['preferences']);
    },
);

it.skipIf(process.platform !== 'linux')(
    'Enter on the review saves at once, and prefilled multiline notes survive Enter while an explicit clear saves empty text',
    async (): Promise<void> => {
        await using fixture: SetupFixture = await SetupFixture.create();
        const installation: string = join(fixture.directory, 'installation');
        const tasks: string = join(fixture.directory, 'tasks');
        const previous: ConnectorSetupProfile = await ConnectorSetupStore.save(
            installation,
            {
                ...ConnectorSetupCodec.defaults(),
                tasksDirectory: tasks,
                localInstructions: 'First line\nSecond line',
            },
            0n,
            AbortSignal.timeout(5000),
        );
        const original: Buffer = await readFile(join(installation, 'preferences', 'setup.json'));
        const canceled: ConnectorSetupResult = await ConnectorSetupWizard.run(
            installation,
            previous,
            new ConnectorPromptFixture(['', '', '', '', { action: ConnectorPromptAction.Cancel }]),
            AbortSignal.timeout(5000),
            settings,
        );
        expect(canceled).toMatchObject({ profile: previous, canceled: true });
        expect(await readFile(join(installation, 'preferences', 'setup.json'))).toEqual(original);
        const kept: ConnectorSetupResult = await ConnectorSetupWizard.run(
            installation,
            previous,
            new ConnectorPromptFixture(['', '', '', '', '']),
            AbortSignal.timeout(5000),
            settings,
        );
        expect(kept.profile?.localInstructions).toBe('First line\nSecond line');
        expect(kept.profile?.revision).toBe(2n);
        const cleared: ConnectorSetupResult = await ConnectorSetupWizard.run(
            installation,
            kept.profile,
            new ConnectorPromptFixture([
                '',
                '',
                '',
                { action: ConnectorPromptAction.Submit, value: '' },
                '',
            ]),
            AbortSignal.timeout(5000),
            settings,
        );
        expect(cleared.profile?.localInstructions).toBe('');
        expect(cleared.profile?.revision).toBe(3n);
    },
);
