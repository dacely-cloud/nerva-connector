// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

import { ExecutionAppArmorInstaller } from '../src/execution/ExecutionAppArmorInstaller.js';
import { ExecutionConfiguration } from '../src/execution/ExecutionConfiguration.js';
import { ExecutionPolicy } from '../src/execution/ExecutionPolicy.js';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { expect, it } from 'vitest';
import { ExecutionFixture } from './support/ExecutionFixture.js';
import { ExecutionIdentity } from './support/ExecutionIdentity.js';
import { setup } from './support/ExecutionSetup.js';
import { ExecutionClient } from '../src/execution/ExecutionClient.js';
import type { ExecutionClientSettings } from '../src/execution/ExecutionClientSettings.js';
import { ExecutionJournalInstallation } from '../src/execution/ExecutionJournalInstallation.js';
import { ExecutionDelivery } from '../src/execution/ExecutionDelivery.js';
import { type ExecutionDeliveryLink } from '../src/execution/ExecutionDeliveryLink.js';
import type { ExecutionPermit, ExecutionCompletion } from '../src/execution/ExecutionJobs.js';
import { ExecutionFailure } from '../src/execution/ExecutionTypes.js';
import {
    ConnectorFrameKind,
    type ConnectorClientFrame,
} from '../src/protocol/ConnectorTransport.js';
import type { ConnectorDeviceLease } from 'nerva-connector-protocol/protocol/ConnectorDevice.js';

const helper: string | undefined = process.env['NERVA_CONNECTOR_EXEC_HELPER'];

it.skipIf(helper === undefined)(
    'successive socket replacements preserve one running original and a signed concurrent stop sends exactly one completion to the latest lease',
    async (): Promise<void> => {
        if (helper === undefined) {
            throw new Error('Explicit native execution helper required');
        }
        await using fixture: ExecutionFixture = await ExecutionFixture.create(helper);
        const settings: ExecutionClientSettings = await setup(fixture);
        using authority: ExecutionIdentity = new ExecutionIdentity(fixture.directory, settings);
        await using policy: ExecutionPolicy = await ExecutionConfiguration.loadPolicy(
            authority.identity,
            settings,
        );
        await ExecutionAppArmorInstaller.assertInstalled(policy.definition);
        await ExecutionJournalInstallation.initialize(authority.identity, settings);
        const client: ExecutionClient = await ExecutionClient.load(
            authority.identity,
            settings,
            policy,
        );
        await using delivery: ExecutionDelivery = new ExecutionDelivery(client);
        const responses: ConnectorClientFrame[] = [];
        const result: PromiseWithResolvers<ExecutionCompletion> =
            Promise.withResolvers<ExecutionCompletion>();
        let closed: number = 0;
        const link: (lease: ConnectorDeviceLease) => ExecutionDeliveryLink = (
            lease: ConnectorDeviceLease,
        ): ExecutionDeliveryLink => ({
            session: authority.session(lease),
            leaseId: lease.leaseId,
            send: (frame: ConnectorClientFrame): void => {
                responses.push(frame);
                if (frame.kind === ConnectorFrameKind.ExecutionResult) {
                    result.resolve(frame.completion);
                }
            },
            close: (): void => {
                closed++;
            },
        });
        const lease: ConnectorDeviceLease = authority.lease();
        let current: ExecutionDeliveryLink = link(lease);
        delivery.activate(current);
        const permit: ExecutionPermit = authority.permit(
            client.publication(current.session).profile,
            lease,
            'effect-hold',
        );
        delivery.receive({ kind: ConnectorFrameKind.ExecutionPermit, permit }, current);
        const deadline: number = performance.now() + 3000;
        while (!(await readdir(fixture.workspace)).includes('effect-hold')) {
            if (performance.now() >= deadline) {
                throw new Error('Native original did not reach its marker');
            }
            await delay(10);
        }
        let replacement: ConnectorDeviceLease = lease;
        for (let index: number = 0; index < 12; index++) {
            delivery.detach(current);
            replacement = authority.lease();
            current = link(replacement);
            delivery.activate(current);
            const now: bigint = BigInt(Date.now());
            delivery.receive(
                {
                    kind: ConnectorFrameKind.ExecutionPermit,
                    permit: authority.sign({
                        ...permit,
                        leaseId: replacement.leaseId,
                        issuedAtMs: now,
                        expiresAtMs: now + 1000n,
                        executionDeadlineMs: now + 5000n,
                    }),
                },
                current,
            );
        }
        expect(responses).toHaveLength(0);
        expect(
            (await readdir(fixture.delegation)).filter((name: string): boolean =>
                name.startsWith('exec-'),
            ),
        ).toHaveLength(1);
        delivery.receive(
            {
                kind: ConnectorFrameKind.ExecutionCancellation,
                cancellation: authority.cancel(permit, replacement),
            },
            current,
        );
        const completion: ExecutionCompletion = await result.promise;
        expect(completion.leaseId).toBe(replacement.leaseId);
        expect(completion.response.failure).toBe(ExecutionFailure.Cancelled);
        await delivery[Symbol.asyncDispose]();
        expect(responses).toHaveLength(1);
        expect(closed).toBe(0);
        expect(await readFile(join(fixture.workspace, 'effects'), 'utf8')).toBe('x');
        expect(
            (await readdir(fixture.delegation)).filter((name: string): boolean =>
                name.startsWith('exec-'),
            ),
        ).toEqual([]);
    },
);
