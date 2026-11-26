// SPDX-FileCopyrightText: 2026 Dacely <business@dacely.com>
// SPDX-License-Identifier: LicenseRef-Proprietary

import { ConnectorDisconnect } from '../src/runtime/ConnectorDisconnect.js';
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import type { Duplex } from 'node:stream';
import { join } from 'node:path';
import { afterEach, expect, it, vi, type MockInstance } from 'vitest';
import { SignaturePurpose } from 'nerva-connector-protocol/identity/IdentityFormat.js';
import type { HostJsonObject } from '../src/host/HostMcpProtocol.js';
import { HostMcpWorkspaceTools } from '../src/host/HostMcpWorkspaceTools.js';
import type { HostReadObservationStart } from '../src/host/HostReadObservationStart.js';
import { ConnectorClientConnection } from '../src/runtime/ConnectorClientConnection.js';
import { ConnectorConnectionLog } from '../src/runtime/ConnectorConnectionLog.js';
import type { ConnectorClientHost } from '../src/runtime/ConnectorClientHost.js';
import type { ConnectorClientIdentity } from '../src/runtime/ConnectorClientConfiguration.js';
import { ConnectorClientState } from '../src/runtime/ConnectorClientState.js';
import type { ConnectorHostLocalGrant } from '../src/runtime/ConnectorHostGrantTypes.js';
import { ConnectorHostJournal } from '../src/runtime/ConnectorHostJournal.js';
import { ConnectorHostProof } from '../src/runtime/ConnectorHostProof.js';
import type { ConnectorDeviceLease } from 'nerva-connector-protocol/protocol/ConnectorDevice.js';
import {
    ConnectorHostOutcome,
    ConnectorHostTool,
    type ConnectorHostAcknowledgment,
    type ConnectorHostPermit,
} from 'nerva-connector-protocol/protocol/ConnectorHost.js';
import {
    ConnectorFrameKind,
    ConnectorTransportLimits,
    type ConnectorClientFrame,
    type ConnectorHostAcknowledgedFrame,
    type ConnectorHostProfileFrame,
    type ConnectorHostResultFrame,
    type ConnectorServerFrame,
} from '../src/protocol/ConnectorTransport.js';
import { SystemInfo } from '../src/system/SystemInfo.js';
import {
    GpuInventoryState,
    SystemPlatform,
    type SystemSpecification,
} from 'nerva-connector-protocol/system/SystemSpecification.js';
import { ConnectorHostFixture } from './support/ConnectorHostFixture.js';
import {
    ConnectorRenewalPeer,
    type ConnectorRenewalCrossing,
} from './support/ConnectorRenewalPeer.js';
import { SocketFixture } from './support/SocketFixture.js';

/** Inventory is unrelated to renewal delivery and performs no machine or driver probing. */
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

/** The first lease renews after about one second; the replacement outlives the test. */
const lifetimesMs: readonly bigint[] = [2000n, 30000n];

/** One append whose single local effect proves the dropped delivery was neither executed nor lost. */
const append: string = JSON.stringify({
    path: 'output.txt',
    mode: 'append',
    encoding: 'utf8',
    data: 'one effect\n',
});

afterEach((): void => {
    vi.restoreAllMocks();
});

/** A real paired host owner and TLS authority that renews the device lease on one socket. */
interface RenewalRun {
    readonly peer: ConnectorRenewalPeer;
    readonly states: readonly ConnectorClientState[];
    readonly stop: AbortController;
    readonly running: Promise<ConnectorDisconnect>;
}

/** Starts one host-capable connection whose renewal hello is answered with the supplied crossing frames. */
async function start(
    fixture: ConnectorHostFixture,
    host: ConnectorClientHost,
    tls: SocketFixture,
    crossing: ConnectorRenewalCrossing,
    lifetimes: readonly bigint[] = lifetimesMs,
    log: ConnectorConnectionLog | null = null,
): Promise<RenewalRun> {
    vi.spyOn(SystemInfo, 'read').mockResolvedValue(inventory);
    const states: ConnectorClientState[] = [];
    const identity: ConnectorClientIdentity = { ...fixture.identity, ca: tls.certificate };
    const connection: ConnectorClientConnection = new ConnectorClientConnection(
        identity,
        null,
        null,
        (state: ConnectorClientState): void => {
            states.push(state);
        },
        undefined,
        null,
        host,
        log,
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
        peer: new ConnectorRenewalPeer(socket, fixture.peer, lifetimes, crossing),
        states,
        stop,
        running,
    };
}

/** Re-signing a delivery wrapper binds the unchanged original to another lease. */
function deliver(
    fixture: ConnectorHostFixture,
    original: ConnectorHostPermit,
    lease: ConnectorDeviceLease,
): ConnectorServerFrame {
    const now: bigint = BigInt(Date.now());
    const limit: bigint = now + 10000n;
    return {
        kind: ConnectorFrameKind.HostPermit,
        permit: fixture.sign({
            ...original,
            leaseId: lease.leaseId,
            issuedAtMs: now,
            expiresAtMs: limit < lease.expiresAtMs ? limit : lease.expiresAtMs,
        }),
    };
}

it.skipIf(process.platform !== 'linux')(
    'a host permit sent on the replaced lease during renewal is dropped and its re-delivery runs once on the new lease',
    async (): Promise<void> => {
        await using fixture: ConnectorHostFixture = await ConnectorHostFixture.create();
        const grant: ConnectorHostLocalGrant = await fixture.grant();
        const host: ConnectorClientHost = await fixture.open();
        await using tls: SocketFixture = await SocketFixture.create(
            ConnectorTransportLimits.protocol,
        );
        const original: ConnectorHostPermit = fixture.permit(
            grant,
            1n,
            ConnectorHostTool.FileWrite,
            append,
        );
        const run: RenewalRun = await start(
            fixture,
            host,
            tls,
            (replaced: ConnectorDeviceLease): readonly ConnectorServerFrame[] => [
                deliver(fixture, original, replaced),
            ],
        );
        try {
            const initial: ConnectorHostProfileFrame = await run.peer.next(
                (frame: ConnectorClientFrame): frame is ConnectorHostProfileFrame =>
                    frame.kind === ConnectorFrameKind.HostProfile,
            );
            const renewed: ConnectorHostProfileFrame = await run.peer.next(
                (frame: ConnectorClientFrame): frame is ConnectorHostProfileFrame =>
                    frame.kind === ConnectorFrameKind.HostProfile &&
                    frame.publication.leaseId !== initial.publication.leaseId,
            );
            const second: ConnectorDeviceLease = run.peer.lease;
            expect(renewed.publication.leaseId).toBe(second.leaseId);
            expect(run.peer.leases).toBe(2);
            expect(run.peer.ended).toBe(false);
            expect(
                run.peer.frames.some(
                    (frame: ConnectorClientFrame): boolean =>
                        frame.kind === ConnectorFrameKind.HostResult,
                ),
            ).toBe(false);
            await expect(readFile(join(fixture.tasks, 'output.txt'), 'utf8')).rejects.toThrow(
                'ENOENT',
            );
            run.peer.send(deliver(fixture, original, second));
            const result: ConnectorHostResultFrame = await run.peer.next(
                (frame: ConnectorClientFrame): frame is ConnectorHostResultFrame =>
                    frame.kind === ConnectorFrameKind.HostResult,
            );
            expect(result.completion.leaseId).toBe(second.leaseId);
            expect(result.completion.jobId).toBe(original.jobId);
            expect(result.completion.dispatchId).toBe(original.dispatchId);
            expect(result.completion.response.outcome).toBe(ConnectorHostOutcome.Succeeded);
            expect(await readFile(join(fixture.tasks, 'output.txt'), 'utf8')).toBe('one effect\n');
            expect(run.states).toEqual([
                ConnectorClientState.Authenticated,
                ConnectorClientState.Authenticated,
            ]);
            expect(run.peer.ended).toBe(false);
            run.peer.assertHealthy();
        } finally {
            run.stop.abort();
            await run.running;
        }
    },
    20000,
);

it.skipIf(process.platform !== 'linux')(
    'a host permit naming any other lease during renewal still closes the socket',
    async (): Promise<void> => {
        await using fixture: ConnectorHostFixture = await ConnectorHostFixture.create();
        const grant: ConnectorHostLocalGrant = await fixture.grant();
        const host: ConnectorClientHost = await fixture.open();
        await using tls: SocketFixture = await SocketFixture.create(
            ConnectorTransportLimits.protocol,
        );
        const original: ConnectorHostPermit = fixture.permit(
            grant,
            1n,
            ConnectorHostTool.FileWrite,
            append,
        );
        const run: RenewalRun = await start(
            fixture,
            host,
            tls,
            (replaced: ConnectorDeviceLease): readonly ConnectorServerFrame[] => [
                deliver(fixture, original, {
                    ...replaced,
                    leaseId: randomBytes(32).toString('base64url'),
                }),
            ],
        );
        try {
            await run.peer.closed;
            expect(run.peer.leases).toBe(1);
            expect(
                run.peer.frames.filter(
                    (frame: ConnectorClientFrame): boolean =>
                        frame.kind === ConnectorFrameKind.Hello,
                ),
            ).toHaveLength(2);
            expect(
                run.peer.frames.filter(
                    (frame: ConnectorClientFrame): boolean =>
                        frame.kind === ConnectorFrameKind.Proof,
                ),
            ).toHaveLength(1);
            await expect(readFile(join(fixture.tasks, 'output.txt'), 'utf8')).rejects.toThrow(
                'ENOENT',
            );
            run.peer.assertHealthy();
        } finally {
            run.stop.abort();
            await run.running;
        }
    },
    20000,
);

/** Holds one local host operation until the test releases it. */
interface HostGate {
    readonly entered: Promise<undefined>;
    readonly release: () => void;
}

/** The next host tool call waits for release; later calls run unchanged. */
function gateHostTool(): HostGate {
    const entered: PromiseWithResolvers<undefined> = Promise.withResolvers<undefined>();
    const release: PromiseWithResolvers<undefined> = Promise.withResolvers<undefined>();
    const tool: MockInstance<HostMcpWorkspaceTools['call']> = vi
        .spyOn(HostMcpWorkspaceTools.prototype, 'call')
        .mockImplementation(async function (
            this: HostMcpWorkspaceTools,
            name: string,
            argumentsValue: HostJsonObject,
            observation?: HostReadObservationStart,
        ): Promise<string> {
            tool.mockRestore();
            entered.resolve(undefined);
            await release.promise;
            return await this.call(name, argumentsValue, observation);
        });
    return { entered: entered.promise, release: (): void => release.resolve(undefined) };
}

/** Waits for the host profile the device publishes on a lease it has not published before. */
async function hostPublication(
    peer: ConnectorRenewalPeer,
    published: readonly string[],
): Promise<ConnectorDeviceLease> {
    const profile: ConnectorHostProfileFrame = await peer.next(
        (frame: ConnectorClientFrame): frame is ConnectorHostProfileFrame =>
            frame.kind === ConnectorFrameKind.HostProfile &&
            !published.includes(frame.publication.leaseId),
    );
    expect(profile.publication.leaseId).toBe(peer.lease.leaseId);
    return peer.lease;
}

/** Counts the device frames of one kind received so far. */
function count(peer: ConnectorRenewalPeer, kind: ConnectorFrameKind): number {
    return peer.frames.filter((frame: ConnectorClientFrame): boolean => frame.kind === kind).length;
}

/** Re-signs a backend acknowledgment for another lease without changing what it acknowledges. */
function acknowledge(
    fixture: ConnectorHostFixture,
    result: ConnectorHostResultFrame,
    lease: ConnectorDeviceLease,
): ConnectorServerFrame {
    const acknowledgment: ConnectorHostAcknowledgment = fixture.acknowledgment({
        ...result.completion,
        leaseId: lease.leaseId,
    });
    return { kind: ConnectorFrameKind.HostAcknowledgment, acknowledgment };
}

it.skipIf(process.platform !== 'linux')(
    'a host permit still running across renewals attaches each re-delivery and replies once on the latest lease',
    async (): Promise<void> => {
        await using fixture: ConnectorHostFixture = await ConnectorHostFixture.create();
        const grant: ConnectorHostLocalGrant = await fixture.grant();
        const host: ConnectorClientHost = await fixture.open();
        await using tls: SocketFixture = await SocketFixture.create(
            ConnectorTransportLimits.protocol,
        );
        const gate: HostGate = gateHostTool();
        const verify: MockInstance<typeof ConnectorHostProof.verify> = vi.spyOn(
            ConnectorHostProof,
            'verify',
        );
        const original: ConnectorHostPermit = fixture.permit(
            grant,
            1n,
            ConnectorHostTool.FileWrite,
            append,
        );
        const run: RenewalRun = await start(
            fixture,
            host,
            tls,
            (): readonly ConnectorServerFrame[] => [],
            [2000n, 2000n, 30000n],
        );
        try {
            const leases: string[] = [];
            for (let delivery: number = 0; delivery < 3; delivery++) {
                const lease: ConnectorDeviceLease = await hostPublication(run.peer, leases);
                leases.push(lease.leaseId);
                run.peer.send(deliver(fixture, original, lease));
                if (delivery === 0) {
                    await gate.entered;
                }
            }
            await vi.waitFor((): void => {
                expect(
                    verify.mock.calls.filter(
                        (call: Parameters<typeof ConnectorHostProof.verify>): boolean =>
                            call[1] === SignaturePurpose.HostPermit,
                    ),
                ).toHaveLength(3);
            });
            expect(count(run.peer, ConnectorFrameKind.HostResult)).toBe(0);
            gate.release();
            const result: ConnectorHostResultFrame = await run.peer.next(
                (frame: ConnectorClientFrame): frame is ConnectorHostResultFrame =>
                    frame.kind === ConnectorFrameKind.HostResult,
            );
            expect(result.completion.leaseId).toBe(leases[2]);
            expect(result.completion.jobId).toBe(original.jobId);
            expect(result.completion.dispatchId).toBe(original.dispatchId);
            expect(result.completion.requestHash).toBe(original.requestHash);
            expect(result.completion.response.outcome).toBe(ConnectorHostOutcome.Succeeded);
            expect(await readFile(join(fixture.tasks, 'output.txt'), 'utf8')).toBe('one effect\n');
            run.peer.send(acknowledge(fixture, result, run.peer.lease));
            const confirmed: ConnectorHostAcknowledgedFrame = await run.peer.next(
                (frame: ConnectorClientFrame): frame is ConnectorHostAcknowledgedFrame =>
                    frame.kind === ConnectorFrameKind.HostAcknowledged,
            );
            expect(confirmed.receipt.leaseId).toBe(leases[2]);
            expect(count(run.peer, ConnectorFrameKind.HostResult)).toBe(1);
            expect(run.states).toEqual([
                ConnectorClientState.Authenticated,
                ConnectorClientState.Authenticated,
                ConnectorClientState.Authenticated,
            ]);
            expect(run.peer.ended).toBe(false);
            run.peer.assertHealthy();
        } finally {
            gate.release();
            run.stop.abort();
            await run.running;
        }
    },
    30000,
);

it.skipIf(process.platform !== 'linux')(
    'a different host original delivered on a renewed lease while one runs still closes the socket',
    async (): Promise<void> => {
        await using fixture: ConnectorHostFixture = await ConnectorHostFixture.create();
        const grant: ConnectorHostLocalGrant = await fixture.grant();
        const host: ConnectorClientHost = await fixture.open();
        await using tls: SocketFixture = await SocketFixture.create(
            ConnectorTransportLimits.protocol,
        );
        const gate: HostGate = gateHostTool();
        const original: ConnectorHostPermit = fixture.permit(
            grant,
            1n,
            ConnectorHostTool.FileWrite,
            append,
        );
        const other: ConnectorHostPermit = fixture.permit(
            grant,
            1n,
            ConnectorHostTool.FileWrite,
            JSON.stringify({
                path: 'other.txt',
                mode: 'append',
                encoding: 'utf8',
                data: 'never\n',
            }),
        );
        const log: ConnectorConnectionLog = new ConnectorConnectionLog(
            join(fixture.tasks, 'logs', 'connection.log'),
        );
        const run: RenewalRun = await start(
            fixture,
            host,
            tls,
            (): readonly ConnectorServerFrame[] => [],
            lifetimesMs,
            log,
        );
        try {
            const first: ConnectorDeviceLease = await hostPublication(run.peer, []);
            run.peer.send(deliver(fixture, original, first));
            await gate.entered;
            const second: ConnectorDeviceLease = await hostPublication(run.peer, [first.leaseId]);
            run.peer.send(deliver(fixture, other, second));
            await run.peer.closed;
            expect(count(run.peer, ConnectorFrameKind.HostResult)).toBe(0);
            gate.release();
            run.stop.abort();
            expect(await run.running).toBe(ConnectorDisconnect.Host);
            expect([run.peer.closeCode, run.peer.closeReason]).toEqual([
                4000,
                ConnectorDisconnect.Host,
            ]);
            const lines: readonly Readonly<Record<string, unknown>>[] = await log.recent(10);
            expect(
                lines.map((line: Readonly<Record<string, unknown>>): unknown => line['event']),
            ).toEqual(['opened', 'signed-in', 'ending', 'closed']);
            expect(lines[2]).toMatchObject({
                reason: ConnectorDisconnect.Host,
                frame: ConnectorFrameKind.HostPermit,
                error: 'Paired host lane is unavailable',
            });
            expect(lines[3]).toMatchObject({ reason: ConnectorDisconnect.Host, leases: 2 });
            expect(await readFile(join(fixture.tasks, 'output.txt'), 'utf8')).toBe('one effect\n');
            await expect(readFile(join(fixture.tasks, 'other.txt'), 'utf8')).rejects.toThrow(
                'ENOENT',
            );
            run.peer.assertHealthy();
        } finally {
            gate.release();
            run.stop.abort();
            await run.running;
        }
    },
    30000,
);

it.skipIf(process.platform !== 'linux')(
    'a host acknowledgment still committing across renewals attaches its re-deliveries and confirms once on the latest lease',
    async (): Promise<void> => {
        await using fixture: ConnectorHostFixture = await ConnectorHostFixture.create();
        const grant: ConnectorHostLocalGrant = await fixture.grant();
        const host: ConnectorClientHost = await fixture.open();
        await using tls: SocketFixture = await SocketFixture.create(
            ConnectorTransportLimits.protocol,
        );
        const entered: PromiseWithResolvers<undefined> = Promise.withResolvers<undefined>();
        const release: PromiseWithResolvers<undefined> = Promise.withResolvers<undefined>();
        const commit: MockInstance<ConnectorHostJournal['acknowledge']> = vi
            .spyOn(ConnectorHostJournal.prototype, 'acknowledge')
            .mockImplementation(async function (
                this: ConnectorHostJournal,
                value: ConnectorHostAcknowledgment,
            ): Promise<void> {
                commit.mockRestore();
                entered.resolve(undefined);
                await release.promise;
                await this.acknowledge(value);
            });
        const original: ConnectorHostPermit = fixture.permit(
            grant,
            1n,
            ConnectorHostTool.FileWrite,
            append,
        );
        const run: RenewalRun = await start(
            fixture,
            host,
            tls,
            (): readonly ConnectorServerFrame[] => [],
            [2000n, 2000n, 30000n],
        );
        try {
            const first: ConnectorDeviceLease = await hostPublication(run.peer, []);
            run.peer.send(deliver(fixture, original, first));
            const result: ConnectorHostResultFrame = await run.peer.next(
                (frame: ConnectorClientFrame): frame is ConnectorHostResultFrame =>
                    frame.kind === ConnectorFrameKind.HostResult,
            );
            expect(result.completion.leaseId).toBe(first.leaseId);
            run.peer.send(acknowledge(fixture, result, first));
            await entered.promise;
            const second: ConnectorDeviceLease = await hostPublication(run.peer, [first.leaseId]);
            run.peer.send(acknowledge(fixture, result, second));
            const third: ConnectorDeviceLease = await hostPublication(run.peer, [
                first.leaseId,
                second.leaseId,
            ]);
            run.peer.send(acknowledge(fixture, result, third));
            expect(count(run.peer, ConnectorFrameKind.HostAcknowledged)).toBe(0);
            release.resolve(undefined);
            const confirmed: ConnectorHostAcknowledgedFrame = await run.peer.next(
                (frame: ConnectorClientFrame): frame is ConnectorHostAcknowledgedFrame =>
                    frame.kind === ConnectorFrameKind.HostAcknowledged,
            );
            expect(confirmed.receipt.leaseId).toBe(third.leaseId);
            expect(confirmed.receipt.dispatchId).toBe(original.dispatchId);
            expect(count(run.peer, ConnectorFrameKind.HostAcknowledged)).toBe(1);
            expect(run.states).toEqual([
                ConnectorClientState.Authenticated,
                ConnectorClientState.Authenticated,
                ConnectorClientState.Authenticated,
            ]);
            expect(run.peer.ended).toBe(false);
            run.peer.assertHealthy();
        } finally {
            release.resolve(undefined);
            run.stop.abort();
            await run.running;
        }
    },
    30000,
);
