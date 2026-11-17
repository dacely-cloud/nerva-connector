// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

import type { ConnectorClientFrame, ConnectorFrameKind } from '../protocol/ConnectorTransport.js';

/** Produces one delivery's signed reply, waiting for its original's shared local work when that is still running. */
export type ConnectorLaneReply = () => Promise<ConnectorClientFrame>;

/** The dispatch identity every delivery of one original repeats unchanged, whatever lease carries it. */
export interface ConnectorLaneDispatch {
    readonly jobId: string;
    readonly sequence: bigint;
    readonly dispatchId: string;
    readonly requestHash: string;
}

/** The socket side of a lane: a reply leaves only on its own current lease, and a failure retires only that lease. */
export interface ConnectorLaneLink {
    /** Sends a finished reply when its lease is still current and confirmed, and drops it otherwise. */
    readonly send: (frame: ConnectorClientFrame, leaseId: string) => void;
    /** Retires the socket when the failed delivery's lease is still current, naming what the work threw. */
    readonly fail: (leaseId: string, cause: unknown) => void;
}

/** One accepted delivery: the lease it arrived on and how its reply is produced. */
interface ConnectorLaneDelivery {
    readonly leaseId: string;
    readonly reply: ConnectorLaneReply;
}

/** The single original a lane is running and its most recent delivery. */
interface ConnectorLaneRun {
    readonly kind: ConnectorFrameKind;
    readonly dispatch: ConnectorLaneDispatch;
    readonly latest: ConnectorLaneDelivery;
}

/**
 * A paired lane serves exactly one original at a time on one socket, across any number of lease renewals.
 *
 * @remarks
 * A renewal re-delivers the running original, unchanged and re-signed for the new lease. That delivery attaches to
 * the running original instead of starting work: it only replaces the run's latest delivery, so the lane holds one
 * task and one delivery however many renewals happen. When the original's work settles the lane replies once, for
 * the latest delivery, and only while that delivery's lease is current; an earlier lease's reply is never sent.
 * Any other frame while a run is in progress, including the same original again on its own lease, is a protocol
 * violation.
 */
export class ConnectorClientLane {
    #run: ConnectorLaneRun | null = null;
    #task: Promise<void> | null = null;
    /**
     * An idle lane belongs to one socket and starts work only for deliveries it accepts.
     *
     * @param link - Sends finished replies and retires the socket on failure
     * @param unavailable - The error message for a delivery this lane must refuse
     */
    public constructor(
        public readonly link: ConnectorLaneLink,
        public readonly unavailable: string,
    ) {}

    /** The running original's task, or `null` when the lane is idle. */
    public get task(): Promise<void> | null {
        return this.#task;
    }

    /**
     * Starts a delivery's original, or attaches a renewed lease's re-delivery of the running original.
     *
     * @remarks
     * `prepare` runs only for a delivery this lane accepts. It verifies the frame and may start or join the
     * original's local work, so a refused delivery is never verified, started or joined.
     *
     * @param kind - The delivered frame kind
     * @param dispatch - The original's dispatch identity as delivered
     * @param leaseId - The current lease the delivery arrived on
     * @param prepare - Verifies the delivery and returns how to produce its reply
     * @throws Error if another original is running, or this original was already delivered on `leaseId`
     */
    public deliver(
        kind: ConnectorFrameKind,
        dispatch: ConnectorLaneDispatch,
        leaseId: string,
        prepare: () => ConnectorLaneReply,
    ): void {
        const run: ConnectorLaneRun | null = this.#run;
        if (run !== null) {
            if (
                run.kind !== kind ||
                run.dispatch.jobId !== dispatch.jobId ||
                run.dispatch.sequence !== dispatch.sequence ||
                run.dispatch.dispatchId !== dispatch.dispatchId ||
                run.dispatch.requestHash !== dispatch.requestHash ||
                run.latest.leaseId === leaseId
            ) {
                throw new Error(this.unavailable);
            }
            this.#run = { kind, dispatch: run.dispatch, latest: { leaseId, reply: prepare() } };
            return;
        }
        this.#run = { kind, dispatch, latest: { leaseId, reply: prepare() } };
        const task: Promise<void> = this.#drive();
        this.#task = task;
        void this.#observe(task);
    }

    /** Produces the latest delivery's reply, again if a renewal attached while the previous reply was produced. */
    async #drive(): Promise<void> {
        for (;;) {
            const run: ConnectorLaneRun | null = this.#run;
            if (run === null) {
                throw new Error('Connector lane run unavailable');
            }
            const frame: ConnectorClientFrame = await run.latest.reply();
            if (this.#run === run) {
                this.link.send(frame, run.latest.leaseId);
                return;
            }
        }
    }

    async #observe(task: Promise<void>): Promise<void> {
        try {
            await task;
        } catch (caught: unknown) {
            if (this.#run !== null) {
                this.link.fail(this.#run.latest.leaseId, caught);
            }
        } finally {
            this.#run = null;
            this.#task = null;
        }
    }
}
