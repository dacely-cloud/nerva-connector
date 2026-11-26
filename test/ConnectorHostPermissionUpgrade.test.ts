// SPDX-FileCopyrightText: 2026 Dacely <business@dacely.com>
// SPDX-License-Identifier: LicenseRef-Proprietary

import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { SignaturePurpose } from 'nerva-connector-protocol/identity/IdentityFormat.js';
import { ConnectorHostPermissionWizard } from '../src/cli/ConnectorHostPermissionWizard.js';
import { ConnectorSetupSession } from '../src/cli/ConnectorSetupSession.js';
import { ConnectorApproval } from '../src/cli/ConnectorPromptTypes.js';
import { ConnectorHostTool } from 'nerva-connector-protocol/protocol/ConnectorHost.js';
import { ConnectorHostCodec } from 'nerva-connector-protocol/protocol/ConnectorHostCodec.js';
import { ConnectorHostGrant } from '../src/runtime/ConnectorHostGrant.js';
import type { ConnectorHostLocalGrant } from '../src/runtime/ConnectorHostGrantTypes.js';
import { ConnectorSetupAccess } from '../src/runtime/ConnectorSetupProfile.js';
import { ConnectorSetupStore } from '../src/runtime/ConnectorSetupStore.js';
import { ConnectorHostFixture } from './support/ConnectorHostFixture.js';
import { ConnectorPromptFixture } from './support/ConnectorPromptFixture.js';

/** Model an authentic pre-snapshot approval without resetting its permanent host journal. */
async function legacyGrant(fixture: ConnectorHostFixture): Promise<ConnectorHostLocalGrant> {
    const current: ConnectorHostLocalGrant = await fixture.grant();
    const unsigned: ConnectorHostLocalGrant = {
        ...current,
        profile: {
            ...current.profile,
            tools: current.profile.tools.filter(
                (tool: ConnectorHostTool): boolean => tool !== ConnectorHostTool.DesktopSnapshot,
            ),
        },
    };
    const previous: ConnectorHostLocalGrant = {
        ...unsigned,
        signature: fixture.identity.key.sign(
            SignaturePurpose.HostGrant,
            ConnectorHostGrant.payload(unsigned),
        ),
    };
    await writeFile(
        join(ConnectorHostGrant.directory(fixture.identity), 'grant.json'),
        ConnectorHostCodec.encode(previous),
        { mode: 0o600 },
    );
    await fixture.persist();
    return previous;
}

it('recognizes an old enabled tool list without modifying its signed approval', async (): Promise<void> => {
    await using fixture: ConnectorHostFixture = await ConnectorHostFixture.create();
    const previous: ConnectorHostLocalGrant = await legacyGrant(fixture);
    const installation: string = join(fixture.directory, 'installation');
    const signal: AbortSignal = new AbortController().signal;
    await ConnectorSetupStore.save(
        installation,
        {
            name: 'This PC',
            tasksDirectory: fixture.tasks,
            localInstructions: '',
            access: ConnectorSetupAccess.FullComputer,
        },
        0n,
        signal,
    );
    const session: ConnectorSetupSession = new ConnectorSetupSession(
        (): Promise<string> => Promise.resolve(installation),
        signal,
    );
    await session.load();
    expect(await session.hostReview(fixture.identity.configurationFile)).toBe(fixture.tasks);
    expect(
        await ConnectorHostPermissionWizard.matches(
            fixture.identity.configurationFile,
            fixture.tasks,
        ),
    ).toBe(false);
    expect(await ConnectorHostGrant.read(fixture.identity)).toEqual(previous);
});

it('declining an upgrade keeps the original tools, grant revision and journal intact', async (): Promise<void> => {
    await using fixture: ConnectorHostFixture = await ConnectorHostFixture.create();
    const previous: ConnectorHostLocalGrant = await legacyGrant(fixture);
    const file: string = join(ConnectorHostGrant.directory(fixture.identity), 'grant.json');
    const bytes: Buffer = await readFile(file);
    const questions: ConnectorPromptFixture = new ConnectorPromptFixture(['']);
    expect(
        await ConnectorHostPermissionWizard.run(
            fixture.identity.configurationFile,
            fixture.tasks,
            questions,
            new AbortController().signal,
        ),
    ).toBe(false);
    expect(questions.panels[0]?.title).toBe('Update full computer access?');
    expect(questions.selections[0]?.initialValue).toBe(ConnectorApproval.NotNow);
    expect(await readFile(file)).toEqual(bytes);
    expect(await ConnectorHostGrant.read(fixture.identity)).toEqual(previous);
});

it('explicitly approving the upgrade enables snapshots while preserving the account and journal', async (): Promise<void> => {
    await using fixture: ConnectorHostFixture = await ConnectorHostFixture.create();
    const previous: ConnectorHostLocalGrant = await legacyGrant(fixture);
    const questions: ConnectorPromptFixture = new ConnectorPromptFixture([ConnectorApproval.Allow]);
    expect(
        await ConnectorHostPermissionWizard.run(
            fixture.identity.configurationFile,
            fixture.tasks,
            questions,
            new AbortController().signal,
        ),
    ).toBe(true);
    const current: ConnectorHostLocalGrant | null = await ConnectorHostGrant.read(fixture.identity);
    expect(current?.profile.tools).toContain(ConnectorHostTool.DesktopSnapshot);
    expect(current?.profile.grantRevision).toBe(previous.profile.grantRevision + 1n);
    expect(current?.profile.grantId).toBe(previous.profile.grantId);
    expect(current?.journalId).toBe(previous.journalId);
    expect(current?.environmentId).toBe(previous.environmentId);
    expect(current?.enrollmentId).toBe(previous.enrollmentId);
    expect(
        await ConnectorHostPermissionWizard.matches(
            fixture.identity.configurationFile,
            fixture.tasks,
        ),
    ).toBe(true);
});

it('a current approval reconnects without renewal and a disabled approval stays disabled', async (): Promise<void> => {
    await using fixture: ConnectorHostFixture = await ConnectorHostFixture.create();
    await fixture.grant();
    await fixture.persist();
    expect(
        await ConnectorHostPermissionWizard.matches(
            fixture.identity.configurationFile,
            fixture.tasks,
        ),
    ).toBe(true);
    await fixture.grant(false);
    expect(await ConnectorHostPermissionWizard.turnedOff(fixture.identity.configurationFile)).toBe(
        true,
    );
    expect(
        await ConnectorHostPermissionWizard.matches(
            fixture.identity.configurationFile,
            fixture.tasks,
        ),
    ).toBe(false);
});
