// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

import { createHash, randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { SigningKey } from '../../src/identity/SigningKey.js';
import { SignaturePurpose } from 'nerva-connector-protocol/identity/IdentityFormat.js';
import { ConnectorClientSession } from '../../src/runtime/ConnectorClientSession.js';
import type { ConnectorClientIdentity } from '../../src/runtime/ConnectorClientConfiguration.js';
import { ConnectorOperationSchema } from 'nerva-connector-protocol/protocol/ConnectorOperationSchema.js';
import { ConnectorDeviceCodec } from 'nerva-connector-protocol/protocol/ConnectorDeviceCodec.js';
import type {
    ConnectorDeviceHello,
    ConnectorDeviceChallenge,
    ConnectorDeviceProof,
    ConnectorDeviceLease,
} from 'nerva-connector-protocol/protocol/ConnectorDevice.js';
import {
    ConnectorFrameKind,
    ConnectorTransportCodec,
    type ConnectorClientFrame,
} from '../../src/protocol/ConnectorTransport.js';
import {
    ConnectorStartupStage,
    type ConnectorStartupProgress,
} from '../../src/runtime/ConnectorStartup.js';
import type { ExecutionDeliveryLink } from '../../src/execution/ExecutionDeliveryLink.js';
import { JointWorkspaceDelivery } from '../../src/workspace/JointWorkspaceDelivery.js';
import type { JointWorkspaceDescriptor } from 'nerva-connector-protocol/workspace/JointWorkspaceBinding.js';
import type { JointWorkspacePublication } from 'nerva-connector-protocol/workspace/JointWorkspacePublication.js';
import { JointWorkspaceReceiptProof } from '../../src/workspace/JointWorkspaceReceiptProof.js';
import { JointWorkspaceProof } from '../../src/workspace/JointWorkspaceProof.js';
import type {
    JointWorkspaceReceiptBody,
    JointWorkspaceReceipt,
} from 'nerva-connector-protocol/workspace/JointWorkspaceReceipt.js';
import { JointWorkspaceRetryProof } from '../../src/workspace/JointWorkspaceRetryProof.js';
import {
    JointWorkspaceRetryReason,
    JointWorkspaceRetryLimits,
    type JointWorkspaceRetry,
} from 'nerva-connector-protocol/workspace/JointWorkspaceRetry.js';
import { JointWorkspaceJournal } from '../../src/workspace/JointWorkspaceJournal.js';
import { JointWorkspaceJournalFixture } from './JointWorkspaceJournalFixture.js';

/** The transport boundary records actual encoded frame bytes and the exact mutually authenticated link. */
export interface JointWorkspaceDeliverySent {
    readonly publication: JointWorkspacePublication;
    readonly wire: string;
    readonly link: ExecutionDeliveryLink;
}

/** Actual hybrid sessions and durable encrypted filesystem state qualify delivery without a live cloud or a mocked authentication decision. */
export class JointWorkspaceDeliveryFixture implements AsyncDisposable {
    readonly #sessions: DisposableStack = new DisposableStack();
    readonly #observers: Set<() => void> = new Set();
    readonly #stop: AbortController = new AbortController();
    readonly #sent: JointWorkspaceDeliverySent[] = [];
    readonly #closedLinks: ExecutionDeliveryLink[] = [];
    readonly #readyLinks: string[] = [];
    #current: ExecutionDeliveryLink | null = null;
    #links: number = 0;
    public onReady: (() => void) | null = null;
    public readonly delivery: JointWorkspaceDelivery;
    public readonly stages: ConnectorStartupStage[] = [];

    private constructor(
        public readonly source: JointWorkspaceJournalFixture,
        public readonly journal: JointWorkspaceJournal,
        public readonly bindings: readonly JointWorkspaceDescriptor[],
        public readonly identity: ConnectorClientIdentity,
    ) {
        this.delivery = new JointWorkspaceDelivery(
            identity,
            journal,
            bindings,
            (progress: ConnectorStartupProgress): void => {
                this.stages.push(progress.stage);
                if (this.stages.length > 64) {
                    throw new Error('Fixture progress bound exceeded');
                }
                if (progress.stage === ConnectorStartupStage.Ready) {
                    if (this.#current === null) {
                        throw new Error('Ready must have a current fixture link');
                    }
                    this.#readyLinks.push(this.#current.leaseId);
                    this.onReady?.();
                }
                this.#notify();
            },
        );
    }

    public static async create(pairs: number = 1): Promise<JointWorkspaceDeliveryFixture> {
        const source: JointWorkspaceJournalFixture = await JointWorkspaceJournalFixture.create();
        let journal: JointWorkspaceJournal | null = null;
        try {
            await source.initialize();
            journal = await source.open();
            const bindings: JointWorkspaceDescriptor[] = [];
            for (let index: number = 0; index < pairs; index++) {
                const revision: bigint = await journal.reserveRevision(source.signal);
                bindings.push(
                    await journal.retain(
                        source.signed(
                            revision,
                            'files-' + index.toString(),
                            'commands-' + index.toString(),
                        ),
                        source.signal,
                    ),
                );
            }
            const identity: ConnectorClientIdentity = {
                key: source.device,
                publicKey: source.device.publicKey,
                authority: {
                    authorityId: source.scope.authorityId,
                    publicKey: source.authority.publicKey,
                },
                ca: undefined,
                configurationFile: join(source.directory, 'device.json'),
                settings: {
                    authorityId: source.scope.authorityId,
                    authorityPublicKeyFile: join(source.directory, 'authority.json'),
                    environmentId: source.scope.environmentId,
                    enrollmentId: source.scope.enrollmentId,
                    slot: 0,
                    endpoints: ['wss://unused.invalid/v1/connector/tunnel'],
                    privateKeyFile: join(source.directory, 'device-key.json'),
                    serverCaFile: null,
                    files: null,
                    execution: null,
                },
            };
            return new JointWorkspaceDeliveryFixture(
                source,
                journal,
                Object.freeze(bindings),
                identity,
            );
        } catch (caught: unknown) {
            await journal?.[Symbol.asyncDispose]();
            await source[Symbol.asyncDispose]();
            throw caught;
        }
    }

    public get sentCount(): number {
        return this.#sent.length;
    }
    public get closedCount(): number {
        return this.#closedLinks.length;
    }
    public get readyCount(): number {
        return this.#readyLinks.length;
    }

    /** Each link performs all real signed handshake phases; no session's private state or clock validation is replaced. */
    public link(): ExecutionDeliveryLink {
        if (++this.#links > 8) {
            throw new Error('Fixture live-session bound exceeded');
        }
        const session: ConnectorClientSession = this.#sessions.use(
            new ConnectorClientSession(this.identity),
        );
        const now: bigint = BigInt(Date.now());
        const hello: ConnectorDeviceHello = session.begin(now);
        if (
            !SigningKey.verify(
                SignaturePurpose.DeviceHello,
                this.identity.publicKey,
                Buffer.from(ConnectorDeviceCodec.helloPayload(hello)),
                hello.signature,
            )
        ) {
            throw new Error('Actual device hello failed verification');
        }
        const body: Omit<ConnectorDeviceChallenge, 'signature'> = {
            operationSchema: ConnectorOperationSchema.ExplicitAdmission,
            authorityId: hello.authorityId,
            environmentId: hello.environmentId,
            enrollmentId: hello.enrollmentId,
            slot: hello.slot,
            publicKey: hello.publicKey,
            clientNonce: hello.nonce,
            helloSha256: this.#digest(ConnectorDeviceCodec.helloCommitment(hello)),
            challengeId: randomBytes(32).toString('base64url'),
            leaseId: randomBytes(32).toString('base64url'),
            edgeClientId: 'fixture-edge',
            edgeWorkloadThumbprint: randomBytes(32).toString('base64url'),
            issuedAtMs: now,
            expiresAtMs: now + 30000n,
        };
        const challenge: ConnectorDeviceChallenge = {
            ...body,
            signature: this.source.authority.sign(
                SignaturePurpose.ServerChallenge,
                Buffer.from(ConnectorDeviceCodec.challengePayload(body)),
            ),
        };
        const proof: ConnectorDeviceProof = session.prove(challenge, now);
        if (
            !SigningKey.verify(
                SignaturePurpose.ClientAuthentication,
                this.identity.publicKey,
                Buffer.from(ConnectorDeviceCodec.proofPayload(challenge)),
                proof.signature,
            )
        ) {
            throw new Error('Actual client authentication failed verification');
        }
        const unsigned: Omit<ConnectorDeviceLease, 'signature'> = {
            ...challenge,
            challengeSha256: this.#digest(ConnectorDeviceCodec.challengeCommitment(challenge)),
            authenticationSha256: this.#digest(ConnectorDeviceCodec.proofCommitment(proof)),
        };
        const lease: ConnectorDeviceLease = session.confirm(
            {
                ...unsigned,
                signature: this.source.authority.sign(
                    SignaturePurpose.ServerConfirmation,
                    Buffer.from(ConnectorDeviceCodec.leasePayload(unsigned)),
                ),
            },
            now,
        );
        const link: ExecutionDeliveryLink = {
            session,
            leaseId: lease.leaseId,
            send: (frame: ConnectorClientFrame): void => {
                if (
                    frame.kind !== ConnectorFrameKind.JointWorkspacePublication ||
                    this.#sent.length >= 16
                ) {
                    throw new Error('Bounded workspace-only fixture transport required');
                }
                this.#sent.push(
                    Object.freeze({
                        publication: frame.publication,
                        wire: ConnectorTransportCodec.encode(frame),
                        link,
                    }),
                );
                this.#notify();
            },
            close: (): void => {
                if (this.#closedLinks.length >= 16) {
                    throw new Error('Fixture closed-link bound exceeded');
                }
                this.#closedLinks.push(link);
                this.#notify();
            },
        };
        return link;
    }

    public activate(link: ExecutionDeliveryLink): void {
        this.#current = link;
        this.delivery.activate(link);
    }
    public async sent(index: number = 0): Promise<JointWorkspaceDeliverySent> {
        return await this.#wait((): JointWorkspaceDeliverySent | undefined => this.#sent[index]);
    }
    public async ready(index: number = 0): Promise<string> {
        return await this.#wait((): string | undefined => this.#readyLinks[index]);
    }
    public async closed(index: number = 0): Promise<ExecutionDeliveryLink> {
        return await this.#wait((): ExecutionDeliveryLink | undefined => this.#closedLinks[index]);
    }

    public receiptBody(sent: JointWorkspaceDeliverySent): JointWorkspaceReceiptBody {
        return {
            authorityId: this.identity.authority.authorityId,
            environmentId: this.identity.settings.environmentId,
            enrollmentId: this.identity.settings.enrollmentId,
            slot: 0,
            leaseId: sent.link.leaseId,
            bindingRevision: sent.publication.descriptor.binding.revision,
            bindingSha256: JointWorkspaceProof.bindingSha256(sent.publication.descriptor.binding),
            publicationSha256: JointWorkspaceReceiptProof.publicationSha256(sent.publication),
            issuedAtMs: BigInt(Date.now()),
        };
    }
    public receipt(sent: JointWorkspaceDeliverySent): JointWorkspaceReceipt {
        return JointWorkspaceReceiptProof.sign(this.source.authority, this.receiptBody(sent));
    }
    public retry(sent: JointWorkspaceDeliverySent): JointWorkspaceRetry {
        return JointWorkspaceRetryProof.sign(this.source.authority, {
            ...this.receiptBody(sent),
            reason: JointWorkspaceRetryReason.OriginalPending,
            retryAfterMs: JointWorkspaceRetryLimits.retryAfterMs,
        });
    }
    public accept(sent: JointWorkspaceDeliverySent): void {
        this.delivery.receive(
            { kind: ConnectorFrameKind.JointWorkspaceActivated, receipt: this.receipt(sent) },
            sent.link,
        );
    }

    public async [Symbol.asyncDispose](): Promise<void> {
        this.#stop.abort();
        this.#notify();
        try {
            await this.delivery[Symbol.asyncDispose]();
        } finally {
            try {
                this.#sessions[Symbol.dispose]();
                await this.journal[Symbol.asyncDispose]();
            } finally {
                await this.source[Symbol.asyncDispose]();
            }
        }
    }
    async #wait<T>(read: () => T | undefined): Promise<T> {
        const existing: T | undefined = read();
        if (existing !== undefined) {
            return existing;
        }
        if (this.#observers.size >= 8) {
            throw new Error('Fixture event-waiter bound exceeded');
        }
        const result: PromiseWithResolvers<T> = Promise.withResolvers<T>();
        const observe: () => void = (): void => {
            const value: T | undefined = read();
            if (value !== undefined) {
                result.resolve(value);
            } else if (this.#stop.signal.aborted) {
                result.reject(new Error('Fixture event owner closed'));
            }
        };
        const deadline: NodeJS.Timeout = setTimeout(
            (): void =>
                result.reject(new Error('Bounded workspace fixture event deadline expired')),
            2000,
        );
        this.#observers.add(observe);
        try {
            observe();
            return await result.promise;
        } finally {
            clearTimeout(deadline);
            this.#observers.delete(observe);
        }
    }
    #notify(): void {
        for (const observe of this.#observers) {
            observe();
        }
    }
    #digest(value: string): string {
        return createHash('sha256').update(value).digest('hex');
    }
}
