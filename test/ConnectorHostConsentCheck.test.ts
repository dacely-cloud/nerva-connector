// SPDX-FileCopyrightText: 2026 Dacely <business@dacely.com>
// SPDX-License-Identifier: LicenseRef-Proprietary

import { chmod, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { expect, it } from 'vitest';
import { ConnectorClientHost } from '../src/runtime/ConnectorClientHost.js';
import { ConnectorConnectionLog } from '../src/runtime/ConnectorConnectionLog.js';
import { ConnectorHostGrant } from '../src/runtime/ConnectorHostGrant.js';
import { ConnectorHostFixture } from './support/ConnectorHostFixture.js';

/** How the saved approval is disturbed under a running owner. */
const Disturbance = {
    Removed: 'removed',
    Permissions: 'permissions',
} as const;

/** Allowed values derive from the runtime mapping. */
type Disturbance = (typeof Disturbance)[keyof typeof Disturbance];

it.skipIf(process.platform !== 'linux').each(Object.values(Disturbance))(
    'a %s saved approval retires the running host owner once, closes its link and logs why',
    async (disturbance: Disturbance): Promise<void> => {
        await using fixture: ConnectorHostFixture = await ConnectorHostFixture.create();
        await fixture.grant();
        const log: ConnectorConnectionLog = new ConnectorConnectionLog(
            join(fixture.directory, 'connection.log'),
        );
        const loaded: ConnectorClientHost | null = await ConnectorClientHost.load(
            fixture.identity,
            null,
            null,
            log,
        );
        if (loaded === null) {
            throw new Error('Explicit host fixture grant required');
        }
        await using host: ConnectorClientHost = loaded;
        const closed: PromiseWithResolvers<undefined> = Promise.withResolvers<undefined>();
        host.bindLink((): void => closed.resolve(undefined));
        const directory: string = ConnectorHostGrant.directory(fixture.identity);
        if (disturbance === Disturbance.Removed) {
            await rm(join(directory, 'grant.json'));
        } else {
            await chmod(directory, 0o770);
        }
        try {
            await closed.promise;
            expect(host.failed).toBe(true);
            await delay(2500);
        } finally {
            await chmod(directory, 0o700);
        }
        await log.flush();
        const lines: readonly Readonly<Record<string, unknown>>[] = (
            await readFile(log.path, 'utf8')
        )
            .trim()
            .split('\n')
            .map((line: string): Readonly<Record<string, unknown>> => {
                const value: unknown = JSON.parse(line);
                if (typeof value !== 'object' || value === null) {
                    throw new Error('Connection log line must be an object');
                }
                return Object.fromEntries(Object.entries(value));
            })
            .filter(
                (line: Readonly<Record<string, unknown>>): boolean =>
                    line['event'] === 'host-consent-check-failed',
            );
        expect(lines).toHaveLength(1);
        expect(lines[0]?.['check']).toBe(
            disturbance === Disturbance.Removed ? 'removed' : 'unreadable',
        );
        if (disturbance === Disturbance.Permissions) {
            expect(lines[0]?.['reason']).toEqual(expect.stringContaining('untrusted'));
        }
    },
    15000,
);
