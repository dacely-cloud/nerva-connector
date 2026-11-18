// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

import type { ExecutionInteractiveOriginal } from 'nerva-connector-protocol/execution/ExecutionInteractive.js';
import {
    ConnectorHostLimits,
    type ConnectorHostPublication,
    type ConnectorHostPermit,
    type ConnectorHostCompletion,
    type ConnectorHostAcknowledgment,
    type ConnectorHostAcknowledged,
} from 'nerva-connector-protocol/protocol/ConnectorHost.js';
import { ConnectorHostCodec } from 'nerva-connector-protocol/protocol/ConnectorHostCodec.js';

import {
    ConnectorInteractiveProtocol,
    type ConnectorInteractiveReadyEnvelope,
} from 'nerva-connector-protocol/protocol/ConnectorInteractiveProtocol.js';
import { ExecutionInteractiveFields as InteractiveFields } from 'nerva-connector-protocol/execution/ExecutionInteractiveFields.js';
import { ExecutionInputReceiptCapture } from 'nerva-connector-protocol/execution/ExecutionInputReceiptCapture.js';
import { ExecutionInputWorkCapture } from 'nerva-connector-protocol/execution/ExecutionInputWorkCapture.js';
import type { JointWorkspaceRetry } from 'nerva-connector-protocol/workspace/JointWorkspaceRetry.js';
import { JointWorkspaceRetryCodec } from 'nerva-connector-protocol/workspace/JointWorkspaceRetryCodec.js';
import type { JointWorkspacePublication } from 'nerva-connector-protocol/workspace/JointWorkspacePublication.js';
import { JointWorkspacePublicationCodec } from 'nerva-connector-protocol/workspace/JointWorkspacePublicationCodec.js';
import type { JointWorkspaceReceipt } from 'nerva-connector-protocol/workspace/JointWorkspaceReceipt.js';
import { JointWorkspaceReceiptCodec } from 'nerva-connector-protocol/workspace/JointWorkspaceReceiptCodec.js';
import type { ConnectorInventoryPublication } from 'nerva-connector-protocol/protocol/ConnectorInventory.js';
import { ConnectorInventoryCodec } from 'nerva-connector-protocol/protocol/ConnectorInventoryCodec.js';
import { ExecutionOutputProtocol } from '../execution/ExecutionOutputProtocol.js';
import type {
    ExecutionOutputUpdate,
    ExecutionOutputAck,
} from 'nerva-connector-protocol/execution/ExecutionOutput.js';
import { ExecutionJobsCodec } from '../execution/ExecutionJobsCodec.js';
import type {
    ExecutionPublication,
    ExecutionPermit,
    ExecutionCancellation,
    ExecutionCompletion,
    ExecutionAcknowledgment,
    ExecutionAcknowledged,
} from 'nerva-connector-protocol/execution/ExecutionJobs.js';
import { IdentityLengths } from 'nerva-connector-protocol/identity/IdentityFormat.js';
import { ConnectorFileJobsCodec } from 'nerva-connector-protocol/protocol/ConnectorFileJobsCodec.js';
import type {
    ConnectorFilePublication,
    ConnectorFilePermit,
    ConnectorFileCompletion,
    ConnectorFileOperation,
    ConnectorFileAcknowledgment,
    ConnectorFileAcknowledged,
} from 'nerva-connector-protocol/protocol/ConnectorFileJobs.js';
import { Boundary } from 'nerva-connector-protocol/protocol/Boundary.js';
import {
    ConnectorUnpairCodec,
    type ConnectorUnpair,
} from 'nerva-connector-protocol/protocol/ConnectorUnpair.js';
import { ConnectorDeviceCodec } from 'nerva-connector-protocol/protocol/ConnectorDeviceCodec.js';
import { ConnectorEnrollmentCodec } from 'nerva-connector-protocol/protocol/ConnectorEnrollmentCodec.js';
import type {
    ConnectorDeviceChallenge,
    ConnectorDeviceHello,
    ConnectorDeviceLease,
} from 'nerva-connector-protocol/protocol/ConnectorDevice.js';
import { ConnectorLinkCodec } from 'nerva-connector-protocol/protocol/ConnectorLinkCodec.js';
import {
    ConnectorLinkFailure,
    ConnectorLinkLimits,
    type ConnectorLinkStart,
    type ConnectorLinkProof,
    type ConnectorLinkIssued,
    type ConnectorLinkStatus,
    type ConnectorLinkReceipt,
} from 'nerva-connector-protocol/protocol/ConnectorLink.js';

/** Purpose-separated authentication and bounded capability frames contain no backend credentials or general network forwarding. */
export enum ConnectorFrameKind {
    HostProfile = 'host-profile',
    HostPermit = 'host-permit',
    HostResult = 'host-result',
    HostAcknowledgment = 'host-acknowledgment',
    HostAcknowledged = 'host-acknowledged',
    Unpair = 'unpair',
    Unpaired = 'unpaired',
    LinkStart = 'link-start',
    LinkPoll = 'link-poll',
    LinkIssued = 'link-issued',
    LinkStatus = 'link-status',
    LinkError = 'link-error',
    Hello = 'hello',
    Inventory = 'inventory',
    Challenge = 'challenge',
    Proof = 'proof',
    Authenticated = 'authenticated',
    JointWorkspacePublication = 'workspace-publication',
    JointWorkspaceActivated = 'workspace-activated',
    JointWorkspaceRetry = 'workspace-retry',
    ExecutionInteractiveReady = 'execution-interactive-ready',
    ExecutionInteractiveReadyStored = 'execution-interactive-ready-stored',
    ExecutionInputReceipt = 'execution-input-receipt',
    ExecutionInputWork = 'execution-input-work',
    ExecutionProfile = 'execution-profile',
    ExecutionPermit = 'execution-permit',
    ExecutionCancellation = 'execution-cancellation',
    ExecutionResult = 'execution-result',
    ExecutionOutput = 'execution-output',
    ExecutionOutputAck = 'execution-output-ack',
    ExecutionAcknowledgment = 'execution-acknowledgment',
    ExecutionAcknowledged = 'execution-acknowledged',
    FileProfile = 'file-profile',
    FilePermit = 'file-permit',
    FileResult = 'file-result',
    FileAcknowledgment = 'file-acknowledgment',
    FileAcknowledged = 'file-acknowledged',
}

/** Self-revocation is available without an active execution session. */
export interface ConnectorUnpairFrame {
    readonly kind: ConnectorFrameKind.Unpair;
    readonly request: ConnectorUnpair;
}
/** Only a verified durable revocation permits local logout to complete. */
export interface ConnectorUnpairedFrame {
    readonly kind: ConnectorFrameKind.Unpaired;
    readonly receipt: ConnectorUnpair;
}
/** One finite initiation requires a device-generated key and signed original request. */
export interface ConnectorLinkStartFrame {
    readonly kind: ConnectorFrameKind.LinkStart;
    readonly request: ConnectorLinkStart;
}
/** The human code cannot authorize device status polling. */
export interface ConnectorLinkPollFrame {
    readonly kind: ConnectorFrameKind.LinkPoll;
    readonly proof: ConnectorLinkProof;
}
/** Trusted local installation configuration supplies the UI URI; devices cannot select a server redirect. */
export interface ConnectorLinkIssuedFrame {
    readonly kind: ConnectorFrameKind.LinkIssued;
    readonly issued: ConnectorLinkIssued;
    readonly receipt: ConnectorLinkReceipt;
}
/** Approval reports account linking, not an online lease or execution capability. */
export interface ConnectorLinkStatusFrame {
    readonly kind: ConnectorFrameKind.LinkStatus;
    readonly status: ConnectorLinkStatus;
    readonly receipt: ConnectorLinkReceipt;
}
/** Every public error has one fixed bounded retry policy and no echoed input or secret. */
export interface ConnectorLinkErrorFrame {
    readonly kind: ConnectorFrameKind.LinkError;
    readonly failure: ConnectorLinkFailure;
    readonly retryAfterMs: number;
}

/** One current transport contract; no downgraded or unauthenticated protocol exists. */
export class ConnectorTransportLimits {
    /** Exact negotiated protocol prevents accidentally upgrading another WebSocket application. */
    public static readonly protocol: string = 'nerva-connector';
    /** No account or bootstrap secret belongs in the connection URL. */
    public static readonly path: string = '/v1/connector/tunnel';
    /** Control and unpublished connections enforce this smaller application frame limit. */
    public static readonly frameBytes: number = 16384;
    /** Authenticated file frames retain a finite result budget; anonymous/control frames keep the smaller bound. */
    public static readonly fileFrameBytes: number = 131072;
    /** Two command lanes retain individually bounded signed terminal envelopes. */
    public static readonly executionFrameBytes: number = 131072;
    /** Capability-specific envelopes cannot silently enlarge control or file message admission. */
    public static bytes(kind: ConnectorFrameKind): number {
        if (
            kind === ConnectorFrameKind.HostProfile ||
            kind === ConnectorFrameKind.HostPermit ||
            kind === ConnectorFrameKind.HostResult ||
            kind === ConnectorFrameKind.HostAcknowledgment ||
            kind === ConnectorFrameKind.HostAcknowledged
        ) {
            return ConnectorHostLimits.frameBytes;
        }
        if (kind === ConnectorFrameKind.ExecutionInputWork) {
            return ExecutionInputWorkCapture.maximumBytes;
        }
        if (
            kind === ConnectorFrameKind.ExecutionInteractiveReady ||
            kind === ConnectorFrameKind.ExecutionInteractiveReadyStored ||
            kind === ConnectorFrameKind.ExecutionInputReceipt
        ) {
            return 16384;
        }
        if (
            kind === ConnectorFrameKind.ExecutionProfile ||
            kind === ConnectorFrameKind.ExecutionPermit ||
            kind === ConnectorFrameKind.ExecutionCancellation ||
            kind === ConnectorFrameKind.ExecutionResult ||
            kind === ConnectorFrameKind.ExecutionOutput ||
            kind === ConnectorFrameKind.ExecutionOutputAck ||
            kind === ConnectorFrameKind.ExecutionAcknowledgment ||
            kind === ConnectorFrameKind.ExecutionAcknowledged
        ) {
            return this.executionFrameBytes;
        }
        if (
            kind === ConnectorFrameKind.FileProfile ||
            kind === ConnectorFrameKind.FilePermit ||
            kind === ConnectorFrameKind.FileResult ||
            kind === ConnectorFrameKind.FileAcknowledgment ||
            kind === ConnectorFrameKind.FileAcknowledged
        ) {
            return this.fileFrameBytes;
        }
        return this.frameBytes;
    }
    /** Failed or silent handshakes cannot retain sockets indefinitely. */
    public static readonly handshakeMs: number = 10000;
    /** Live transport authorization is rechecked independently of incoming device traffic. */
    public static readonly inspectMs: number = 1000;
    /** Fresh proof starts well before the original thirty-second lease expires. */
    public static readonly renewMs: number = 15000;
}

/** Only a confirmed connection may publish this signed customer-reported metadata. */
export interface ConnectorInventoryFrame {
    readonly kind: ConnectorFrameKind.Inventory;
    readonly publication: ConnectorInventoryPublication;
}

/** The enrolled identity and fixed slot select exactly one authenticated connection. */
export interface ConnectorHelloFrame {
    readonly kind: ConnectorFrameKind.Hello;
    readonly hello: ConnectorDeviceHello;
}

/** Only the exact outstanding challenge can be consumed. */
export interface ConnectorProofFrame {
    readonly kind: ConnectorFrameKind.Proof;
    readonly challengeId: string;
    readonly signature: string;
}

/** The private authority signs its exact admitted challenge; a public edge cannot replace it. */
export interface ConnectorChallengeFrame {
    readonly kind: ConnectorFrameKind.Challenge;
    readonly challenge: ConnectorDeviceChallenge;
}

/** This reports device authentication, not execution readiness or a general network tunnel. */
export interface ConnectorAuthenticatedFrame {
    readonly kind: ConnectorFrameKind.Authenticated;
    readonly lease: ConnectorDeviceLease;
}

/** The device proves one immutable binding on its exact current primary lease. */
export interface ConnectorJointWorkspacePublicationFrame {
    readonly kind: ConnectorFrameKind.JointWorkspacePublication;
    readonly publication: JointWorkspacePublication;
}
/** Only the private authority can confirm durable activation of that exact signed publication. */
export interface ConnectorJointWorkspaceActivatedFrame {
    readonly kind: ConnectorFrameKind.JointWorkspaceActivated;
    readonly receipt: JointWorkspaceReceipt;
}

/** A signed delay authenticates temporary prerequisites without activating the workspace. */
export interface ConnectorJointWorkspaceRetryFrame {
    readonly kind: ConnectorFrameKind.JointWorkspaceRetry;
    readonly retry: JointWorkspaceRetry;
}

/** Only named control messages are accepted in either direction. */
export type ConnectorClientFrame =
    | ConnectorHostClientFrame
    | ConnectorUnpairFrame
    | ConnectorJointWorkspacePublicationFrame
    | ConnectorInventoryFrame
    | ConnectorLinkStartFrame
    | ConnectorLinkPollFrame
    | ConnectorHelloFrame
    | ConnectorProofFrame
    | ConnectorExecutionClientFrame
    | ConnectorInteractiveClientFrame
    | ConnectorFileProfileFrame
    | ConnectorFileResultFrame
    | ConnectorFileAcknowledgedFrame;
/** Backend workloads and private controller state are absent from the public protocol. */
export type ConnectorServerFrame =
    | ConnectorHostServerFrame
    | ConnectorUnpairedFrame
    | ConnectorJointWorkspaceRetryFrame
    | ConnectorJointWorkspaceActivatedFrame
    | ConnectorLinkIssuedFrame
    | ConnectorLinkStatusFrame
    | ConnectorLinkErrorFrame
    | ConnectorChallengeFrame
    | ConnectorAuthenticatedFrame
    | ConnectorExecutionServerFrame
    | ConnectorInteractiveServerFrame
    | ConnectorFilePermitFrame
    | ConnectorFileAcknowledgmentFrame;

/** Only signed device profile and original-result proofs travel toward the cloud. */
export interface ConnectorHostProfileFrame {
    readonly kind: ConnectorFrameKind.HostProfile;
    readonly publication: ConnectorHostPublication;
}
/** Only an exact current backend permit can admit a full-host operation. */
export interface ConnectorHostPermitFrame {
    readonly kind: ConnectorFrameKind.HostPermit;
    readonly permit: ConnectorHostPermit;
}
/** Device completion cannot replace its original effect identity after a reconnect. */
export interface ConnectorHostResultFrame {
    readonly kind: ConnectorFrameKind.HostResult;
    readonly completion: ConnectorHostCompletion;
}
/** Backend acknowledgment follows its durable result write. */
export interface ConnectorHostAcknowledgmentFrame {
    readonly kind: ConnectorFrameKind.HostAcknowledgment;
    readonly acknowledgment: ConnectorHostAcknowledgment;
}
/** Local result compaction is confirmed under the device identity. */
export interface ConnectorHostAcknowledgedFrame {
    readonly kind: ConnectorFrameKind.HostAcknowledged;
    readonly receipt: ConnectorHostAcknowledged;
}
/** Host traffic owns a separate finite lane and never borrows confined execution authority. */
export type ConnectorHostClientFrame =
    ConnectorHostProfileFrame | ConnectorHostResultFrame | ConnectorHostAcknowledgedFrame;
/** Device admission and local compaction are the only host server messages. */
export type ConnectorHostServerFrame = ConnectorHostPermitFrame | ConnectorHostAcknowledgmentFrame;
/** First native Ready is journal-durable; the current lease is only its delivery wrapper. */
export interface ConnectorExecutionInteractiveReadyFrame {
    readonly kind: ConnectorFrameKind.ExecutionInteractiveReady;
    readonly submission: ConnectorInteractiveReadyEnvelope;
}
/** Echoing the backend's first retained proof controls transport flow and releases no initial application bytes. */
export interface ConnectorExecutionInteractiveReadyStoredFrame {
    readonly kind: ConnectorFrameKind.ExecutionInteractiveReadyStored;
    readonly submission: ConnectorInteractiveReadyEnvelope;
}
/** A detached receipt still requires exact stored input, prior cursor and enrolled-device proof validation. */
export interface ConnectorExecutionInputReceiptFrame {
    readonly kind: ConnectorFrameKind.ExecutionInputReceipt;
    readonly completion: ExecutionInputReceiptCapture;
}
/** The native owner resolves retained receipt context and persists ACK before staging this unchanged permit. */
export interface ConnectorExecutionInputWorkFrame {
    readonly kind: ConnectorFrameKind.ExecutionInputWork;
    readonly original: ExecutionInteractiveOriginal;
    readonly work: ExecutionInputWorkCapture;
}
export type ConnectorInteractiveClientFrame =
    ConnectorExecutionInteractiveReadyFrame | ConnectorExecutionInputReceiptFrame;
export type ConnectorInteractiveServerFrame =
    ConnectorExecutionInteractiveReadyStoredFrame | ConnectorExecutionInputWorkFrame;

/** Publication is device-signed and carries only public configured aliases. */
export interface ConnectorFileProfileFrame {
    readonly kind: ConnectorFrameKind.FileProfile;
    readonly publication: ConnectorFilePublication;
}
/** The trusted backend signs one finite original dispatch. */
export interface ConnectorFilePermitFrame {
    readonly kind: ConnectorFrameKind.FilePermit;
    readonly permit: ConnectorFilePermit;
}
/** Edge validation uses the claimed request; the private backend independently checks its authoritative original request. */
export interface ConnectorFileResultFrame {
    readonly kind: ConnectorFrameKind.FileResult;
    readonly request: ConnectorFileOperation;
    readonly completion: ConnectorFileCompletion;
}
/** Only the private backend can authorize discarding a retained result. */
export interface ConnectorFileAcknowledgmentFrame {
    readonly kind: ConnectorFrameKind.FileAcknowledgment;
    readonly acknowledgment: ConnectorFileAcknowledgment;
}
/** The device confirms durable local compaction before another sequence is admitted. */
export interface ConnectorFileAcknowledgedFrame {
    readonly kind: ConnectorFrameKind.FileAcknowledged;
    readonly receipt: ConnectorFileAcknowledged;
}
/** Authentication and file lanes have disjoint accepted message kinds and resource budgets. */
export type ConnectorFileClientFrame =
    ConnectorFileProfileFrame | ConnectorFileResultFrame | ConnectorFileAcknowledgedFrame;

/** Signed command grants never contain private executable or journal paths. */
export interface ConnectorExecutionProfileFrame {
    readonly kind: ConnectorFrameKind.ExecutionProfile;
    readonly publication: ExecutionPublication;
}
/** A bounded original dispatch is authorized only by the pinned private backend. */
export interface ConnectorExecutionPermitFrame {
    readonly kind: ConnectorFrameKind.ExecutionPermit;
    readonly permit: ExecutionPermit;
}
/** A separately signed backend stop can interrupt only its exact original command. */
export interface ConnectorExecutionCancellationFrame {
    readonly kind: ConnectorFrameKind.ExecutionCancellation;
    readonly cancellation: ExecutionCancellation;
}
/** Device proof covers the exact original bounded terminal result. */
export interface ConnectorExecutionResultFrame {
    readonly kind: ConnectorFrameKind.ExecutionResult;
    readonly completion: ExecutionCompletion;
}
/** A backend proof authorizes compaction of one already committed command result. */
export interface ConnectorExecutionAcknowledgmentFrame {
    readonly kind: ConnectorFrameKind.ExecutionAcknowledgment;
    readonly acknowledgment: ExecutionAcknowledgment;
}
/** This receipt advances only the device's matching permanent lane watermark. */
export interface ConnectorExecutionAcknowledgedFrame {
    readonly kind: ConnectorFrameKind.ExecutionAcknowledged;
    readonly receipt: ExecutionAcknowledged;
}
/** A durable prefix carries distinct device proofs and cannot complete a command. */
export interface ConnectorExecutionOutputFrame {
    readonly kind: ConnectorFrameKind.ExecutionOutput;
    readonly update: ExecutionOutputUpdate;
}
/** Backend flow control is signed independently of result compaction. */
export interface ConnectorExecutionOutputAckFrame {
    readonly kind: ConnectorFrameKind.ExecutionOutputAck;
    readonly acknowledgment: ExecutionOutputAck;
}
/** Device execution frames cannot admit new account work. */
export type ConnectorExecutionClientFrame =
    | ConnectorExecutionProfileFrame
    | ConnectorExecutionOutputFrame
    | ConnectorExecutionResultFrame
    | ConnectorExecutionAcknowledgedFrame;
/** The receiver verifies both signatures and current exact lane/session independently of transport TLS. */
export type ConnectorExecutionServerFrame =
    | ConnectorExecutionPermitFrame
    | ConnectorExecutionOutputAckFrame
    | ConnectorExecutionCancellationFrame
    | ConnectorExecutionAcknowledgmentFrame;

/** Only commands and terminal receipts enter the blocking native delivery channels. */
export type ConnectorExecutionCommandFrame = Exclude<
    ConnectorExecutionServerFrame,
    ConnectorExecutionOutputAckFrame
>;

/** Text JSON has one bounded exact wire format; additional authority fields are rejected. */
export class ConnectorTransportCodec {
    /** Socket owners enforce byte limits before calling JSON.parse. */
    public static client(text: string): ConnectorClientFrame {
        const raw: unknown = JSON.parse(text);
        const value: Readonly<Record<string, unknown>> = Boundary.record(raw, [
            'kind',
            'submission',
            'hello',
            'challengeId',
            'signature',
            'publication',
            'request',
            'completion',
            'update',
            'receipt',
            'proof',
        ]);
        if (value['kind'] === ConnectorFrameKind.HostProfile) {
            Boundary.record(raw, ['kind', 'publication']);
            return {
                kind: ConnectorFrameKind.HostProfile,
                publication: ConnectorHostCodec.publication(value['publication']),
            };
        }
        if (value['kind'] === ConnectorFrameKind.HostResult) {
            Boundary.record(raw, ['kind', 'completion']);
            return {
                kind: ConnectorFrameKind.HostResult,
                completion: ConnectorHostCodec.completion(value['completion']),
            };
        }
        if (value['kind'] === ConnectorFrameKind.HostAcknowledged) {
            Boundary.record(raw, ['kind', 'receipt']);
            return {
                kind: ConnectorFrameKind.HostAcknowledged,
                receipt: ConnectorHostCodec.acknowledged(value['receipt']),
            };
        }
        if (value['kind'] === ConnectorFrameKind.Unpair) {
            Boundary.record(raw, ['kind', 'request']);
            return {
                kind: ConnectorFrameKind.Unpair,
                request: ConnectorUnpairCodec.read(value['request']),
            };
        }
        if (value['kind'] === ConnectorFrameKind.LinkStart) {
            Boundary.record(raw, ['kind', 'request']);
            return {
                kind: ConnectorFrameKind.LinkStart,
                request: ConnectorLinkCodec.start(value['request']),
            };
        }
        if (value['kind'] === ConnectorFrameKind.LinkPoll) {
            Boundary.record(raw, ['kind', 'proof']);
            return {
                kind: ConnectorFrameKind.LinkPoll,
                proof: ConnectorLinkCodec.proof(value['proof']),
            };
        }
        if (value['kind'] === ConnectorFrameKind.JointWorkspacePublication) {
            Boundary.record(raw, ['kind', 'publication']);
            return {
                kind: ConnectorFrameKind.JointWorkspacePublication,
                publication: JointWorkspacePublicationCodec.publication(value['publication']),
            };
        }
        if (value['kind'] === ConnectorFrameKind.Inventory) {
            Boundary.record(raw, ['kind', 'publication']);
            return {
                kind: ConnectorFrameKind.Inventory,
                publication: ConnectorInventoryCodec.publication(value['publication']),
            };
        }
        if (value['kind'] === ConnectorFrameKind.Hello) {
            Boundary.record(raw, ['kind', 'hello']);
            return {
                kind: ConnectorFrameKind.Hello,
                hello: ConnectorDeviceCodec.hello(value['hello']),
            };
        }
        if (value['kind'] === ConnectorFrameKind.Proof) {
            const proof: Readonly<Record<string, unknown>> = Boundary.record(raw, [
                'kind',
                'challengeId',
                'signature',
            ]);
            return {
                kind: ConnectorFrameKind.Proof,
                challengeId: ConnectorDeviceCodec.nonce(proof['challengeId']),
                signature: ConnectorEnrollmentCodec.binary(
                    proof['signature'],
                    IdentityLengths.signature,
                ),
            };
        }
        if (value['kind'] === ConnectorFrameKind.ExecutionInteractiveReady) {
            InteractiveFields.record(raw, ['kind', 'submission']);
            return {
                kind: ConnectorFrameKind.ExecutionInteractiveReady,
                submission: ConnectorInteractiveProtocol.ready(value['submission']),
            };
        }
        if (value['kind'] === ConnectorFrameKind.ExecutionInputReceipt) {
            InteractiveFields.record(raw, ['kind', 'completion']);
            return {
                kind: ConnectorFrameKind.ExecutionInputReceipt,
                completion: ExecutionInputReceiptCapture.read(value['completion']),
            };
        }
        if (value['kind'] === ConnectorFrameKind.ExecutionProfile) {
            Boundary.record(raw, ['kind', 'publication']);
            return {
                kind: ConnectorFrameKind.ExecutionProfile,
                publication: ExecutionJobsCodec.publication(value['publication']),
            };
        }
        if (value['kind'] === ConnectorFrameKind.ExecutionOutput) {
            Boundary.record(raw, ['kind', 'update']);
            return {
                kind: ConnectorFrameKind.ExecutionOutput,
                update: ExecutionOutputProtocol.update(value['update']),
            };
        }
        if (value['kind'] === ConnectorFrameKind.ExecutionResult) {
            Boundary.record(raw, ['kind', 'completion']);
            return {
                kind: ConnectorFrameKind.ExecutionResult,
                completion: ExecutionJobsCodec.completion(value['completion']),
            };
        }
        if (value['kind'] === ConnectorFrameKind.ExecutionAcknowledged) {
            Boundary.record(raw, ['kind', 'receipt']);
            return {
                kind: ConnectorFrameKind.ExecutionAcknowledged,
                receipt: ExecutionJobsCodec.acknowledged(value['receipt']),
            };
        }
        if (value['kind'] === ConnectorFrameKind.FileProfile) {
            Boundary.record(raw, ['kind', 'publication']);
            return {
                kind: ConnectorFrameKind.FileProfile,
                publication: ConnectorFileJobsCodec.publication(value['publication']),
            };
        }
        if (value['kind'] === ConnectorFrameKind.FileResult) {
            Boundary.record(raw, ['kind', 'request', 'completion']);
            const request: ConnectorFileOperation = ConnectorFileJobsCodec.operation(
                value['request'],
            );
            return {
                kind: ConnectorFrameKind.FileResult,
                request,
                completion: ConnectorFileJobsCodec.completion(value['completion'], request),
            };
        }
        if (value['kind'] === ConnectorFrameKind.FileAcknowledged) {
            Boundary.record(raw, ['kind', 'receipt']);
            return {
                kind: ConnectorFrameKind.FileAcknowledged,
                receipt: ConnectorFileJobsCodec.acknowledged(value['receipt']),
            };
        }
        throw new Error('Unsupported connector client frame');
    }

    /** A connector independently validates all server frames before signing or reporting authentication. */
    public static server(text: string): ConnectorServerFrame {
        const raw: unknown = JSON.parse(text);
        const value: Readonly<Record<string, unknown>> = Boundary.record(raw, [
            'kind',
            'submission',
            'work',
            'original',
            'lease',
            'challenge',
            'permit',
            'cancellation',
            'acknowledgment',
            'issued',
            'status',
            'failure',
            'retryAfterMs',
            'receipt',
            'retry',
        ]);
        if (value['kind'] === ConnectorFrameKind.HostPermit) {
            Boundary.record(raw, ['kind', 'permit']);
            return {
                kind: ConnectorFrameKind.HostPermit,
                permit: ConnectorHostCodec.permit(value['permit']),
            };
        }
        if (value['kind'] === ConnectorFrameKind.HostAcknowledgment) {
            Boundary.record(raw, ['kind', 'acknowledgment']);
            return {
                kind: ConnectorFrameKind.HostAcknowledgment,
                acknowledgment: ConnectorHostCodec.acknowledgment(value['acknowledgment']),
            };
        }
        if (value['kind'] === ConnectorFrameKind.Unpaired) {
            Boundary.record(raw, ['kind', 'receipt']);
            return {
                kind: ConnectorFrameKind.Unpaired,
                receipt: ConnectorUnpairCodec.read(value['receipt']),
            };
        }
        if (value['kind'] === ConnectorFrameKind.LinkIssued) {
            Boundary.record(raw, ['kind', 'issued', 'receipt']);
            return {
                kind: ConnectorFrameKind.LinkIssued,
                issued: ConnectorLinkCodec.issued(value['issued']),
                receipt: ConnectorLinkCodec.receipt(value['receipt']),
            };
        }
        if (value['kind'] === ConnectorFrameKind.LinkStatus) {
            Boundary.record(raw, ['kind', 'status', 'receipt']);
            return {
                kind: ConnectorFrameKind.LinkStatus,
                status: ConnectorLinkCodec.status(value['status']),
                receipt: ConnectorLinkCodec.receipt(value['receipt']),
            };
        }
        if (value['kind'] === ConnectorFrameKind.LinkError) {
            Boundary.record(raw, ['kind', 'failure', 'retryAfterMs']);
            const failure: ConnectorLinkFailure | undefined = Object.values(
                ConnectorLinkFailure,
            ).find((entry: ConnectorLinkFailure): boolean => entry === value['failure']);
            if (
                failure === undefined ||
                value['retryAfterMs'] !==
                    (failure === ConnectorLinkFailure.Unavailable ||
                    failure === ConnectorLinkFailure.RateLimited
                        ? ConnectorLinkLimits.pollMs
                        : 0)
            ) {
                throw new Error('Invalid connector link failure');
            }
            return {
                kind: ConnectorFrameKind.LinkError,
                failure,
                retryAfterMs: value['retryAfterMs'],
            };
        }
        if (value['kind'] === ConnectorFrameKind.JointWorkspaceRetry) {
            Boundary.record(raw, ['kind', 'retry']);
            return {
                kind: ConnectorFrameKind.JointWorkspaceRetry,
                retry: JointWorkspaceRetryCodec.retry(value['retry']),
            };
        }
        if (value['kind'] === ConnectorFrameKind.JointWorkspaceActivated) {
            Boundary.record(raw, ['kind', 'receipt']);
            return {
                kind: ConnectorFrameKind.JointWorkspaceActivated,
                receipt: JointWorkspaceReceiptCodec.receipt(value['receipt']),
            };
        }
        if (value['kind'] === ConnectorFrameKind.Challenge) {
            Boundary.record(raw, ['kind', 'challenge']);
            return {
                kind: ConnectorFrameKind.Challenge,
                challenge: ConnectorDeviceCodec.challenge(value['challenge']),
            };
        }
        if (value['kind'] === ConnectorFrameKind.Authenticated) {
            Boundary.record(raw, ['kind', 'lease']);
            return {
                kind: ConnectorFrameKind.Authenticated,
                lease: ConnectorDeviceCodec.lease(value['lease']),
            };
        }
        if (value['kind'] === ConnectorFrameKind.ExecutionInteractiveReadyStored) {
            InteractiveFields.record(raw, ['kind', 'submission']);
            return {
                kind: ConnectorFrameKind.ExecutionInteractiveReadyStored,
                submission: ConnectorInteractiveProtocol.ready(value['submission']),
            };
        }
        if (value['kind'] === ConnectorFrameKind.ExecutionInputWork) {
            InteractiveFields.record(raw, ['kind', 'original', 'work']);
            const work: ExecutionInputWorkCapture = ExecutionInputWorkCapture.read(value['work']);
            return {
                kind: ConnectorFrameKind.ExecutionInputWork,
                original: ConnectorInteractiveProtocol.original(value['original'], work),
                work,
            };
        }
        if (value['kind'] === ConnectorFrameKind.ExecutionOutputAck) {
            Boundary.record(raw, ['kind', 'acknowledgment']);
            return {
                kind: ConnectorFrameKind.ExecutionOutputAck,
                acknowledgment: ExecutionOutputProtocol.ack(value['acknowledgment']),
            };
        }
        if (value['kind'] === ConnectorFrameKind.ExecutionPermit) {
            Boundary.record(raw, ['kind', 'permit']);
            return {
                kind: ConnectorFrameKind.ExecutionPermit,
                permit: ExecutionJobsCodec.permit(value['permit']),
            };
        }
        if (value['kind'] === ConnectorFrameKind.ExecutionCancellation) {
            Boundary.record(raw, ['kind', 'cancellation']);
            return {
                kind: ConnectorFrameKind.ExecutionCancellation,
                cancellation: ExecutionJobsCodec.cancellation(value['cancellation']),
            };
        }
        if (value['kind'] === ConnectorFrameKind.ExecutionAcknowledgment) {
            Boundary.record(raw, ['kind', 'acknowledgment']);
            return {
                kind: ConnectorFrameKind.ExecutionAcknowledgment,
                acknowledgment: ExecutionJobsCodec.acknowledgment(value['acknowledgment']),
            };
        }
        if (value['kind'] === ConnectorFrameKind.FilePermit) {
            Boundary.record(raw, ['kind', 'permit']);
            return {
                kind: ConnectorFrameKind.FilePermit,
                permit: ConnectorFileJobsCodec.permit(value['permit']),
            };
        }
        if (value['kind'] === ConnectorFrameKind.FileAcknowledgment) {
            Boundary.record(raw, ['kind', 'acknowledgment']);
            return {
                kind: ConnectorFrameKind.FileAcknowledgment,
                acknowledgment: ConnectorFileJobsCodec.acknowledgment(value['acknowledgment']),
            };
        }
        throw new Error('Unsupported connector server frame');
    }

    /** Exact domain times are serialized only as decimal strings. */
    public static encode(frame: ConnectorClientFrame | ConnectorServerFrame): string {
        if (
            frame.kind === ConnectorFrameKind.ExecutionInteractiveReady ||
            frame.kind === ConnectorFrameKind.ExecutionInteractiveReadyStored
        ) {
            InteractiveFields.record(frame, ['kind', 'submission']);
            return (
                '{"kind":' +
                JSON.stringify(frame.kind) +
                ',"submission":' +
                ConnectorInteractiveProtocol.encodeReady(frame.submission) +
                '}'
            );
        }
        if (frame.kind === ConnectorFrameKind.ExecutionInputReceipt) {
            InteractiveFields.record(frame, ['kind', 'completion']);
            return (
                '{"kind":' +
                JSON.stringify(frame.kind) +
                ',"completion":' +
                frame.completion.encode() +
                '}'
            );
        }
        if (frame.kind === ConnectorFrameKind.ExecutionInputWork) {
            InteractiveFields.record(frame, ['kind', 'original', 'work']);
            return (
                '{"kind":' +
                JSON.stringify(frame.kind) +
                ',"original":' +
                ConnectorInteractiveProtocol.encodeOriginal(frame.original, frame.work) +
                ',"work":' +
                frame.work.encode() +
                '}'
            );
        }
        return JSON.stringify(frame, (_key: string, value: unknown): unknown =>
            typeof value === 'bigint' ? value.toString() : value,
        );
    }
}
