// SPDX-FileCopyrightText: 2026 Dacely <business@dacely.com>
// SPDX-License-Identifier: LicenseRef-Proprietary

import { readdir, rm } from 'node:fs/promises';
import { expect, it } from 'vitest';
import { ConnectorHostPermissionWizard } from '../src/cli/ConnectorHostPermissionWizard.js';
import { ConnectorPromptFixture } from './support/ConnectorPromptFixture.js';
import { ConnectorHostGrant } from '../src/runtime/ConnectorHostGrant.js';
import { type ConnectorHostLocalGrant } from '../src/runtime/ConnectorHostGrantTypes.js';
import { ConnectorHostFixture } from './support/ConnectorHostFixture.js';
import { ConnectorApproval, ConnectorPromptAction } from '../src/cli/ConnectorPromptTypes.js';

it.skipIf(process.platform !== 'linux')(
    'the full computer question starts on Not now; anything but an explicit Allow never stops the connector or creates host authority',
    async (): Promise<void> => {
        await using fixture: ConnectorHostFixture = await ConnectorHostFixture.create();
        let stopped: boolean = false;
        for (const answer of [
            null,
            '',
            'SAVE',
            'ALLOW FULL COMPUTER',
            ConnectorApproval.NotNow,
            { action: ConnectorPromptAction.Back },
        ]) {
            const questions: ConnectorPromptFixture = new ConnectorPromptFixture([answer]);
            expect(
                await ConnectorHostPermissionWizard.run(
                    fixture.identity.configurationFile,
                    fixture.tasks,
                    questions,
                    new AbortController().signal,
                    (): Promise<void> => {
                        stopped = true;
                        return Promise.resolve();
                    },
                ),
            ).toBe(false);
            expect(questions.selections[0]?.initialValue).toBe(ConnectorApproval.NotNow);
            expect(
                questions.selections[0]?.choices.find(
                    (choice): boolean => choice.value === ConnectorApproval.Allow,
                )?.description,
            ).toContain('You can turn this off anytime with /disable-host.');
        }
        expect(stopped).toBe(false);
        expect(await ConnectorHostGrant.read(fixture.identity)).toBeNull();
        expect(await readdir(fixture.directory)).toEqual(['tasks']);
    },
);

it.skipIf(process.platform !== 'linux')(
    'explicit full computer approval joins runtime shutdown before protected activation and reuses exact consent on restart',
    async (): Promise<void> => {
        await using fixture: ConnectorHostFixture = await ConnectorHostFixture.create();
        await fixture.persist();
        let stopped: boolean = false;
        const questions: ConnectorPromptFixture = new ConnectorPromptFixture([
            ConnectorApproval.Allow,
        ]);
        expect(
            await ConnectorHostPermissionWizard.run(
                fixture.identity.configurationFile,
                fixture.tasks,
                questions,
                new AbortController().signal,
                async (): Promise<void> => {
                    expect(await ConnectorHostGrant.read(fixture.identity)).toBeNull();
                    stopped = true;
                },
            ),
        ).toBe(true);
        expect(stopped).toBe(true);
        expect(
            await ConnectorHostPermissionWizard.matches(
                fixture.identity.configurationFile,
                fixture.tasks,
            ),
        ).toBe(true);
        expect((await ConnectorHostGrant.read(fixture.identity))?.profile.grantRevision).toBe(1n);
        expect((await fixture.open()).grant.profile.enabled).toBe(true);
    },
);

it.skipIf(process.platform !== 'linux')(
    'turning access off starts on Keep it on, joins the runtime even when the former task directory disappeared, and is remembered',
    async (): Promise<void> => {
        await using fixture: ConnectorHostFixture = await ConnectorHostFixture.create();
        await fixture.persist();
        const original: Awaited<ReturnType<ConnectorHostFixture['grant']>> = await fixture.grant();
        let stopped: boolean = false;
        const stop: () => Promise<void> = async (): Promise<void> => {
            expect((await ConnectorHostGrant.read(fixture.identity))?.profile.enabled).toBe(true);
            stopped = true;
        };
        for (const answer of [
            null,
            '',
            'DISABLE',
            ConnectorApproval.Allow,
            ConnectorApproval.Keep,
        ]) {
            const questions: ConnectorPromptFixture = new ConnectorPromptFixture([answer]);
            expect(
                await ConnectorHostPermissionWizard.disable(
                    fixture.identity.configurationFile,
                    questions,
                    new AbortController().signal,
                    stop,
                ),
            ).toBe(false);
            expect(questions.selections[0]?.initialValue).toBe(ConnectorApproval.Keep);
            expect(stopped).toBe(false);
            expect(await ConnectorHostGrant.read(fixture.identity)).toEqual(original);
        }
        expect(
            await ConnectorHostPermissionWizard.turnedOff(fixture.identity.configurationFile),
        ).toBe(false);
        await rm(fixture.tasks, { recursive: true });
        expect(
            await ConnectorHostPermissionWizard.disable(
                fixture.identity.configurationFile,
                new ConnectorPromptFixture([ConnectorApproval.TurnOff]),
                new AbortController().signal,
                stop,
            ),
        ).toBe(true);
        expect(stopped).toBe(true);
        const disabled: ConnectorHostLocalGrant | null = await ConnectorHostGrant.read(
            fixture.identity,
        );
        expect(disabled?.profile.enabled).toBe(false);
        expect(disabled?.journalId).toBe(original.journalId);
        expect(disabled?.profile.grantRevision).toBe(original.profile.grantRevision + 1n);
        expect(
            await ConnectorHostPermissionWizard.turnedOff(fixture.identity.configurationFile),
        ).toBe(true);
        const host: Awaited<ReturnType<ConnectorHostFixture['open']>> = await fixture.open();
        expect(host.publication('A'.repeat(43)).profile.enabled).toBe(false);
    },
);
