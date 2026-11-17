// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

import { setImmediate } from 'node:timers/promises';
import { expect, it } from 'vitest';
import {
    ConnectorClientLane,
    type ConnectorLaneDispatch,
    type ConnectorLaneLink,
    type ConnectorLaneReply,
} from '../src/runtime/ConnectorClientLane.js';
import {
    ConnectorFrameKind,
    type ConnectorClientFrame,
    type ConnectorFileAcknowledgedFrame,
} from '../src/protocol/ConnectorTransport.js';

/** The socket side as the lane sees it: every sent reply and every retired lease, in order. */
class RecordingLink implements ConnectorLaneLink {
    public readonly sent: string[] = [];
    public readonly failed: string[] = [];
    public readonly send: (frame: ConnectorClientFrame, leaseId: string) => void = (
        frame: ConnectorClientFrame,
        leaseId: string,
    ): void => {
        if (frame.kind !== ConnectorFrameKind.FileAcknowledged) {
            throw new Error('Fixture replies are acknowledgments');
        }
        expect(frame.receipt.leaseId).toBe(leaseId);
        this.sent.push(leaseId);
    };
    public readonly fail: (leaseId: string) => void = (leaseId: string): void => {
        this.failed.push(leaseId);
    };
}

/** One original's shared local work and the replies its deliveries produced from it. */
class SharedOriginal {
    public readonly work: PromiseWithResolvers<undefined> = Promise.withResolvers<undefined>();
    public readonly prepared: string[] = [];
    public readonly replied: string[] = [];

    /** Verifies a delivery on `leaseId`; its reply waits for the shared work and names that lease. */
    public prepare(leaseId: string): ConnectorLaneReply {
        this.prepared.push(leaseId);
        return async (): Promise<ConnectorClientFrame> => {
            await this.work.promise;
            this.replied.push(leaseId);
            const frame: ConnectorFileAcknowledgedFrame = {
                kind: ConnectorFrameKind.FileAcknowledged,
                receipt: {
                    enrollmentId: 'enrollment',
                    leaseId,
                    jobId: dispatch.jobId,
                    sequence: dispatch.sequence,
                    dispatchId: dispatch.dispatchId,
                    requestHash: dispatch.requestHash,
                    admissionHash: 'admission',
                    responseHash: 'response',
                    signature: 'signature',
                },
            };
            return frame;
        };
    }
}

const dispatch: ConnectorLaneDispatch = {
    jobId: 'job',
    sequence: 1n,
    dispatchId: 'dispatch',
    requestHash: 'request',
};

it('a running original attaches any number of renewed deliveries with one task and replies once for the latest lease', async (): Promise<void> => {
    const link: RecordingLink = new RecordingLink();
    const lane: ConnectorClientLane = new ConnectorClientLane(link, 'Lane unavailable');
    const original: SharedOriginal = new SharedOriginal();
    lane.deliver(
        ConnectorFrameKind.FileAcknowledgment,
        dispatch,
        'lease-0',
        (): ConnectorLaneReply => original.prepare('lease-0'),
    );
    const task: Promise<void> | null = lane.task;
    expect(task).not.toBeNull();
    for (let renewal: number = 1; renewal <= 1000; renewal++) {
        const leaseId: string = 'lease-' + renewal.toString();
        lane.deliver(
            ConnectorFrameKind.FileAcknowledgment,
            { ...dispatch },
            leaseId,
            (): ConnectorLaneReply => original.prepare(leaseId),
        );
        expect(lane.task).toBe(task);
    }
    expect(original.prepared).toHaveLength(1001);
    original.work.resolve(undefined);
    await task;
    await setImmediate();
    expect(original.replied).toEqual(['lease-0', 'lease-1000']);
    expect(link.sent).toEqual(['lease-1000']);
    expect(link.failed).toEqual([]);
    expect(lane.task).toBeNull();
});

it('a running lane refuses another original, another kind or a repeat on its own lease without preparing it', async (): Promise<void> => {
    const link: RecordingLink = new RecordingLink();
    const lane: ConnectorClientLane = new ConnectorClientLane(link, 'Lane unavailable');
    const original: SharedOriginal = new SharedOriginal();
    lane.deliver(
        ConnectorFrameKind.FileAcknowledgment,
        dispatch,
        'lease-0',
        (): ConnectorLaneReply => original.prepare('lease-0'),
    );
    const refused: readonly [ConnectorFrameKind, ConnectorLaneDispatch, string][] = [
        [ConnectorFrameKind.FileAcknowledgment, { ...dispatch, jobId: 'other' }, 'lease-1'],
        [ConnectorFrameKind.FileAcknowledgment, { ...dispatch, sequence: 2n }, 'lease-1'],
        [ConnectorFrameKind.FileAcknowledgment, { ...dispatch, dispatchId: 'other' }, 'lease-1'],
        [ConnectorFrameKind.FileAcknowledgment, { ...dispatch, requestHash: 'other' }, 'lease-1'],
        [ConnectorFrameKind.FilePermit, dispatch, 'lease-1'],
        [ConnectorFrameKind.FileAcknowledgment, dispatch, 'lease-0'],
    ];
    for (const [kind, other, leaseId] of refused) {
        expect((): void =>
            lane.deliver(kind, other, leaseId, (): ConnectorLaneReply => original.prepare(leaseId)),
        ).toThrow('Lane unavailable');
    }
    expect(original.prepared).toEqual(['lease-0']);
    original.work.resolve(undefined);
    await lane.task;
    expect(link.sent).toEqual(['lease-0']);
});

it('a delivery whose verification fails leaves the running original and its latest lease unchanged', async (): Promise<void> => {
    const link: RecordingLink = new RecordingLink();
    const lane: ConnectorClientLane = new ConnectorClientLane(link, 'Lane unavailable');
    const original: SharedOriginal = new SharedOriginal();
    lane.deliver(
        ConnectorFrameKind.FileAcknowledgment,
        dispatch,
        'lease-0',
        (): ConnectorLaneReply => original.prepare('lease-0'),
    );
    lane.deliver(
        ConnectorFrameKind.FileAcknowledgment,
        dispatch,
        'lease-1',
        (): ConnectorLaneReply => original.prepare('lease-1'),
    );
    expect((): void =>
        lane.deliver(ConnectorFrameKind.FileAcknowledgment, dispatch, 'lease-2', (): never => {
            throw new Error('Permit denied');
        }),
    ).toThrow('Permit denied');
    original.work.resolve(undefined);
    await lane.task;
    expect(link.sent).toEqual(['lease-1']);
});

it('a failed original retires only the lease of its latest delivery and frees the lane', async (): Promise<void> => {
    const link: RecordingLink = new RecordingLink();
    const lane: ConnectorClientLane = new ConnectorClientLane(link, 'Lane unavailable');
    const work: PromiseWithResolvers<undefined> = Promise.withResolvers<undefined>();
    const failing: ConnectorLaneReply = async (): Promise<ConnectorClientFrame> => {
        await work.promise;
        throw new Error('Original failed');
    };
    lane.deliver(
        ConnectorFrameKind.FileAcknowledgment,
        dispatch,
        'lease-0',
        (): ConnectorLaneReply => failing,
    );
    lane.deliver(
        ConnectorFrameKind.FileAcknowledgment,
        dispatch,
        'lease-1',
        (): ConnectorLaneReply => failing,
    );
    const task: Promise<void> | null = lane.task;
    work.resolve(undefined);
    await expect(task).rejects.toThrow('Original failed');
    await setImmediate();
    expect(link.failed).toEqual(['lease-1']);
    expect(link.sent).toEqual([]);
    expect(lane.task).toBeNull();
});
