// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

import type { ConnectorDisconnect } from '../src/runtime/ConnectorDisconnect.js';
import { writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import type { Duplex } from 'node:stream';
import { join } from 'node:path';
import { afterEach, expect, it, vi, type MockInstance } from 'vitest';
import { SignaturePurpose } from 'nerva-connector-protocol/identity/IdentityFormat.js';
import { ConnectorClientConnection } from '../src/runtime/ConnectorClientConnection.js';
import type { ConnectorClientFiles } from '../src/runtime/ConnectorClientFiles.js';
import { ConnectorClientState } from '../src/runtime/ConnectorClientState.js';
import type { ConnectorActivityHandle } from '../src/runtime/ConnectorActivity.js';
import type { ConnectorCapturedFileEffect } from '../src/runtime/ConnectorEffectContext.js';
import { ConnectorFileProof } from 'nerva-connector-protocol/protocol/ConnectorFileProof.js';
import { ConnectorFilesystem } from '../src/runtime/ConnectorFilesystem.js';
import type { ConnectorDeviceLease } from 'nerva-connector-protocol/protocol/ConnectorDevice.js';
import type { ConnectorFileResponse } from 'nerva-connector-protocol/protocol/ConnectorFiles.js';
import { ConnectorFileAction } from 'nerva-connector-protocol/protocol/ConnectorFileTypes.js';
import {
    ConnectorFrameKind,
    ConnectorTransportLimits,
    type ConnectorClientFrame,
    type ConnectorFileProfileFrame,
    type ConnectorFileResultFrame,
} from '../src/protocol/ConnectorTransport.js';
import { SystemInfo } from '../src/system/SystemInfo.js';
import {
    GpuInventoryState,
    SystemPlatform,
    type SystemSpecification,
} from 'nerva-connector-protocol/system/SystemSpecification.js';
import {
    ConnectorFileLaneFixture,
    type ConnectorFileOriginal,
} from './support/ConnectorFileLaneFixture.js';
import { ConnectorRenewalPeer } from './support/ConnectorRenewalPeer.js';
import { SocketFixture } from './support/SocketFixture.js';

const helper: string | undefined = process.env['NERVA_CONNECTOR_FILES_HELPER'];

/** Inventory is unrelated to file delivery and performs no machine or driver probing. */
const inventory: SystemSpecification = {
    observedAtMs: '1',
    platform: SystemPlatform.Linux,
    architecture: 'x64',
    osRelease: 'fixture',
    cpuModel: 'fixture',
    logicalCpuCount: 1,
    totalMemoryBytes: '1',
    availableMemoryBytes: '1',
    gpuState: GpuInventoryState.Unavailable,
    gpus: [],
};

/** The bytes the single read returns. */
const contents: string = 'renewal contents';

afterEach((): void => {
    vi.restoreAllMocks();
});

/** A real file owner whose one native dispatch waits until the test releases it. */
interface FileLaneRun {
    readonly peer: ConnectorRenewalPeer;
    readonly states: readonly ConnectorClientState[];
    readonly stop: AbortController;
    readonly running: Promise<ConnectorDisconnect>;
    readonly entered: Promise<undefined>;
    readonly release: () => void;
    readonly dispatches: () => number;
    readonly permits: () => number;
}

/** Starts one file-capable connection whose leases follow the supplied lifetimes. */
async function start(
    fixture: ConnectorFileLaneFixture,
    tls: SocketFixture,
    lifetimesMs: readonly bigint[],
): Promise<FileLaneRun> {
    vi.spyOn(SystemInfo, 'read').mockResolvedValue(inventory);
    const entered: PromiseWithResolvers<undefined> = Promise.withResolvers<undefined>();
    const release: PromiseWithResolvers<undefined> = Promise.withResolvers<undefined>();
    const native: MockInstance<ConnectorFilesystem['dispatchBound']> = vi
        .spyOn(ConnectorFilesystem.prototype, 'dispatchBound')
        .mockImplementation(async function (
            this: ConnectorFilesystem,
            json: string,
            stagingId: string | undefined,
            effect: ConnectorCapturedFileEffect,
        ): Promise<ConnectorFileResponse> {
            native.mockRestore();
            entered.resolve(undefined);
            await release.promise;
            return await this.dispatchBound(json, stagingId, effect);
        });
    const verify: MockInstance<typeof ConnectorFileProof.verify> = vi.spyOn(
        ConnectorFileProof,
        'verify',
    );
    let dispatches: number = 0;
    const files: ConnectorClientFiles = await fixture.open({
        begin: (): ConnectorActivityHandle => {
            dispatches++;
            return { finish: (): void => undefined };
        },
        ended: (): void => undefined,
    });
    const states: ConnectorClientState[] = [];
    const connection: ConnectorClientConnection = new ConnectorClientConnection(
        { ...fixture.identity, ca: tls.certificate },
        files,
        null,
        (state: ConnectorClientState): void => {
            states.push(state);
        },
    );
    const address: AddressInfo | string | null = tls.server.address();
    if (address === null || typeof address === 'string') {
        throw new Error('Actual TLS listener required');
    }
    const stop: AbortController = new AbortController();
    const running: Promise<ConnectorDisconnect> = connection.run(
        'wss://localhost:' + address.port.toString(),
        stop.signal,
    );
    const socket: Duplex = await tls.upgraded.promise;
    return {
        peer: new ConnectorRenewalPeer(socket, fixture.peer, lifetimesMs, (): readonly [] => []),
        states,
        stop,
        running,
        entered: entered.promise,
        release: (): void => release.resolve(undefined),
        dispatches: (): number => dispatches,
        permits: (): number =>
            verify.mock.calls.filter(
                (call: Parameters<typeof ConnectorFileProof.verify>): boolean =>
                    call[2] === SignaturePurpose.OperationFilePermit,
            ).length,
    };
}

/** Waits for the file profile the device publishes on a lease it has not published before. */
async function publication(
    peer: ConnectorRenewalPeer,
    published: readonly string[],
): Promise<ConnectorDeviceLease> {
    const profile: ConnectorFileProfileFrame = await peer.next(
        (frame: ConnectorClientFrame): frame is ConnectorFileProfileFrame =>
            frame.kind === ConnectorFrameKind.FileProfile &&
            !published.includes(frame.publication.leaseId),
    );
    expect(profile.publication.leaseId).toBe(peer.lease.leaseId);
    return peer.lease;
}

it.skipIf(helper === undefined || process.platform !== 'linux')(
    'a file operation still running across three renewals attaches every re-delivery and replies once on the latest lease',
    async (): Promise<void> => {
        await using fixture: ConnectorFileLaneFixture = await ConnectorFileLaneFixture.create();
        await using tls: SocketFixture = await SocketFixture.create(
            ConnectorTransportLimits.protocol,
        );
        await writeFile(join(fixture.files.root, 'source.txt'), contents, { mode: 0o600 });
        const original: ConnectorFileOriginal = fixture.original('source.txt');
        const run: FileLaneRun = await start(fixture, tls, [2000n, 2000n, 2000n, 30000n]);
        try {
            const leases: string[] = [];
            for (let delivery: number = 0; delivery < 4; delivery++) {
                const lease: ConnectorDeviceLease = await publication(run.peer, leases);
                leases.push(lease.leaseId);
                run.peer.send({
                    kind: ConnectorFrameKind.FilePermit,
                    permit: fixture.deliver(original, lease),
                });
                if (delivery === 0) {
                    await run.entered;
                }
            }
            await vi.waitFor((): void => {
                expect(run.permits()).toBe(4);
            });
            expect(
                run.peer.frames.some(
                    (frame: ConnectorClientFrame): boolean =>
                        frame.kind === ConnectorFrameKind.FileResult,
                ),
            ).toBe(false);
            run.release();
            const result: ConnectorFileResultFrame = await run.peer.next(
                (frame: ConnectorClientFrame): frame is ConnectorFileResultFrame =>
                    frame.kind === ConnectorFrameKind.FileResult,
            );
            expect(result.completion.leaseId).toBe(leases[3]);
            expect(result.completion.jobId).toBe(original.jobId);
            expect(result.completion.dispatchId).toBe(original.dispatchId);
            expect(result.completion.requestHash).toBe(original.requestHash);
            const response: ConnectorFileResponse = result.completion.response;
            if (!response.ok || response.result.action !== ConnectorFileAction.Read) {
                throw new Error('Successful read result required');
            }
            expect(Buffer.from(response.result.dataBase64, 'base64').toString()).toBe(contents);
            expect(run.dispatches()).toBe(1);
            expect(run.states).toEqual([
                ConnectorClientState.Authenticated,
                ConnectorClientState.Authenticated,
                ConnectorClientState.Authenticated,
                ConnectorClientState.Authenticated,
            ]);
            expect(
                run.peer.frames.filter(
                    (frame: ConnectorClientFrame): boolean =>
                        frame.kind === ConnectorFrameKind.FileResult,
                ),
            ).toHaveLength(1);
            expect(run.peer.ended).toBe(false);
            run.peer.assertHealthy();
        } finally {
            run.release();
            run.stop.abort();
            await run.running;
        }
    },
    30000,
);

/** A running original admits no other work: neither another original nor a second copy on its own lease. */
const Intrusion = {
    OtherOriginal: 'another original on the renewed lease',
    SameLease: 'the same original again on its own lease',
} as const;
/** Each intrusion that must still retire the socket. */
type Intrusion = (typeof Intrusion)[keyof typeof Intrusion];

it.skipIf(helper === undefined || process.platform !== 'linux').each(Object.values(Intrusion))(
    'a running file operation still closes the socket for %s',
    async (intrusion: Intrusion): Promise<void> => {
        await using fixture: ConnectorFileLaneFixture = await ConnectorFileLaneFixture.create();
        await using tls: SocketFixture = await SocketFixture.create(
            ConnectorTransportLimits.protocol,
        );
        await writeFile(join(fixture.files.root, 'source.txt'), contents, { mode: 0o600 });
        const original: ConnectorFileOriginal = fixture.original('source.txt');
        const run: FileLaneRun = await start(fixture, tls, [2000n, 30000n]);
        try {
            const first: ConnectorDeviceLease = await publication(run.peer, []);
            run.peer.send({
                kind: ConnectorFrameKind.FilePermit,
                permit: fixture.deliver(original, first),
            });
            await run.entered;
            if (intrusion === Intrusion.OtherOriginal) {
                const second: ConnectorDeviceLease = await publication(run.peer, [first.leaseId]);
                run.peer.send({
                    kind: ConnectorFrameKind.FilePermit,
                    permit: fixture.deliver(fixture.original('source.txt'), second),
                });
            } else {
                run.peer.send({
                    kind: ConnectorFrameKind.FilePermit,
                    permit: fixture.deliver(original, first),
                });
            }
            await run.peer.closed;
            expect(
                run.peer.frames.some(
                    (frame: ConnectorClientFrame): boolean =>
                        frame.kind === ConnectorFrameKind.FileResult,
                ),
            ).toBe(false);
            run.release();
            run.stop.abort();
            await run.running;
            expect(run.dispatches()).toBe(1);
            run.peer.assertHealthy();
        } finally {
            run.release();
            run.stop.abort();
            await run.running;
        }
    },
    30000,
);
