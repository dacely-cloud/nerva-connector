// SPDX-FileCopyrightText: 2026 Dacely <business@dacely.com>
// SPDX-License-Identifier: LicenseRef-Proprietary

import { setTimeout as delay } from 'node:timers/promises';
import type { ExecutionDeliveryLink } from '../execution/ExecutionDeliveryLink.js';
import type { ConnectorClientIdentity } from '../runtime/ConnectorClientConfiguration.js';
import type { ConnectorDeviceLease } from 'nerva-connector-protocol/protocol/ConnectorDevice.js';
import { ConnectorClientSession } from '../runtime/ConnectorClientSession.js';
import {
    ConnectorStartupStage,
    type ConnectorStartupObserver,
} from '../runtime/ConnectorStartup.js';
import {
    ConnectorFrameKind,
    type ConnectorJointWorkspaceActivatedFrame,
    type ConnectorJointWorkspaceRetryFrame,
} from '../protocol/ConnectorTransport.js';
import type { JointWorkspaceDescriptor } from 'nerva-connector-protocol/workspace/JointWorkspaceBinding.js';
import type { JointWorkspacePublication } from 'nerva-connector-protocol/workspace/JointWorkspacePublication.js';
import { JointWorkspacePublicationProof } from 'nerva-connector-protocol/workspace/JointWorkspacePublicationProof.js';
import type { JointWorkspaceReceiptExpected } from 'nerva-connector-protocol/workspace/JointWorkspaceReceipt.js';
import { JointWorkspaceRetryProof } from 'nerva-connector-protocol/workspace/JointWorkspaceRetryProof.js';
import { JointWorkspaceRetryReason } from 'nerva-connector-protocol/workspace/JointWorkspaceRetry.js';
import type { JointWorkspaceJournal } from './JointWorkspaceJournal.js';
import { SigningKey } from '../identity/SigningKey.js';

/** Only an authenticated acceptance or authenticated finite wait can finish an exact publication attempt. */
export type JointWorkspaceDeliveryReply =
    ConnectorJointWorkspaceActivatedFrame | ConnectorJointWorkspaceRetryFrame;

/** The one journal writer owns every in-flight reply, including while its socket lease is replaced. */
interface JointWorkspaceDeliveryAttempt {
    readonly link: ExecutionDeliveryLink;
    readonly reply: PromiseWithResolvers<JointWorkspaceDeliveryReply | null>;
    received: boolean;
}

/** One installation-owned loop serializes durable metadata across socket replacement without replaying file or command effects. */
export class JointWorkspaceDelivery implements AsyncDisposable {
    readonly #stop: AbortController = new AbortController();
    readonly #task: Promise<void>;
    readonly #bindings: readonly JointWorkspaceDescriptor[];
    #link: ExecutionDeliveryLink | null = null;
    #leaseStop: AbortController = new AbortController();
    #wake: PromiseWithResolvers<undefined> = Promise.withResolvers<undefined>();
    #attempt: JointWorkspaceDeliveryAttempt | null = null;
    #closed: boolean = false;
    #failed: boolean = false;
    #ready: boolean = false;

    /** The caller retains the identity, journal and borrowed policy owners until this loop has joined. */
    public constructor(
        public readonly identity: ConnectorClientIdentity,
        public readonly journal: JointWorkspaceJournal,
        bindings: readonly JointWorkspaceDescriptor[],
        public readonly progress?: ConnectorStartupObserver,
    ) {
        if (bindings.length === 0 || bindings.length > 128) {
            throw new Error('Explicit retained workspace bindings required');
        }
        this.#bindings = Object.freeze([...bindings]);
        this.#task = this.#run();
    }

    /** Readiness belongs only to the current attached lease after all exact signed acceptances are durable. */
    public get ready(): boolean {
        if (this.#closed || this.failed || !this.#ready || this.#link === null) {
            return false;
        }
        try {
            return (
                ConnectorClientSession.current(this.#link.session, BigInt(Date.now())).leaseId ===
                this.#link.leaseId
            );
        } catch {
            return false;
        }
    }
    public get failed(): boolean {
        return this.#failed || this.journal.failed;
    }

    /** Native effect admission cannot borrow another connection's metadata acceptance. */
    public assertLease(leaseId: string): void {
        const link: ExecutionDeliveryLink | null = this.#link;
        if (!this.ready || link === null || link.leaseId !== leaseId) {
            throw new Error('Fresh workspace effects require the currently accepted primary lease');
        }
        this.#expected(link);
    }

    /** A renewed lease wakes the same serial writer; it cannot race a previous receipt's durable write. */
    public activate(link: ExecutionDeliveryLink): void {
        if (this.#closed || this.failed) {
            throw new Error('Workspace publication owner unavailable');
        }
        const lease: ConnectorDeviceLease = ConnectorClientSession.current(
            link.session,
            BigInt(Date.now()),
        );
        if (lease.leaseId !== link.leaseId || lease.slot !== 0) {
            throw new Error('Workspace publication requires the current primary lease');
        }
        this.#leaseStop.abort();
        this.#leaseStop = new AbortController();
        this.#link = link;
        this.#ready = false;
        this.#notify();
    }

    /** Handshake renewal and physical disconnection remove delivery authority, never retained metadata or operation history. */
    public detach(link: ExecutionDeliveryLink): void {
        if (this.#link === link) {
            this.#link = null;
            this.#ready = false;
            this.#leaseStop.abort();
            this.#notify();
        }
    }

    /** No queue exists: a second response cannot replace the first reply before the writer validates it. */
    public receive(frame: JointWorkspaceDeliveryReply, link: ExecutionDeliveryLink): void {
        const attempt: JointWorkspaceDeliveryAttempt | null = this.#attempt;
        if (
            this.#closed ||
            this.#link !== link ||
            attempt === null ||
            attempt.link !== link ||
            attempt.received
        ) {
            throw new Error('Unexpected workspace publication response');
        }
        attempt.received = true;
        attempt.reply.resolve(frame);
    }

    /** Join the only journal writer before the caller can release the journal, roots or device key. */
    public async [Symbol.asyncDispose](): Promise<void> {
        this.#closed = true;
        this.#ready = false;
        this.#stop.abort();
        this.#leaseStop.abort();
        this.#link = null;
        this.#notify();
        await this.#task;
    }

    async #run(): Promise<void> {
        while (!this.#closed) {
            const link: ExecutionDeliveryLink | null = this.#link;
            if (link === null) {
                await this.#wake.promise;
                continue;
            }
            const signal: AbortSignal = AbortSignal.any([
                this.#stop.signal,
                this.#leaseStop.signal,
            ]);
            try {
                await this.#publish(link, signal);
                if (this.#link === link && !signal.aborted) {
                    this.#expected(link);
                    const wake: Promise<undefined> = this.#wake.promise;
                    this.#ready = true;
                    this.progress?.({ stage: ConnectorStartupStage.Ready });
                    if (this.#link === link && !signal.aborted) {
                        await wake;
                    }
                }
            } catch {
                if (this.journal.failed) {
                    this.#failed = true;
                }
                if (this.#link === link && !signal.aborted) {
                    this.detach(link);
                    link.close();
                }
            }
        }
    }

    async #publish(link: ExecutionDeliveryLink, signal: AbortSignal): Promise<void> {
        const remaining: Set<bigint> = new Set(
            this.#bindings.map((value: JointWorkspaceDescriptor): bigint => value.binding.revision),
        );
        while (remaining.size !== 0 && !signal.aborted) {
            const pending: JointWorkspacePublication | null = this.journal.pending;
            const binding: JointWorkspaceDescriptor | undefined =
                pending === null
                    ? this.#bindings.find((value: JointWorkspaceDescriptor): boolean =>
                          remaining.has(value.binding.revision),
                      )
                    : this.#bindings.find(
                          (value: JointWorkspaceDescriptor): boolean =>
                              value.binding.revision === pending.descriptor.binding.revision,
                      );
            if (binding === undefined) {
                throw new Error('Pending workspace publication is outside the installed mappings');
            }
            const expected: JointWorkspaceReceiptExpected = this.#expected(link);
            const publication: JointWorkspacePublication =
                pending !== null && pending.leaseId === link.leaseId
                    ? pending
                    : await this.journal.publish(
                          JointWorkspacePublicationProof.sign(SigningKey, this.identity.key, {
                              enrollmentId: expected.enrollmentId,
                              slot: expected.slot,
                              leaseId: expected.leaseId,
                              descriptor: binding,
                          }),
                          this.#stop.signal,
                      );
            if (signal.aborted || this.#link !== link) {
                return;
            }
            this.progress?.({ stage: ConnectorStartupStage.WorkspacePublication });
            const frame: JointWorkspaceDeliveryReply | null = await this.#request(
                link,
                publication,
                signal,
            );
            if (frame === null || signal.aborted) {
                return;
            }
            const now: bigint = BigInt(Date.now());
            if (frame.kind === ConnectorFrameKind.JointWorkspaceRetry) {
                if (
                    !JointWorkspaceRetryProof.verify(
                        SigningKey,
                        expected,
                        publication,
                        frame.retry,
                        now,
                    )
                ) {
                    throw new Error('Workspace publication wait was not authenticated');
                }
                this.progress?.({
                    stage:
                        frame.retry.reason === JointWorkspaceRetryReason.OriginalPending
                            ? ConnectorStartupStage.WorkspaceOriginals
                            : ConnectorStartupStage.WorkspacePublication,
                });
                await delay(frame.retry.retryAfterMs, undefined, { signal });
                continue;
            }
            // The journal verifies the complete pinned authority proof before its durable acceptance.
            await this.journal.accept(expected, publication, frame.receipt, now, this.#stop.signal);
            remaining.delete(binding.binding.revision);
        }
    }

    #expected(link: ExecutionDeliveryLink): JointWorkspaceReceiptExpected {
        const lease: ConnectorDeviceLease = ConnectorClientSession.current(
            link.session,
            BigInt(Date.now()),
        );
        if (lease.leaseId !== link.leaseId || lease.slot !== 0) {
            throw new Error('Workspace publication lease changed');
        }
        return {
            authorityId: this.identity.authority.authorityId,
            authorityPublicKey: this.identity.authority.publicKey,
            environmentId: this.identity.settings.environmentId,
            enrollmentId: this.identity.settings.enrollmentId,
            devicePublicKey: this.identity.publicKey,
            slot: lease.slot,
            leaseId: lease.leaseId,
            leaseIssuedAtMs: lease.issuedAtMs,
            leaseExpiresAtMs: lease.expiresAtMs,
        };
    }

    async #request(
        link: ExecutionDeliveryLink,
        publication: JointWorkspacePublication,
        signal: AbortSignal,
    ): Promise<JointWorkspaceDeliveryReply | null> {
        const attempt: JointWorkspaceDeliveryAttempt = {
            link,
            reply: Promise.withResolvers<JointWorkspaceDeliveryReply | null>(),
            received: false,
        };
        this.#attempt = attempt;
        const aborted: () => void = (): void => attempt.reply.resolve(null);
        signal.addEventListener('abort', aborted, { once: true });
        const deadline: NodeJS.Timeout = setTimeout((): void => {
            if (this.#link === link) {
                this.detach(link);
                link.close();
            }
            attempt.reply.resolve(null);
        }, 5000);
        try {
            if (signal.aborted) {
                return null;
            }
            link.send({ kind: ConnectorFrameKind.JointWorkspacePublication, publication });
            return await attempt.reply.promise;
        } finally {
            clearTimeout(deadline);
            signal.removeEventListener('abort', aborted);
            if (this.#attempt === attempt) {
                this.#attempt = null;
            }
        }
    }

    #notify(): void {
        const previous: PromiseWithResolvers<undefined> = this.#wake;
        this.#wake = Promise.withResolvers<undefined>();
        previous.resolve(undefined);
    }
}
