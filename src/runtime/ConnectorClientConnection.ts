// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

import type { ConnectorClientExecution } from './ConnectorClientExecution.js';
import type { ConnectorClientHost, ConnectorHostDelivery } from './ConnectorClientHost.js';
import { ConnectorClientLane, type ConnectorLaneReply } from './ConnectorClientLane.js';
import { ConnectorHostObservationClient } from './ConnectorHostObservationClient.js';
import { ConnectorHostLimits } from '../protocol/ConnectorHost.js';
import type { ConnectorHostServerFrame } from '../protocol/ConnectorTransport.js';
import type { ExecutionDeliveryLink } from '../execution/ExecutionDeliveryLink.js';
import { SystemInfo } from '../system/SystemInfo.js';
import type { SystemSpecification } from 'nerva-connector-protocol/system/SystemSpecification.js';
import { ConnectorClientSession } from './ConnectorClientSession.js';
import type {
    ConnectorDeviceProof,
    ConnectorDeviceLease,
} from 'nerva-connector-protocol/protocol/ConnectorDevice.js';
import { ConnectorSocket } from '../networking/ConnectorSocket.js';
import { ConnectorStartupStage, type ConnectorStartupObserver } from './ConnectorStartup.js';
import {
    ConnectorTransportCodec,
    ConnectorTransportLimits,
    ConnectorFrameKind,
    type ConnectorServerFrame,
    type ConnectorClientFrame,
    type ConnectorFilePermitFrame,
    type ConnectorFileAcknowledgmentFrame,
    type ConnectorExecutionServerFrame,
    type ConnectorInteractiveServerFrame,
} from '../protocol/ConnectorTransport.js';
import { ConnectorClientState } from './ConnectorClientState.js';
import { ConnectorDisconnect } from './ConnectorDisconnect.js';
import { ConnectorRevocation } from './ConnectorRevocation.js';
import type { ConnectorUnpair } from 'nerva-connector-protocol/protocol/ConnectorUnpair.js';
import { ConnectorConnectionLog } from './ConnectorConnectionLog.js';
import type { ConnectorClientIdentity } from './ConnectorClientConfiguration.js';
import type { ConnectorClientFiles, ConnectorFileDelivery } from './ConnectorClientFiles.js';
import type { ConnectorClientWorkspaces } from './ConnectorClientWorkspaces.js';
import type {
    ConnectorFileAcknowledgment,
    ConnectorFileOperation,
    ConnectorFilePermit,
} from 'nerva-connector-protocol/protocol/ConnectorFileJobs.js';
import type {
    ConnectorHostAcknowledgment,
    ConnectorHostPermit,
} from '../protocol/ConnectorHost.js';

/** A metadata run borrows the exact current primary lifetime and owns only its separate abort and socket task. */
interface ConnectorHostObservationRun {
    readonly abort: AbortController;
    readonly task: Promise<void>;
}

/** Each socket owns finite control timers and one task per paired lane across any number of lease renewals. */
export class ConnectorClientConnection {
    #socket: ConnectorSocket | null = null;
    #executionLink: ExecutionDeliveryLink | null = null;
    #leaseId: string | null = null;
    #expiresAtMs: bigint = 0n;
    #pendingHandshake: boolean = false;
    #inventoryTask: Promise<void> | null = null;
    #observation: ConnectorHostObservationRun | null = null;
    readonly #observationTasks: Set<Promise<void>> = new Set();
    #disconnect: ConnectorDisconnect | null = null;
    #revocation: ConnectorUnpair | null = null;
    #leases: number = 0;
    #received: number = 0;
    #lastReceived: ConnectorFrameKind | null = null;
    readonly #hostLane: ConnectorClientLane = new ConnectorClientLane(
        {
            send: (frame: ConnectorClientFrame, leaseId: string): void =>
                this.#reply(frame, leaseId),
            fail: (leaseId: string, cause: unknown): void =>
                this.#retire(leaseId, ConnectorDisconnect.Host, cause),
        },
        'Paired host lane is unavailable',
    );
    readonly #fileLane: ConnectorClientLane = new ConnectorClientLane(
        {
            send: (frame: ConnectorClientFrame, leaseId: string): void =>
                this.#reply(frame, leaseId),
            fail: (leaseId: string, cause: unknown): void =>
                this.#retire(leaseId, ConnectorDisconnect.Files, cause),
        },
        'Connector file lane unavailable',
    );
    /** The shared file owner survives this socket; no disconnection resets its retained-result journal. */
    public constructor(
        public readonly identity: ConnectorClientIdentity,
        public readonly files: ConnectorClientFiles | null,
        public readonly execution: ConnectorClientExecution | null,
        public readonly observe: (state: ConnectorClientState) => void,
        public readonly progress?: ConnectorStartupObserver,
        public readonly workspaces: ConnectorClientWorkspaces | null = null,
        public readonly host: ConnectorClientHost | null = null,
        public readonly log: ConnectorConnectionLog | null = null,
        public readonly revoke: ((receipt: ConnectorUnpair) => Promise<void>) | null = null,
    ) {}
    /** Termination cannot cancel a started read or discard its retained result. */
    public terminate(): void {
        this.#socket?.terminate();
    }

    /** A permanent decision is exposed only after verifying the installed authority and exact key. */
    public get revocation(): ConnectorUnpair | null {
        return this.#revocation;
    }

    /**
     * The first local reason to end this socket is the one its retry reports, logs and sends to Nerva.
     *
     * @remarks
     * The close frame carries the reason as its close reason, so the Nerva server journal records why this side
     * hung up next to the frame it had just sent.
     *
     * @param reason - Why this side is ending the socket
     * @param cause - What the refused frame handler or failed lane threw, when something threw
     * @param frame - The kind of the frame being handled when it threw
     */
    #end(reason: ConnectorDisconnect, cause?: unknown, frame?: ConnectorFrameKind | null): void {
        if (this.#disconnect === null) {
            this.#disconnect = reason;
            this.log?.record('ending', {
                reason,
                frame: frame ?? null,
                error: ConnectorConnectionLog.error(cause),
            });
        }
        this.#socket?.close(4000, this.#disconnect);
    }

    /**
     * Every connection authenticates anew and validates file permits against the independently pinned backend key.
     *
     * @returns Why the socket ended: the first local refusal, or {@link ConnectorDisconnect.Closed} when Nerva or the
     * network closed it
     */
    public async run(endpoint: string, signal: AbortSignal): Promise<ConnectorDisconnect> {
        const done: PromiseWithResolvers<undefined> = Promise.withResolvers<undefined>();
        const socket: ConnectorSocket = new ConnectorSocket(
            endpoint,
            ConnectorTransportLimits.protocol,
            {
                ca: this.identity.ca,
                maximumPayload:
                    this.host === null
                        ? ConnectorTransportLimits.executionFrameBytes
                        : ConnectorHostLimits.frameBytes,
                handshakeMs: ConnectorTransportLimits.handshakeMs,
                ...(this.progress === undefined ? {} : { progress: this.progress }),
            },
        );
        this.#socket = socket;
        const closed: AbortController = new AbortController();
        let deadline: NodeJS.Timeout = setTimeout(
            (): void => this.#end(ConnectorDisconnect.HandshakeTimeout),
            ConnectorTransportLimits.handshakeMs,
        );
        using session: ConnectorClientSession = new ConnectorClientSession(this.identity);
        let renewal: NodeJS.Timeout | undefined;
        const hello: () => void = (): void => {
            if (this.#revocation !== null) {
                return;
            }
            try {
                this.#stopObservation();
                this.#pendingHandshake = true;
                if (this.#executionLink !== null) {
                    this.workspaces?.detach(this.#executionLink);
                }
                if (this.#leaseId === null) {
                    this.progress?.({ stage: ConnectorStartupStage.Authentication });
                }
                this.#send({
                    kind: ConnectorFrameKind.Hello,
                    hello: session.begin(BigInt(Date.now())),
                });
                clearTimeout(deadline);
                deadline = setTimeout(
                    (): void => this.#end(ConnectorDisconnect.HandshakeTimeout),
                    ConnectorTransportLimits.handshakeMs,
                );
            } catch (caught: unknown) {
                this.#end(ConnectorDisconnect.Authentication, caught, ConnectorFrameKind.Hello);
            }
        };
        let frames: number = 0;
        let window: number = performance.now();
        const opened: number = performance.now();
        let closeCode: number = 1006;
        let closeReason: string = '';
        const abort: () => void = (): void => socket.terminate();
        signal.addEventListener('abort', abort, { once: true });
        socket.on('error', (error: Error): void => this.#end(ConnectorDisconnect.Network, error));
        socket.once('close', (code: number, reason: string): void => {
            closeCode = code;
            closeReason = reason;
            closed.abort();
            done.resolve(undefined);
        });
        socket.once('open', (): void => {
            if (signal.aborted) {
                socket.terminate();
                return;
            }
            this.log?.record('opened', { afterMs: Math.round(performance.now() - opened) });
            hello();
        });
        socket.on('message', (data: Buffer, binary: boolean): void => {
            if (this.#revocation !== null) {
                return;
            }
            let kind: ConnectorFrameKind | null = null;
            try {
                if (performance.now() - window >= 1000) {
                    frames = 0;
                    window = performance.now();
                }
                const maximum: number =
                    this.#leaseId !== null && this.host !== null
                        ? ConnectorHostLimits.frameBytes
                        : this.#leaseId !== null && (this.files !== null || this.execution !== null)
                          ? ConnectorTransportLimits.executionFrameBytes
                          : ConnectorTransportLimits.frameBytes;
                if (
                    binary ||
                    ++frames > 32 ||
                    !Buffer.isBuffer(data) ||
                    data.byteLength > maximum
                ) {
                    throw new Error('Invalid connector frame budget');
                }
                const frame: ConnectorServerFrame = ConnectorTransportCodec.server(
                    new TextDecoder('utf-8', { fatal: true }).decode(data),
                );
                kind = frame.kind;
                this.#received++;
                this.#lastReceived = frame.kind;
                if (data.byteLength > ConnectorTransportLimits.bytes(frame.kind)) {
                    throw new Error('Connector frame budget exceeded');
                }
                if (frame.kind === ConnectorFrameKind.Unpaired) {
                    this.#revocation = ConnectorRevocation.verify(
                        this.identity.authority,
                        this.identity.publicKey,
                        frame.receipt,
                    );
                    this.#end(ConnectorDisconnect.Revoked);
                } else if (frame.kind === ConnectorFrameKind.Challenge) {
                    if (this.#leaseId === null) {
                        this.progress?.({ stage: ConnectorStartupStage.Proof });
                    }
                    const proof: ConnectorDeviceProof = session.prove(
                        frame.challenge,
                        BigInt(Date.now()),
                    );
                    this.#send({
                        kind: ConnectorFrameKind.Proof,
                        challengeId: proof.challengeId,
                        signature: proof.signature,
                    });
                    if (this.#leaseId === null) {
                        this.progress?.({ stage: ConnectorStartupStage.Confirmation });
                    }
                    clearTimeout(deadline);
                    deadline = setTimeout(
                        (): void => this.#end(ConnectorDisconnect.HandshakeTimeout),
                        ConnectorTransportLimits.handshakeMs,
                    );
                } else if (frame.kind === ConnectorFrameKind.Authenticated) {
                    const lease: ConnectorDeviceLease = session.confirm(
                        frame.lease,
                        BigInt(Date.now()),
                    );
                    this.#leaseId = lease.leaseId;
                    this.#expiresAtMs = lease.expiresAtMs;
                    clearTimeout(deadline);
                    clearTimeout(renewal);
                    const remaining: number = Math.min(
                        Number(lease.expiresAtMs - BigInt(Date.now())),
                        Number(lease.expiresAtMs - lease.issuedAtMs),
                    );
                    if (remaining <= 0) {
                        throw new Error('Connector lease expired during confirmation');
                    }
                    this.#pendingHandshake = false;
                    if (this.#leases++ === 0) {
                        this.log?.record('signed-in', {
                            device: ConnectorConnectionLog.pseudonym(
                                this.identity.settings.enrollmentId,
                                this.identity.settings.slot,
                            ),
                            afterMs: Math.round(performance.now() - opened),
                            host: this.host !== null,
                            files: this.files !== null,
                            execution: this.execution !== null,
                        });
                    }
                    deadline = setTimeout(
                        (): void => this.#end(ConnectorDisconnect.LeaseExpired),
                        remaining,
                    );
                    renewal = setTimeout(
                        hello,
                        Math.min(ConnectorTransportLimits.renewMs, Math.max(1, remaining / 2)),
                    );
                    this.observe(ConnectorClientState.Authenticated);
                    this.progress?.({
                        stage:
                            this.workspaces === null
                                ? ConnectorStartupStage.Ready
                                : ConnectorStartupStage.WorkspacePublication,
                    });
                    this.#publishInventory(
                        session,
                        lease.leaseId,
                        AbortSignal.any([signal, closed.signal]),
                    );
                    if (this.host !== null) {
                        this.host.bindLink((): void => this.#end(ConnectorDisconnect.Host));
                        this.#send({
                            kind: ConnectorFrameKind.HostProfile,
                            publication: this.host.publication(lease.leaseId),
                        });
                        this.#startObservation(
                            endpoint,
                            lease,
                            AbortSignal.any([signal, closed.signal]),
                        );
                    }
                    if (this.execution !== null) {
                        const link: ExecutionDeliveryLink = {
                            session,
                            leaseId: lease.leaseId,
                            send: (frame: ConnectorClientFrame): void => {
                                if (
                                    !this.#pendingHandshake &&
                                    this.#executionLink === link &&
                                    this.#socket?.isOpen === true
                                ) {
                                    this.#send(frame);
                                }
                            },
                            close: (): void => {
                                if (this.#executionLink === link) {
                                    this.#end(ConnectorDisconnect.Execution);
                                }
                            },
                        };
                        this.#executionLink = link;
                        for (const publication of this.execution.activate(link)) {
                            this.#send({ kind: ConnectorFrameKind.ExecutionProfile, publication });
                        }
                        this.workspaces?.activate(link);
                    }
                    if (this.files !== null) {
                        this.#send({
                            kind: ConnectorFrameKind.FileProfile,
                            publication: this.files.publication(lease.leaseId),
                        });
                    }
                } else if (
                    frame.kind === ConnectorFrameKind.HostPermit ||
                    frame.kind === ConnectorFrameKind.HostAcknowledgment
                ) {
                    const host: ConnectorClientHost | null = this.host;
                    const leaseId: string | null = this.#leaseId;
                    if (host === null || leaseId === null) {
                        throw new Error('Paired host lane is unavailable');
                    }
                    const dispatch: ConnectorHostPermit | ConnectorHostAcknowledgment =
                        frame.kind === ConnectorFrameKind.HostPermit
                            ? frame.permit
                            : frame.acknowledgment;
                    if (!this.#superseded([dispatch.leaseId])) {
                        ConnectorClientConnection.#current(dispatch.leaseId, leaseId);
                        this.#hostLane.deliver(
                            frame.kind,
                            dispatch,
                            leaseId,
                            (): ConnectorLaneReply => this.#hostReply(host, frame, leaseId),
                        );
                    }
                } else if (
                    frame.kind === ConnectorFrameKind.JointWorkspaceActivated ||
                    frame.kind === ConnectorFrameKind.JointWorkspaceRetry
                ) {
                    if (this.workspaces === null || this.#executionLink === null) {
                        throw new Error('Workspace publication is unavailable');
                    }
                    if (!this.#pendingHandshake) {
                        this.workspaces.receive(frame, this.#executionLink);
                    }
                } else if (
                    frame.kind === ConnectorFrameKind.ExecutionPermit ||
                    frame.kind === ConnectorFrameKind.ExecutionCancellation ||
                    frame.kind === ConnectorFrameKind.ExecutionAcknowledgment ||
                    frame.kind === ConnectorFrameKind.ExecutionOutputAck ||
                    frame.kind === ConnectorFrameKind.ExecutionInteractiveReadyStored ||
                    frame.kind === ConnectorFrameKind.ExecutionInputWork
                ) {
                    if (this.execution === null || this.#executionLink === null) {
                        throw new Error('Connector execution delivery unavailable');
                    }
                    if (!this.#superseded(ConnectorClientConnection.#executionLeases(frame))) {
                        this.execution.receive(frame, this.#executionLink);
                    }
                } else if (
                    frame.kind === ConnectorFrameKind.FilePermit ||
                    frame.kind === ConnectorFrameKind.FileAcknowledgment
                ) {
                    const files: ConnectorClientFiles | null = this.files;
                    const leaseId: string | null = this.#leaseId;
                    if (files === null || leaseId === null) {
                        throw new Error('Connector file lane unavailable');
                    }
                    const dispatch: ConnectorFilePermit | ConnectorFileAcknowledgment =
                        frame.kind === ConnectorFrameKind.FilePermit
                            ? frame.permit
                            : frame.acknowledgment;
                    ConnectorClientConnection.#current(dispatch.leaseId, leaseId);
                    this.#fileLane.deliver(frame.kind, dispatch, leaseId, (): ConnectorLaneReply =>
                        this.#fileReply(files, frame, leaseId),
                    );
                } else {
                    throw new Error('Unexpected connector frame');
                }
            } catch (caught: unknown) {
                this.#end(ConnectorClientConnection.#refusal(kind), caught, kind);
            }
        });
        try {
            await done.promise;
        } finally {
            this.#stopObservation();
            clearTimeout(deadline);
            clearTimeout(renewal);
            signal.removeEventListener('abort', abort);
            socket.terminate();
            if (this.#executionLink !== null) {
                this.execution?.detach(this.#executionLink);
                this.workspaces?.detach(this.#executionLink);
                this.#executionLink = null;
            }
            this.#socket = null;
            this.host?.bindLink(null);
            this.#leaseId = null;
            this.#pendingHandshake = false;
            closed.abort();
            this.log?.record('closed', {
                reason: this.#disconnect ?? ConnectorDisconnect.Closed,
                afterMs: Math.round(performance.now() - opened),
                leases: this.#leases,
                received: this.#received,
                lastReceived: this.#lastReceived,
                closeCode,
                closeReason,
            });
            try {
                if (
                    !signal.aborted &&
                    (this.#fileLane.task !== null ||
                        this.#inventoryTask !== null ||
                        this.#hostLane.task !== null ||
                        this.#observationTasks.size !== 0)
                ) {
                    this.progress?.({ stage: ConnectorStartupStage.Closing });
                }
            } finally {
                try {
                    if (this.#revocation !== null) {
                        await this.revoke?.(this.#revocation);
                    }
                } finally {
                    await Promise.allSettled([
                        ...(this.#fileLane.task === null ? [] : [this.#fileLane.task]),
                        ...(this.#hostLane.task === null ? [] : [this.#hostLane.task]),
                        ...(this.#inventoryTask === null ? [] : [this.#inventoryTask]),
                        ...this.#observationTasks,
                    ]);
                }
            }
        }
        return this.#disconnect ?? ConnectorDisconnect.Closed;
    }

    #stopObservation(): void {
        this.#observation?.abort.abort();
    }
    #startObservation(endpoint: string, lease: ConnectorDeviceLease, signal: AbortSignal): void {
        const previous: ConnectorHostObservationRun | null = this.#observation;
        previous?.abort.abort();
        const host: ConnectorClientHost | null = this.host;
        if (host === null || !host.observationEnabled || this.#observationTasks.size >= 2) {
            return;
        }
        const abort: AbortController = new AbortController();
        const active: AbortSignal = AbortSignal.any([signal, abort.signal]);
        const client: ConnectorHostObservationClient = new ConnectorHostObservationClient(
            this.identity,
            host,
        );
        const task: Promise<void> = this.#runObservation(
            client,
            endpoint,
            lease,
            active,
            previous?.task ?? null,
        );
        this.#observation = { abort, task };
        this.#observationTasks.add(task);
        void this.#observeObservation(task);
    }
    async #runObservation(
        client: ConnectorHostObservationClient,
        endpoint: string,
        lease: ConnectorDeviceLease,
        signal: AbortSignal,
        previous: Promise<void> | null,
    ): Promise<void> {
        if (previous !== null) {
            await Promise.allSettled([previous]);
        }
        if (!signal.aborted) {
            await client.run(endpoint, lease, signal);
        }
    }
    async #observeObservation(task: Promise<void>): Promise<void> {
        try {
            await task;
        } catch {
            return;
        } finally {
            this.#observationTasks.delete(task);
            if (this.#observation?.task === task) {
                this.#observation = null;
            }
        }
    }

    /**
     * Verifies a host lane delivery and returns how its reply is produced for the lease it arrived on.
     *
     * @remarks
     * A permit is accepted now, joining the original's single local operation, so a renewed lease's re-delivery
     * is verified on arrival and the completion is later signed for that lease.
     */
    #hostReply(
        host: ConnectorClientHost,
        frame: ConnectorHostServerFrame,
        leaseId: string,
    ): ConnectorLaneReply {
        if (frame.kind === ConnectorFrameKind.HostPermit) {
            const delivery: ConnectorHostDelivery = host.accept(
                frame.permit,
                leaseId,
                this.#expiresAtMs,
            );
            return async (): Promise<ConnectorClientFrame> => ({
                kind: ConnectorFrameKind.HostResult,
                completion: await host.complete(delivery),
            });
        }
        const acknowledgment: ConnectorHostAcknowledgment = frame.acknowledgment;
        return async (): Promise<ConnectorClientFrame> => ({
            kind: ConnectorFrameKind.HostAcknowledged,
            receipt: await host.acknowledge(acknowledgment, leaseId),
        });
    }

    #publishInventory(session: ConnectorClientSession, leaseId: string, signal: AbortSignal): void {
        if (this.#inventoryTask !== null) {
            return;
        }
        this.#inventoryTask = this.#inventory(session, leaseId, signal);
    }
    async #inventory(
        session: ConnectorClientSession,
        leaseId: string,
        signal: AbortSignal,
    ): Promise<void> {
        try {
            const specification: SystemSpecification = await SystemInfo.read(
                AbortSignal.any([signal, AbortSignal.timeout(3000)]),
            );
            if (
                !signal.aborted &&
                !this.#pendingHandshake &&
                this.#leaseId === leaseId &&
                this.#socket?.isOpen === true
            ) {
                this.#send({
                    kind: ConnectorFrameKind.Inventory,
                    publication: session.inventory(specification, leaseId, BigInt(Date.now())),
                });
            }
        } catch (caught: unknown) {
            if (!signal.aborted && this.#leaseId === leaseId) {
                this.#end(ConnectorDisconnect.Inventory, caught);
            }
        } finally {
            this.#inventoryTask = null;
        }
    }

    /**
     * Verifies a file lane delivery and returns how its reply is produced for the lease it arrived on.
     *
     * @remarks
     * A permit is accepted now, joining the original's single local operation, so a renewed lease's re-delivery
     * is verified on arrival and the completion is later signed for that lease.
     */
    #fileReply(
        files: ConnectorClientFiles,
        frame: ConnectorFilePermitFrame | ConnectorFileAcknowledgmentFrame,
        leaseId: string,
    ): ConnectorLaneReply {
        if (frame.kind === ConnectorFrameKind.FilePermit) {
            const delivery: ConnectorFileDelivery = files.accept(
                frame.permit,
                leaseId,
                this.#expiresAtMs,
            );
            const request: ConnectorFileOperation = frame.permit.request;
            return async (): Promise<ConnectorClientFrame> => ({
                kind: ConnectorFrameKind.FileResult,
                request,
                completion: await files.complete(delivery),
            });
        }
        const acknowledgment: ConnectorFileAcknowledgment = frame.acknowledgment;
        return async (): Promise<ConnectorClientFrame> => ({
            kind: ConnectorFrameKind.FileAcknowledged,
            receipt: await files.acknowledge(acknowledgment, leaseId),
        });
    }
    /** A finished lane reply leaves only on its own lease, and only once that lease is confirmed and still current. */
    #reply(frame: ConnectorClientFrame, leaseId: string): void {
        if (
            this.#revocation === null &&
            !this.#pendingHandshake &&
            this.#leaseId === leaseId &&
            this.#socket?.isOpen === true
        ) {
            this.#send(frame);
        }
    }
    /** A failed lane delivery retires the socket only while its lease is still current. */
    #retire(leaseId: string, reason: ConnectorDisconnect, cause: unknown): void {
        if (this.#leaseId === leaseId) {
            this.#end(reason, cause);
        }
    }
    /** A refused frame names the lane it belonged to; an unreadable one is an invalid frame. */
    static #refusal(kind: ConnectorFrameKind | null): ConnectorDisconnect {
        switch (kind) {
            case ConnectorFrameKind.Challenge:
            case ConnectorFrameKind.Authenticated:
            case ConnectorFrameKind.Unpaired:
                return ConnectorDisconnect.Authentication;
            case ConnectorFrameKind.HostPermit:
            case ConnectorFrameKind.HostAcknowledgment:
                return ConnectorDisconnect.Host;
            case ConnectorFrameKind.FilePermit:
            case ConnectorFrameKind.FileAcknowledgment:
                return ConnectorDisconnect.Files;
            case ConnectorFrameKind.JointWorkspaceActivated:
            case ConnectorFrameKind.JointWorkspaceRetry:
            case ConnectorFrameKind.ExecutionPermit:
            case ConnectorFrameKind.ExecutionCancellation:
            case ConnectorFrameKind.ExecutionAcknowledgment:
            case ConnectorFrameKind.ExecutionOutputAck:
            case ConnectorFrameKind.ExecutionInteractiveReadyStored:
            case ConnectorFrameKind.ExecutionInputWork:
                return ConnectorDisconnect.Execution;
            default:
                return ConnectorDisconnect.InvalidFrame;
        }
    }
    /**
     * A lane frame must name the lease it is delivered on.
     *
     * @param named - The lease the frame names
     * @param current - The socket's current lease
     * @throws Error if the frame names any other lease
     */
    static #current(named: string, current: string): void {
        if (named !== current) {
            throw new Error('Connector lane frame named another lease');
        }
    }
    /**
     * A lane frame that crossed this socket's renewal hello belongs to the lease being replaced and is dropped.
     *
     * @remarks
     * The server sent it before it received the hello. The replacement lease publishes every lane again and the
     * server then re-delivers each retained original or acknowledgment on that lease, so dropping the stale copy
     * loses no work and takes no lane state. A renewal frame naming any other lease remains a protocol violation.
     *
     * @param leases - Every lease the frame names
     * @returns Whether the frame belongs to the lease being replaced
     * @throws Error if a renewal frame names a lease other than the one being replaced
     */
    #superseded(leases: readonly string[]): boolean {
        if (!this.#pendingHandshake || this.#leaseId === null) {
            return false;
        }
        if (leases.some((leaseId: string): boolean => leaseId !== this.#leaseId)) {
            throw new Error('Connector renewal received another lease');
        }
        return true;
    }
    /** Every lease a server execution frame names; empty interactive work names none. */
    static #executionLeases(
        frame: ConnectorExecutionServerFrame | ConnectorInteractiveServerFrame,
    ): readonly string[] {
        switch (frame.kind) {
            case ConnectorFrameKind.ExecutionPermit:
                return [frame.permit.leaseId];
            case ConnectorFrameKind.ExecutionCancellation:
                return [frame.cancellation.leaseId];
            case ConnectorFrameKind.ExecutionAcknowledgment:
            case ConnectorFrameKind.ExecutionOutputAck:
                return [frame.acknowledgment.leaseId];
            case ConnectorFrameKind.ExecutionInteractiveReadyStored:
                return [frame.submission.leaseId];
            case ConnectorFrameKind.ExecutionInputWork: {
                const leases: string[] = [];
                if (frame.work.permit !== null) {
                    leases.push(frame.work.permit.leaseId);
                }
                if (frame.work.acknowledgment !== null) {
                    leases.push(frame.work.acknowledgment.leaseId);
                }
                if (frame.work.resolution !== null) {
                    leases.push(frame.work.resolution.leaseId);
                }
                return leases;
            }
        }
    }
    #send(frame: ConnectorClientFrame): void {
        const encoded: string = ConnectorTransportCodec.encode(frame);
        if (
            this.#socket?.isOpen !== true ||
            this.#socket.bufferedAmount >
                (this.host === null
                    ? ConnectorTransportLimits.executionFrameBytes
                    : ConnectorHostLimits.frameBytes) ||
            Buffer.byteLength(encoded) > ConnectorTransportLimits.bytes(frame.kind)
        ) {
            throw new Error('Connector socket backpressure exceeded');
        }
        this.#socket.send(encoded);
    }
}
