// SPDX-FileCopyrightText: 2026 Dacely <business@dacely.com>
// SPDX-License-Identifier: LicenseRef-Proprietary

import { realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { ConnectorAccessSetup } from '../src/cli/ConnectorAccessSetup.js';
import { ConnectorSetupSession } from '../src/cli/ConnectorSetupSession.js';
import { ConnectorApproval } from '../src/cli/ConnectorPromptTypes.js';
import { ConnectorSetupCodec } from '../src/runtime/ConnectorSetupCodec.js';
import { ConnectorSetupStore } from '../src/runtime/ConnectorSetupStore.js';
import { ConnectorSetupAccess } from '../src/runtime/ConnectorSetupProfile.js';
import { ConnectorHostGrant } from '../src/runtime/ConnectorHostGrant.js';
import { type ConnectorHostLocalGrant } from '../src/runtime/ConnectorHostGrantTypes.js';
import { ConnectorHostFixture } from './support/ConnectorHostFixture.js';
import { ConnectorPromptFixture } from './support/ConnectorPromptFixture.js';

/** A session over a private installation folder beside the fixture's task folder. */
function session(fixture: ConnectorHostFixture): ConnectorSetupSession {
    return new ConnectorSetupSession(
        (): Promise<string> => Promise.resolve(join(fixture.directory, 'installation')),
        new AbortController().signal,
    );
}

/** Saves full computer as the chosen access, as a run that stopped before linking would have. */
async function savedFullComputer(fixture: ConnectorHostFixture): Promise<void> {
    await ConnectorSetupStore.save(
        join(fixture.directory, 'installation'),
        {
            ...ConnectorSetupCodec.defaults(),
            tasksDirectory: fixture.tasks,
            access: ConnectorSetupAccess.FullComputer,
        },
        0n,
        AbortSignal.timeout(5000),
    );
}

it.skipIf(process.platform !== 'linux')(
    'full computer confirmed during setup is signed for the device right after linking, without asking a second time',
    async (): Promise<void> => {
        await using fixture: ConnectorHostFixture = await ConnectorHostFixture.create();
        await fixture.persist();
        const setup: ConnectorSetupSession = session(fixture);
        expect(await setup.load()).toBeNull();
        const answers: ConnectorPromptFixture = new ConnectorPromptFixture([
            '',
            'Studio PC',
            ConnectorSetupAccess.FullComputer,
            fixture.tasks,
            '',
        ]);
        expect(await setup.review(answers, true, false)).toBe(true);
        expect(setup.linkStep).toEqual({ current: 5, total: 5 });
        expect(setup.pending).toBe(true);
        expect(await ConnectorHostGrant.read(fixture.identity)).toBeNull();
        const questions: ConnectorPromptFixture = new ConnectorPromptFixture([]);
        const lines: readonly string[] = await ConnectorAccessSetup.apply(setup, {
            configurationFile: fixture.identity.configurationFile,
            installationDirectory: join(fixture.directory, 'installation'),
            questions,
            signal: new AbortController().signal,
        });
        expect(lines[0]).toBe(
            'Full computer access is on. Turn it off anytime with /disable-host.',
        );
        expect(questions.selections).toEqual([]);
        expect(questions.texts).toEqual([]);
        const grant: ConnectorHostLocalGrant | null = await ConnectorHostGrant.read(
            fixture.identity,
        );
        expect(grant?.profile.enabled).toBe(true);
        expect(grant?.profile.directory).toBe(await realpath(fixture.tasks));
        expect(grant?.profile.grantRevision).toBe(1n);
        expect(grant?.journalInitialized).toBe(true);
        expect(setup.pending).toBe(false);
        expect(await ConnectorAccessSetup.needed(setup, fixture.identity.configurationFile)).toBe(
            false,
        );
    },
);

it.skipIf(process.platform !== 'linux')(
    'after a restart the saved choice is not consent: Ctrl+C keeps asking, and Not now is remembered as the safe level',
    async (): Promise<void> => {
        await using fixture: ConnectorHostFixture = await ConnectorHostFixture.create();
        await fixture.persist();
        await savedFullComputer(fixture);
        const restarted: ConnectorSetupSession = session(fixture);
        expect((await restarted.load())?.access).toBe(ConnectorSetupAccess.FullComputer);
        expect(restarted.pending).toBe(false);
        expect(
            await ConnectorAccessSetup.needed(restarted, fixture.identity.configurationFile),
        ).toBe(true);
        const interrupted: AbortController = new AbortController();
        interrupted.abort();
        expect(
            await ConnectorAccessSetup.apply(restarted, {
                configurationFile: fixture.identity.configurationFile,
                installationDirectory: join(fixture.directory, 'installation'),
                questions: new ConnectorPromptFixture([null]),
                signal: interrupted.signal,
            }),
        ).toEqual([]);
        expect(await ConnectorHostGrant.read(fixture.identity)).toBeNull();
        expect(
            (await ConnectorSetupStore.load(join(fixture.directory, 'installation')))?.access,
        ).toBe(ConnectorSetupAccess.FullComputer);
        const declined: ConnectorPromptFixture = new ConnectorPromptFixture(['']);
        expect(
            await ConnectorAccessSetup.apply(restarted, {
                configurationFile: fixture.identity.configurationFile,
                installationDirectory: join(fixture.directory, 'installation'),
                questions: declined,
                signal: new AbortController().signal,
            }),
        ).toEqual(['Full computer access is off. You can turn it on later with /settings.']);
        expect(declined.selections[0]?.initialValue).toBe(ConnectorApproval.NotNow);
        expect(await ConnectorHostGrant.read(fixture.identity)).toBeNull();
        expect(
            (await ConnectorSetupStore.load(join(fixture.directory, 'installation')))?.access,
        ).toBe(ConnectorSetupAccess.PairingOnly);
        expect(
            await ConnectorAccessSetup.needed(restarted, fixture.identity.configurationFile),
        ).toBe(false);
    },
);

it.skipIf(process.platform !== 'linux')(
    'after a restart an explicit Allow turns it on, and turning it off later is respected without asking again',
    async (): Promise<void> => {
        await using fixture: ConnectorHostFixture = await ConnectorHostFixture.create();
        await fixture.persist();
        await savedFullComputer(fixture);
        const restarted: ConnectorSetupSession = session(fixture);
        await restarted.load();
        const allowed: ConnectorPromptFixture = new ConnectorPromptFixture([
            ConnectorApproval.Allow,
        ]);
        expect(
            (
                await ConnectorAccessSetup.apply(restarted, {
                    configurationFile: fixture.identity.configurationFile,
                    installationDirectory: join(fixture.directory, 'installation'),
                    questions: allowed,
                    signal: new AbortController().signal,
                })
            )[0],
        ).toContain('Full computer access is on');
        expect((await ConnectorHostGrant.read(fixture.identity))?.profile.enabled).toBe(true);
        await fixture.grant(false);
        const later: ConnectorSetupSession = session(fixture);
        await later.load();
        expect(await later.hostReview(fixture.identity.configurationFile)).toBeNull();
        expect(await ConnectorAccessSetup.needed(later, fixture.identity.configurationFile)).toBe(
            false,
        );
    },
);
