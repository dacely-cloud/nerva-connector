// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';
import { ConnectorWindowsCompiler } from '../script/ConnectorWindowsCompiler.ts';
import { ConnectorActivityFeed } from '../src/runtime/ConnectorActivityFeed.js';
import {
    ConnectorActivityState,
    type ConnectorActivityHandle,
} from '../src/runtime/ConnectorActivity.js';
import { ConnectorActivityText } from '../src/cli/ConnectorActivityText.js';
import type { ConnectorStyledRow } from '../src/cli/ConnectorLogo.js';
import { ConnectorHostTool } from 'nerva-connector-protocol/protocol/ConnectorHost.js';

it('only an observed application window gets a successful activity checkmark', (): void => {
    for (const [status, windowObserved, expected] of [
        ['not-found', false, ConnectorActivityState.Failed],
        ['ambiguous', false, ConnectorActivityState.Failed],
        ['launched', false, ConnectorActivityState.Unconfirmed],
        ['launched', true, ConnectorActivityState.Done],
    ] as const) {
        const feed: ConnectorActivityFeed = new ConnectorActivityFeed();
        const handle: ConnectorActivityHandle = feed.begin({
            jobId: 'application-test',
            toolName: ConnectorHostTool.ApplicationOpen,
            argumentsJson: JSON.stringify({ name: 'grandma 3' }),
        });
        handle.finish(
            true,
            JSON.stringify({ status, windowObserved, candidates: [], screenshot: null }),
        );
        const entry: NonNullable<ReturnType<ConnectorActivityFeed['snapshot']>['recent'][number]> =
            feed.snapshot().recent[0];
        expect(entry.state).toBe(expected);
        const rendered: string = ConnectorActivityText.entry(entry, 100, Date.now(), 0)
            .map((row: ConnectorStyledRow): string => row.ansi)
            .join('\n');
        expect(rendered.includes('✓')).toBe(expected === ConnectorActivityState.Done);
        expect(rendered.includes('unconfirmed')).toBe(
            expected === ConnectorActivityState.Unconfirmed,
        );
    }
});

it.skipIf(process.platform !== 'linux' || !existsSync('/usr/bin/mcs'))(
    'the native installed-app matcher tolerates spacing, finds browser names and preserves ambiguity',
    async (): Promise<void> => {
        const directory: string = await mkdtemp(join(homedir(), 'nerva-app-match-'));
        try {
            const executable: string = join(directory, 'match.exe');
            await ConnectorWindowsCompiler.compile({
                sources: [
                    resolve('test/support/WindowsApplicationCatalogFixture.cs'),
                    resolve('native/windows/HostApplicationCatalog.cs'),
                    resolve('native/windows/HostApplicationVersionFamily.cs'),
                ],
                entrypoint: 'NexaConnectorApplicationCatalogFixture',
                destination: executable,
            });
            const result: Awaited<ReturnType<typeof execFile.__promisify__>> = await promisify(
                execFile,
            )('/usr/bin/mono', [executable], { timeout: 10000, maxBuffer: 4096 });
            expect(result.stdout.toString()).toContain('ambiguity_preserved=true');
            expect(result.stdout.toString()).toContain('newest_regular_version=true');
            expect(result.stdout.toString()).toContain('localized_calculator=true');
        } finally {
            await rm(directory, { recursive: true, force: true });
        }
    },
);
