// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, it, vi, type MockInstance } from 'vitest';
import { HostWorkspace } from '../src/host/HostWorkspace.js';
import type { HostDesktopFrame } from '../src/host/HostApplication.js';
import {
    ConnectorHostTool,
    ConnectorHostOutcome,
    type ConnectorHostPermit,
    type ConnectorHostCompletion,
    type ConnectorHostResponse,
} from 'nerva-connector-protocol/protocol/ConnectorHost.js';
import { ConnectorHostCodec } from 'nerva-connector-protocol/protocol/ConnectorHostCodec.js';
import { ConnectorHostGrant } from '../src/runtime/ConnectorHostGrant.js';
import type { ConnectorHostLocalGrant } from '../src/runtime/ConnectorHostGrantTypes.js';
import { ConnectorClientHost } from '../src/runtime/ConnectorClientHost.js';
import { ProtectedFileLimits } from '../src/local/ProtectedFileLimits.js';
import { ConnectorHostFixture } from './support/ConnectorHostFixture.js';

const supported: boolean =
    process.platform === 'linux' || process.platform === 'darwin' || process.platform === 'win32';

it.skipIf(!supported)(
    'a maximum inline image survives encrypted completion, process replacement and exact acknowledgment without capturing twice',
    async (): Promise<void> => {
        await using fixture: ConnectorHostFixture = await ConnectorHostFixture.create();
        const grant: ConnectorHostLocalGrant = await fixture.grant();
        const image: Buffer = Buffer.alloc(640000, 42);
        image[0] = 255;
        image[1] = 216;
        image[image.length - 2] = 255;
        image[image.length - 1] = 217;
        const frame: HostDesktopFrame = {
            mimeType: 'image/jpeg',
            data: image.toString('base64'),
            width: 3840,
            height: 2160,
            sourceX: -1920,
            sourceY: 0,
            sourceWidth: 3840,
            sourceHeight: 2160,
        };
        const capture: MockInstance<HostWorkspace['desktopSnapshot']> = vi
            .spyOn(HostWorkspace.prototype, 'desktopSnapshot')
            .mockResolvedValue(frame);
        try {
            const host: ConnectorClientHost = await fixture.open();
            const permit: ConnectorHostPermit = fixture.permit(
                grant,
                1n,
                ConnectorHostTool.DesktopSnapshot,
                '{}',
            );
            const completion: ConnectorHostCompletion = await host.execute(
                permit,
                permit.leaseId,
                permit.expiresAtMs,
            );
            expect(completion.response.outcome).toBe(ConnectorHostOutcome.Succeeded);
            expect(completion.response.resultJson).toBe(ConnectorHostCodec.encode(frame));
            const file: string = join(
                ConnectorHostGrant.directory(fixture.identity),
                'host-journal',
            );
            const encrypted: Buffer = await readFile(file);
            expect(encrypted.length).toBeGreaterThan(1048576);
            expect(encrypted.includes(Buffer.from(frame.data))).toBe(false);
            await host[Symbol.asyncDispose]();
            const restarted: ConnectorClientHost = await fixture.open();
            const replayed: ConnectorHostCompletion = await restarted.execute(
                permit,
                permit.leaseId,
                permit.expiresAtMs,
            );
            expect(replayed.response).toEqual(completion.response);
            expect(capture).toHaveBeenCalledTimes(1);
            await restarted.acknowledge(fixture.acknowledgment(replayed), replayed.leaseId);
            expect(restarted.journal.snapshot.pending).toBeNull();
            expect(restarted.journal.snapshot.acknowledgedSequence).toBe(1n);
            expect((await stat(file)).size).toBeLessThan(4096);
        } finally {
            capture.mockRestore();
        }
    },
);

it.skipIf(!supported)(
    'the largest escaped response and request remain complete and immutable across encrypted journal recovery',
    async (): Promise<void> => {
        await using fixture: ConnectorHostFixture = await ConnectorHostFixture.create();
        const grant: ConnectorHostLocalGrant = await fixture.grant();
        const host: ConnectorClientHost = await fixture.open();
        const argumentsJson: string = JSON.stringify({ data: '\\'.repeat(32762) }).padEnd(
            65536,
            ' ',
        );
        const permit: ConnectorHostPermit = fixture.permit(
            grant,
            1n,
            ConnectorHostTool.ComputerInfo,
            argumentsJson,
        );
        const resultJson: string = JSON.stringify({ data: '\\'.repeat(524282) }).padEnd(
            1048576,
            ' ',
        );
        const response: ConnectorHostResponse = {
            outcome: ConnectorHostOutcome.Succeeded,
            resultJson,
            errorCode: null,
        };
        expect(await host.journal.begin(permit)).toBe(true);
        await host.journal.complete(permit, response);
        const file: string = join(ConnectorHostGrant.directory(fixture.identity), 'host-journal');
        const bytes: bigint = (await stat(file, { bigint: true })).size;
        expect(bytes).toBeGreaterThan(2n * 1048576n);
        expect(bytes).toBeLessThanOrEqual(BigInt(ProtectedFileLimits.hostRecordBytes));
        await host[Symbol.asyncDispose]();
        const restarted: ConnectorClientHost = await fixture.open();
        expect(restarted.journal.snapshot.pending?.response).toEqual(response);
        expect(restarted.journal.snapshot.pending?.request.argumentsJson).toBe(argumentsJson);
        expect(await restarted.journal.begin(permit)).toBe(false);
        await expect(
            restarted.journal.complete(permit, { ...response, resultJson: '{}' }),
        ).rejects.toThrow('changed');
    },
);
