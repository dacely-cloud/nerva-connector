// SPDX-FileCopyrightText: 2026 Dacely <business@dacely.com>
// SPDX-License-Identifier: LicenseRef-Proprietary

import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { ExecutionFixture } from './support/ExecutionFixture.js';
import { setup } from './support/ExecutionSetup.js';
import { ExecutionIdentity } from './support/ExecutionIdentity.js';
import { deadlineLease, type ExecutionDeadlineLease } from './support/ExecutionDeadlineLease.js';
import { ExecutionConfiguration } from '../src/execution/ExecutionConfiguration.js';
import type { ExecutionPolicy } from '../src/execution/ExecutionPolicy.js';
import { ExecutionClient } from '../src/execution/ExecutionClient.js';
import { ExecutionJournalInstallation } from '../src/execution/ExecutionJournalInstallation.js';
import type { ExecutionClientSettings } from '../src/execution/ExecutionClientSettings.js';
import type {
    ExecutionPermit,
    ExecutionCompletion,
} from 'nerva-connector-protocol/execution/ExecutionJobs.js';
import { ExecutionTermination } from 'nerva-connector-protocol/execution/ExecutionTypes.js';

const helper: string | undefined = process.env['NERVA_CONNECTOR_EXEC_HELPER'];

it.skipIf(helper === undefined)(
    'actual execution accepts a genuinely signed longer running deadline but never an expired, foreign or overlong start lease',
    async (): Promise<void> => {
        if (helper === undefined) {
            throw new Error('Explicit frozen execution helper required');
        }
        const pinned: string = createHash('sha256')
            .update(await readFile(helper))
            .digest('hex');
        expect(pinned).toBe('d1ef0ecd1dd719326385b91a3b8058ee1c5579a55784dd27092a34cdfcccf144');
        try {
            await using fixture: ExecutionFixture = await ExecutionFixture.create(helper);
            const settings: ExecutionClientSettings = await setup(fixture);
            using identity: ExecutionIdentity = new ExecutionIdentity(fixture.directory, settings);
            await ExecutionJournalInstallation.initialize(identity.identity, settings);
            await using policy: ExecutionPolicy = await ExecutionConfiguration.loadPolicy(
                identity.identity,
                settings,
            );
            await using client: ExecutionClient = await ExecutionClient.load(
                identity.identity,
                settings,
                policy,
            );
            const target: ExecutionDeadlineLease = deadlineLease(
                identity.identity,
                identity.authority,
            );
            using session: typeof target.session = target.session;
            const now: bigint = BigInt(Date.now());
            const original: ExecutionPermit = identity.sign({
                ...identity.permit(client.profile, target.lease),
                issuedAtMs: now,
                expiresAtMs: now + 3000n,
                executionDeadlineMs: now + 20000n,
            });
            expect(original.executionDeadlineMs).toBeGreaterThan(target.lease.expiresAtMs);
            const before: Buffer = await readFile(
                join(settings.stateDirectory, settings.lane, 'execution-journal'),
            );
            const candidates: readonly ExecutionPermit[] = [
                identity.sign({ ...original, expiresAtMs: target.lease.expiresAtMs + 1n }),
                identity.sign({ ...original, issuedAtMs: now - 2000n, expiresAtMs: now - 1n }),
                identity.sign({ ...original, leaseId: Buffer.alloc(32, 3).toString('base64url') }),
                identity.sign({ ...original, executionDeadlineMs: now + 30001n }),
            ];
            for (const candidate of candidates) {
                await expect(client.execute(candidate, session)).rejects.toThrow();
            }
            expect(
                await readFile(join(settings.stateDirectory, settings.lane, 'execution-journal')),
            ).toEqual(before);
            expect(await readdir(fixture.workspace)).not.toContain('effects');
            const completion: ExecutionCompletion = await client.execute(original, session);
            expect(completion.response).toMatchObject({
                termination: ExecutionTermination.Exited,
                exitCode: 0,
                failure: null,
            });
            expect(await readFile(join(fixture.workspace, 'effects'), 'utf8')).toBe('x');
            expect(original.executionDeadlineMs).toBe(now + 20000n);
        } finally {
            expect(
                createHash('sha256')
                    .update(await readFile(helper))
                    .digest('hex'),
            ).toBe(pinned);
        }
    },
    30000,
);
