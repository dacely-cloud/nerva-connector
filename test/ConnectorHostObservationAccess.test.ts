// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

import { randomBytes } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { expect, it, vi, type MockInstance } from 'vitest';
import { ConnectorHostObservationFixture as Fixture } from './support/ConnectorHostObservationFixture.js';
import { ConnectorHostObservationTranscript as Transcript } from 'nerva-connector-protocol/protocol/ConnectorHostObservationTranscript.js';
import type { ConnectorHostObservationPermit as Permit } from 'nerva-connector-protocol/protocol/ConnectorHostObservation.js';
import type {
    ConnectorHostObservationConnection as Connection,
    ConnectorHostObservationOwned as Owned,
} from '../src/runtime/ConnectorHostObservationOwners.js';
import { ConnectorHostGrant } from '../src/runtime/ConnectorHostGrant.js';
import { type ConnectorHostLocalGrant } from '../src/runtime/ConnectorHostGrantTypes.js';

it.skipIf(process.platform !== 'linux')(
    'uses the actual operation clock rather than a captured old timestamp when reauthorizing an expired read permit',
    async (): Promise<void> => {
        await using fixture: Fixture = await Fixture.create();
        const issuedAtMs: bigint = BigInt(Date.now());
        const permit: Permit = fixture.permit({ issuedAtMs, expiresAtMs: issuedAtMs + 20n });
        const stale: Connection = { ...fixture.connection, nowMs: issuedAtMs + 1n };
        await delay(30);
        await expect(
            fixture.host.observe(JSON.parse(Transcript.encode(permit)), stale),
        ).rejects.toThrow('denied');
    },
);

it.skipIf(process.platform !== 'linux')(
    'cannot advance native generation from a stale companion after an asynchronous consent check',
    async (): Promise<void> => {
        await using fixture: Fixture = await Fixture.create();
        const held: PromiseWithResolvers<ConnectorHostLocalGrant | null> =
            Promise.withResolvers<ConnectorHostLocalGrant | null>();
        const read: MockInstance<typeof ConnectorHostGrant.read> = vi
            .spyOn(ConnectorHostGrant, 'read')
            .mockReturnValueOnce(held.promise);
        const stale: Promise<Owned> = fixture.host.observe(
            JSON.parse(Transcript.encode(fixture.permit({ generation: 99n }))),
            fixture.connection,
        );
        const rejected: Promise<void> = expect(stale).rejects.toThrow('companion');
        const current: Connection = {
            ...fixture.connection,
            companionNonce: randomBytes(32).toString('base64url'),
            nowMs: BigInt(Date.now()),
        };
        try {
            await vi.waitFor((): void => expect(read).toHaveBeenCalledOnce(), {
                timeout: 5000,
                interval: 10,
            });
            fixture.activate(current);
            held.resolve(fixture.grant);
            await rejected;
        } finally {
            held.resolve(fixture.grant);
            read.mockRestore();
        }
        const permit: Permit = fixture.permit({
            companionNonce: current.companionNonce,
            generation: 1n,
        });
        expect(
            (await fixture.host.observe(JSON.parse(Transcript.encode(permit)), current)).permit
                .generation,
        ).toBe(1n);
    },
);
