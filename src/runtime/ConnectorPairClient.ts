// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

import { ConnectorJournalLimits } from './ConnectorJournalLimits.js';
import { randomBytes } from 'node:crypto';
import { SignaturePurpose } from 'nerva-connector-protocol/identity/IdentityFormat.js';
import { lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { ConnectorLinkCodec } from '../protocol/ConnectorLinkCodec.js';
import {
    ConnectorLinkPhase,
    ConnectorLinkLimits,
    type ConnectorLinkProof,
    type ConnectorLinkStart,
    type ConnectorLinkStatus,
} from '../protocol/ConnectorLink.js';
import {
    ConnectorFrameKind,
    type ConnectorLinkErrorFrame,
} from '../protocol/ConnectorTransport.js';
import { ConnectorPairTransport, type ConnectorPairReply } from './ConnectorPairTransport.js';
import {
    ConnectorPairConfiguration,
    type ConnectorPairIdentity,
} from './ConnectorPairConfiguration.js';
import { ConnectorPairState, ConnectorPairPhase } from './ConnectorPairState.js';
import { ConnectorDeviceKey, type ConnectorDeviceIdentity } from './ConnectorDeviceKey.js';
import { ConnectorClientFiles } from './ConnectorClientFiles.js';
import { ExecutionPairPreparation } from '../execution/ExecutionPairPreparation.js';
import type { ConnectorClientSettings } from './ConnectorClientSettings.js';
import type { ConnectorClientIdentity } from './ConnectorClientConfiguration.js';
import { ProtectedFiles } from '../local/ProtectedFiles.js';
import { ConnectorPairedRuntime } from './ConnectorPairedRuntime.js';
import { ConnectorLogout } from './ConnectorLogout.js';
import { ConnectorStartupStage, type ConnectorStartupObserver } from './ConnectorStartup.js';

/** Pairing progress is separate from device session/file readiness. */
export enum ConnectorPairEventKind {
    Waiting = 'waiting-for-approval',
    Reconnecting = 'reconnecting',
    Paired = 'paired',
    Expired = 'expired',
    Revoked = 'revoked',
    Denied = 'denied',
}
/** Code rotation is an explicit local action; normal reconnect never discards an original attempt. */
export enum ConnectorPairIntent {
    Resume = 'resume',
    RenewExpired = 'renew-expired',
}
/** Only public human-code information is printed; private request IDs and proofs remain local. */
export interface ConnectorPairWaiting {
    readonly state: ConnectorPairEventKind.Waiting;
    readonly verificationUri: string;
    readonly code: string;
    readonly expiresAtMs: bigint;
    readonly publicKey: string;
}
/** Terminal/progress events contain no secrets or backend routing data. */
export interface ConnectorPairProgress {
    readonly state:
        | ConnectorPairEventKind.Reconnecting
        | ConnectorPairEventKind.Expired
        | ConnectorPairEventKind.Denied
        | ConnectorPairEventKind.Revoked;
}
/** Registered transport configuration is installed durably, but this does not claim an online session. */
export interface ConnectorPairCompleted {
    readonly state: ConnectorPairEventKind.Paired;
    readonly configurationFile: string;
    readonly enrollmentId: string;
    readonly publicKey: string;
}
/** A fixed event union is suitable for terminal display or installer UI forwarding. */
export type ConnectorPairEvent =
    ConnectorPairWaiting | ConnectorPairProgress | ConnectorPairCompleted;

/** Device-code orchestration keeps the same key, nonce and approval binding across network and process loss. */
export class ConnectorPairClient {
    /** One invocation has a finite budget; interruption preserves the signed durable state for the next invocation. */
    public static async run(
        path: string,
        signal: AbortSignal,
        observe: (event: ConnectorPairEvent) => void,
        intent: ConnectorPairIntent = ConnectorPairIntent.Resume,
        progress?: ConnectorStartupObserver,
    ): Promise<void> {
        signal.throwIfAborted();
        progress?.({ stage: ConnectorStartupStage.Configuration });
        const configuration: ConnectorPairIdentity = await ConnectorPairConfiguration.load(
            await ConnectorLogout.resolve(path, signal),
        );
        progress?.({ stage: ConnectorStartupStage.Identity });
        let retiredIdentity: boolean = false;
        try {
            retiredIdentity = await ProtectedFiles.exists(
                join(configuration.settings.stateDirectory, 'device-key.pem'),
            );
        } catch (caught: unknown) {
            if (!(caught instanceof Error && 'code' in caught && caught.code === 'ENOENT')) {
                throw caught;
            }
        }
        if (retiredIdentity) {
            throw new Error(
                'Existing connector identity requires an explicit authorized migration',
            );
        }
        const keyFile: string = join(configuration.settings.stateDirectory, 'device-key.json');
        if (intent === ConnectorPairIntent.RenewExpired) {
            const retained: Buffer = await ProtectedFiles.readPrivate(
                join(configuration.settings.stateDirectory, 'pairing-state'),
                16384,
            );
            retained.fill(0);
        } else if (intent === ConnectorPairIntent.Resume) {
            await ConnectorDeviceKey.initialize(keyFile);
        } else {
            throw new Error('Unknown pairing intent');
        }
        const identity: ConnectorDeviceIdentity = await ConnectorDeviceKey.load(keyFile);
        using identityOwner: DisposableStack = new DisposableStack();
        identityOwner.use(identity.key);
        progress?.({ stage: ConnectorStartupStage.PairingState });
        await using state: ConnectorPairState = await ConnectorPairState.open(
            configuration.settings.stateDirectory,
            identity,
            configuration.configurationSha256,
        );
        await ConnectorLogout.requireActive(configuration.settings.stateDirectory);
        if (
            (state.snapshot.phase === ConnectorPairPhase.Expired &&
                intent === ConnectorPairIntent.Resume) ||
            state.snapshot.phase === ConnectorPairPhase.Revoked ||
            state.snapshot.phase === ConnectorPairPhase.Denied
        ) {
            observe({
                state:
                    state.snapshot.phase === ConnectorPairPhase.Expired
                        ? ConnectorPairEventKind.Expired
                        : state.snapshot.phase === ConnectorPairPhase.Denied
                          ? ConnectorPairEventKind.Denied
                          : ConnectorPairEventKind.Revoked,
            });
            throw new Error('Connector pairing is terminal');
        }
        const transport: ConnectorPairTransport = new ConnectorPairTransport(
            configuration.settings.endpoints,
            configuration.ca,
            configuration.authority,
            progress,
        );
        const deadline: AbortSignal = AbortSignal.any([
            signal,
            AbortSignal.timeout(ConnectorLinkLimits.lifetimeMs),
        ]);
        let shown: boolean = false;
        let renewed: boolean = false;
        while (!deadline.aborted) {
            const reply: ConnectorPairReply = await transport.exchange(
                {
                    kind: ConnectorFrameKind.LinkPoll,
                    proof: this.#proof(state, identity, configuration.settings.authorityId),
                },
                deadline,
            );
            deadline.throwIfAborted();
            if (reply.kind === ConnectorFrameKind.LinkError) {
                await this.#failure(reply, observe, deadline, progress);
                continue;
            }
            if (reply.kind !== ConnectorFrameKind.LinkStatus) {
                throw new Error('Unexpected pairing status');
            }
            const status: ConnectorLinkStatus = reply.status;
            if (status.phase === ConnectorLinkPhase.Denied) {
                if (state.snapshot.enrollmentId !== null || status.enrollment !== null) {
                    throw new Error(
                        'A registered connector cannot be rejected as a pending request',
                    );
                }
                await state.write({ ...state.snapshot, phase: ConnectorPairPhase.Denied });
                observe({ state: ConnectorPairEventKind.Denied });
                throw new Error('Connector pairing was rejected');
            }
            if (
                status.phase === ConnectorLinkPhase.Approved ||
                status.phase === ConnectorLinkPhase.Revoked
            ) {
                const enrollmentId: string | undefined = status.enrollment?.id;
                const environmentId: string | undefined = status.enrollment?.environmentId;
                if (
                    enrollmentId === undefined ||
                    environmentId === undefined ||
                    (state.snapshot.environmentId !== null &&
                        state.snapshot.environmentId !== environmentId) ||
                    (state.snapshot.enrollmentId !== null &&
                        state.snapshot.enrollmentId !== enrollmentId)
                ) {
                    throw new Error('Connector account binding changed');
                }
                if (status.phase === ConnectorLinkPhase.Revoked) {
                    await state.write({
                        ...state.snapshot,
                        phase: ConnectorPairPhase.Revoked,
                        enrollmentId,
                        environmentId,
                    });
                    observe({ state: ConnectorPairEventKind.Revoked });
                    throw new Error('Connector pairing was revoked');
                }
                if (
                    state.snapshot.phase === ConnectorPairPhase.Authorizing ||
                    state.snapshot.phase === ConnectorPairPhase.Expired
                ) {
                    await state.write({
                        ...state.snapshot,
                        phase: ConnectorPairPhase.Registered,
                        enrollmentId,
                        environmentId,
                    });
                }
                progress?.({ stage: ConnectorStartupStage.Saving });
                await this.#configure(state, configuration, identity, keyFile);
                observe({
                    state: ConnectorPairEventKind.Paired,
                    configurationFile: state.directory.file('device.json'),
                    enrollmentId,
                    publicKey: identity.publicKey,
                });
                return;
            }
            if (state.snapshot.enrollmentId !== null) {
                throw new Error('Registered connector authority is unavailable');
            }
            if (
                status.phase === ConnectorLinkPhase.Expired ||
                (status.phase === ConnectorLinkPhase.Unregistered && state.snapshot.issued !== null)
            ) {
                await state.write({ ...state.snapshot, phase: ConnectorPairPhase.Expired });
                if (intent === ConnectorPairIntent.RenewExpired && !renewed) {
                    await state.renewExpired(status);
                    renewed = true;
                    shown = false;
                    continue;
                }
                observe({ state: ConnectorPairEventKind.Expired });
                throw new Error('Connector pairing code expired');
            }
            if (state.snapshot.issued === null) {
                const started: ConnectorPairReply = await transport.exchange(
                    {
                        kind: ConnectorFrameKind.LinkStart,
                        request: this.#start(
                            state,
                            identity,
                            configuration.settings.deviceName,
                            configuration.settings.authorityId,
                        ),
                    },
                    deadline,
                );
                deadline.throwIfAborted();
                if (started.kind === ConnectorFrameKind.LinkError) {
                    await this.#failure(started, observe, deadline, progress);
                    continue;
                }
                if (started.kind !== ConnectorFrameKind.LinkIssued) {
                    throw new Error('Unexpected pairing initiation response');
                }
                await state.write({ ...state.snapshot, issued: started.issued });
            }
            const issued: typeof state.snapshot.issued = state.snapshot.issued;
            if (issued === null) {
                throw new Error('Connector pairing code unavailable');
            }
            if (!shown) {
                observe({
                    state: ConnectorPairEventKind.Waiting,
                    verificationUri: configuration.settings.verificationUri,
                    code: issued.code,
                    expiresAtMs: issued.expiresAtMs,
                    publicKey: identity.publicKey,
                });
                shown = true;
            }
            progress?.({ stage: ConnectorStartupStage.Approval });
            await delay(ConnectorLinkLimits.pollMs, undefined, { signal: deadline });
        }
        deadline.throwIfAborted();
    }
    static #proof(
        state: ConnectorPairState,
        identity: ConnectorDeviceIdentity,
        authorityId: string,
    ): ConnectorLinkProof {
        const unsigned: Omit<ConnectorLinkProof, 'signature'> = this.#request(
            state,
            identity,
            authorityId,
        );
        return {
            ...unsigned,
            signature: identity.key.sign(
                SignaturePurpose.LinkPoll,
                Buffer.from(ConnectorLinkCodec.pollPayload(unsigned)),
            ),
        };
    }
    static #start(
        state: ConnectorPairState,
        identity: ConnectorDeviceIdentity,
        deviceName: string,
        authorityId: string,
    ): ConnectorLinkStart {
        const unsigned: Omit<ConnectorLinkStart, 'signature'> = {
            ...this.#request(state, identity, authorityId),
            deviceName,
        };
        return {
            ...unsigned,
            signature: identity.key.sign(
                SignaturePurpose.LinkStart,
                Buffer.from(ConnectorLinkCodec.startPayload(unsigned)),
            ),
        };
    }
    static #request(
        state: ConnectorPairState,
        identity: ConnectorDeviceIdentity,
        authorityId: string,
    ): Omit<ConnectorLinkProof, 'signature'> {
        return {
            authorityId,
            proofNonce: randomBytes(32).toString('base64url'),
            requestId: state.snapshot.requestId,
            publicKey: identity.publicKey,
            issuedAtMs: BigInt(Date.now()),
        };
    }
    static async #failure(
        reply: ConnectorLinkErrorFrame,
        observe: (event: ConnectorPairEvent) => void,
        signal: AbortSignal,
        progress?: ConnectorStartupObserver,
    ): Promise<void> {
        if (reply.retryAfterMs === 0) {
            throw new Error('Connector pairing authorization rejected');
        }
        observe({ state: ConnectorPairEventKind.Reconnecting });
        progress?.({ stage: ConnectorStartupStage.Retry, retryAfterMs: reply.retryAfterMs });
        await delay(reply.retryAfterMs, undefined, { signal });
    }
    static async #configure(
        state: ConnectorPairState,
        configuration: ConnectorPairIdentity,
        identity: ConnectorDeviceIdentity,
        keyFile: string,
    ): Promise<void> {
        const enrollmentId: string | null = state.snapshot.enrollmentId;
        const environmentId: string | null = state.snapshot.environmentId;
        if (enrollmentId === null || environmentId === null) {
            throw new Error('Connector registration is not durable');
        }
        if (
            state.snapshot.phase === ConnectorPairPhase.Configured &&
            (await state.directory.exists('device.json'))
        ) {
            await ConnectorPairedRuntime.verify(state, configuration, identity, keyFile);
            return;
        }
        const settings: ConnectorClientSettings = {
            authorityId: configuration.settings.authorityId,
            authorityPublicKeyFile: configuration.settings.authorityPublicKeyFile,
            environmentId,
            enrollmentId,
            slot: 0,
            endpoints: configuration.settings.endpoints,
            privateKeyFile: keyFile,
            serverCaFile: configuration.settings.serverCaFile,
            files: configuration.settings.files,
            execution: configuration.settings.execution,
        };
        const device: ConnectorClientIdentity = {
            configurationFile: state.directory.file('device.json'),
            settings,
            key: identity.key,
            publicKey: identity.publicKey,
            ca: configuration.ca,
            authority: configuration.authority,
        };
        if (
            state.snapshot.phase === ConnectorPairPhase.Registered &&
            (await state.directory.exists('device.json'))
        ) {
            throw new Error('Connector runtime was published before durable preparation');
        }
        if (settings.files !== null) {
            let missing: boolean = false;
            try {
                await lstat(join(settings.files.stateDirectory, 'file-journal'));
            } catch (caught: unknown) {
                if (caught instanceof Error && 'code' in caught && caught.code === 'ENOENT') {
                    missing = true;
                } else {
                    throw caught;
                }
            }
            if (missing) {
                if (state.snapshot.phase !== ConnectorPairPhase.Registered) {
                    throw new Error('Configured connector lost its file journal');
                }
                await ConnectorClientFiles.initialize(device);
            }
            if (state.snapshot.phase === ConnectorPairPhase.Registered) {
                await using files: ConnectorClientFiles = await ConnectorClientFiles.load(device);
                if (files.failed) {
                    throw new Error('Connector file journal is unavailable');
                }
            } else {
                const existing: Buffer = await ProtectedFiles.readPrivate(
                    join(settings.files.stateDirectory, 'file-journal'),
                    ConnectorJournalLimits.recordBytes,
                );
                existing.fill(0);
            }
        }
        await ExecutionPairPreparation.prepare(
            device,
            state.snapshot.phase === ConnectorPairPhase.Registered,
        );
        if (state.snapshot.phase === ConnectorPairPhase.Registered) {
            await state.write({ ...state.snapshot, phase: ConnectorPairPhase.Configured });
        }
        await state.publishConfiguration(Buffer.from(JSON.stringify(settings)));
    }
}
