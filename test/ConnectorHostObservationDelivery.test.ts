// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

import { expect, it, vi, type MockInstance } from 'vitest';
import { ConnectorHostObservationFixture as Fixture } from './support/ConnectorHostObservationFixture.js';
import {
    ConnectorHostObservationDelivery as Delivery,
    type ConnectorHostObservationSink,
} from '../src/runtime/ConnectorHostObservationDelivery.js';
import type {
    ConnectorHostObservationReady as Ready,
    ConnectorHostObservationChanged as Changed,
    ConnectorHostObservationPermit as Permit,
} from 'nerva-connector-protocol/protocol/ConnectorHostObservation.js';
import { ConnectorHostObservationTranscript as Transcript } from 'nerva-connector-protocol/protocol/ConnectorHostObservationTranscript.js';
import {
    ConnectorHostTool as Tool,
    type ConnectorHostCompletion,
} from 'nerva-connector-protocol/protocol/ConnectorHost.js';
import { HostMcpWorkspaceTools } from '../src/host/HostMcpWorkspaceTools.js';
import type { ConnectorClientHost } from '../src/runtime/ConnectorClientHost.js';
import type { ConnectorHostObservationOwned as Owned } from '../src/runtime/ConnectorHostObservationOwners.js';

/** Bounded fixture transcripts expose only signed metadata, never process stream copies. */
class Sink implements ConnectorHostObservationSink {
    public readonly readiness: Ready[] = [];
    public readonly batches: Changed[] = [];
    public failures: number = 0;
    /** The socket analogue records exact signed frames without effects. */
    public ready(value: Ready): void {
        this.readiness.push(value);
    }
    /** Deliberately withholding ACK simulates transport loss without changing native work. */
    public changed(value: Changed): void {
        this.batches.push(value);
    }
    /** Only the companion is failed; the fixture retains its native host separately. */
    public failed(): void {
        this.failures += 1;
    }
}
/** Closed JSON input models the actual outer transport boundary. */
function wire<T>(value: T): unknown {
    const raw: unknown = JSON.parse(Transcript.encode(value));
    return raw;
}
/** The fixture feeds one admitted stdin chunk; signed hint waiting never enters that native effect lane. */
async function write(fixture: Fixture, text: string): Promise<void> {
    await fixture.call(
        Tool.ProcessWrite,
        JSON.stringify({ processId: fixture.processId, encoding: 'utf8', data: text, end: false }),
    );
}

it.skipIf(process.platform !== 'linux')(
    'delivers changes without idle native reads, retries identical lost-ACK batches and defers renewal without blocking stdin',
    async (): Promise<void> => {
        await using fixture: Fixture = await Fixture.create();
        const sink: Sink = new Sink();
        await using delivery: Delivery = new Delivery(fixture.host, fixture.connection, sink);
        const calls: MockInstance<HostMcpWorkspaceTools['call']> = vi.spyOn(
            HostMcpWorkspaceTools.prototype,
            'call',
        );
        try {
            delivery.permit(wire(fixture.permit()));
            await vi.waitFor((): void => expect(sink.readiness).toHaveLength(1), {
                timeout: 5000,
                interval: 10,
            });
            expect(calls).not.toHaveBeenCalled();
            await write(fixture, 'a');
            await vi.waitFor((): void => expect(sink.batches.length).toBeGreaterThanOrEqual(1), {
                timeout: 5000,
                interval: 10,
            });
            const first: Changed | undefined = sink.batches[0];
            const ready: Ready | undefined = sink.readiness[0];
            if (first === undefined || ready === undefined) {
                throw new Error('Signed fixture metadata required');
            }
            await write(fixture, 'b');
            const renewal: Permit = fixture.permit({
                generation: 2n,
                runtimeId: ready.runtimeId,
                instanceSha256: ready.instanceSha256,
            });
            delivery.permit(wire(renewal));
            await vi.waitFor((): void => expect(sink.batches.length).toBeGreaterThanOrEqual(2), {
                timeout: 5000,
                interval: 10,
            });
            expect(sink.batches[1]).toBe(first);
            expect(sink.readiness).toHaveLength(1);
            expect(
                calls.mock.calls.filter(
                    (args: Parameters<HostMcpWorkspaceTools['call']>): boolean =>
                        args[0] === Tool.ProcessRead,
                ),
            ).toHaveLength(0);
            delivery.acknowledge(wire(fixture.acknowledgment(first)));
            await vi.waitFor((): void => expect(sink.readiness).toHaveLength(2), {
                timeout: 5000,
                interval: 10,
            });
            const renewed: Ready | undefined = sink.readiness[1];
            if (renewed === undefined) {
                throw new Error('Renewed exact source required');
            }
            expect(renewed.generation).toBe(2n);
            expect(renewed.runtimeId).toBe(ready.runtimeId);
            expect(renewed.instanceSha256).toBe(ready.instanceSha256);
            expect(renewed.revision).toBeGreaterThan(ready.revision);
            await write(fixture, 'c');
            await vi.waitFor(
                (): void =>
                    expect(
                        sink.batches.some((value: Changed): boolean => value.batchRevision === 2n),
                    ).toBe(true),
                { timeout: 5000, interval: 10 },
            );
            const next: Changed | undefined = sink.batches.find(
                (value: Changed): boolean => value.batchRevision === 2n,
            );
            if (next === undefined) {
                throw new Error('Next exact signed batch required');
            }
            expect(next.changes[0]?.generation).toBe(2n);
            expect(next.changes[0]?.revision).toBeGreaterThan(renewed.revision);
            delivery.acknowledge(wire(fixture.acknowledgment(next)));
            await delivery[Symbol.asyncDispose]();
            expect(sink.failures).toBe(0);
            const result: ConnectorHostCompletion = await fixture.call(
                Tool.ProcessRead,
                JSON.stringify({
                    processId: fixture.processId,
                    stdoutOffset: '0',
                    stderrOffset: '0',
                    maximumBytes: 32768,
                }),
            );
            const snapshot: unknown = JSON.parse(result.response.resultJson ?? 'null');
            expect(snapshot).toMatchObject({
                running: true,
                stdout: { data: 'abc', offset: '0', nextOffset: '3', truncated: false },
            });
            expect(
                calls.mock.calls.some(
                    (args: Parameters<HostMcpWorkspaceTools['call']>): boolean =>
                        args[0] === Tool.ProcessStop ||
                        args[0] === Tool.ProcessRelease ||
                        args[0] === Tool.ProcessStart,
                ),
            ).toBe(false);
        } finally {
            calls.mockRestore();
        }
    },
);

it.skipIf(process.platform !== 'linux')(
    'a forged ACK closes only the companion and never treats it as process cleanup or EOF',
    async (): Promise<void> => {
        await using fixture: Fixture = await Fixture.create();
        const sink: Sink = new Sink();
        await using delivery: Delivery = new Delivery(fixture.host, fixture.connection, sink);
        delivery.permit(wire(fixture.permit()));
        await vi.waitFor((): void => expect(sink.readiness).toHaveLength(1), {
            timeout: 5000,
            interval: 10,
        });
        await write(fixture, 'x');
        await vi.waitFor((): void => expect(sink.batches.length).toBeGreaterThan(0), {
            timeout: 5000,
            interval: 10,
        });
        const batch: Changed | undefined = sink.batches[0];
        if (batch === undefined) {
            throw new Error('Batch required');
        }
        delivery.acknowledge(
            wire({ ...fixture.acknowledgment(batch), signature: 'A'.repeat(3312) }),
        );
        await delivery[Symbol.asyncDispose]();
        expect(sink.failures).toBe(1);
        const result: ConnectorHostCompletion = await fixture.call(
            Tool.ProcessRead,
            JSON.stringify({
                processId: fixture.processId,
                stdoutOffset: '0',
                stderrOffset: '0',
                maximumBytes: 32768,
            }),
        );
        const snapshot: unknown = JSON.parse(result.response.resultJson ?? 'null');
        expect(snapshot).toMatchObject({
            running: true,
            outputComplete: false,
            stdout: { data: 'x' },
        });
    },
);

it.skipIf(process.platform !== 'linux')(
    'joins a canceled delayed authorization and discards its late success without emitting Ready or relaunching',
    async (): Promise<void> => {
        await using fixture: Fixture = await Fixture.create();
        const sink: Sink = new Sink();
        const permit: Permit = fixture.permit();
        const owned: Owned = await fixture.host.observe(wire(permit), fixture.connection);
        const held: PromiseWithResolvers<Owned> = Promise.withResolvers<Owned>();
        const observe: MockInstance<ConnectorClientHost['observe']> = vi
            .spyOn(fixture.host, 'observe')
            .mockReturnValue(held.promise);
        await using delivery: Delivery = new Delivery(fixture.host, fixture.connection, sink);
        try {
            delivery.permit(wire(permit));
            await vi.waitFor((): void => expect(observe).toHaveBeenCalledOnce(), {
                timeout: 5000,
                interval: 10,
            });
            await delivery[Symbol.asyncDispose]();
            held.resolve(owned);
            await Promise.resolve();
            expect(sink.readiness).toHaveLength(0);
            expect(sink.failures).toBe(0);
        } finally {
            observe.mockRestore();
            held.resolve(owned);
        }
    },
);
