// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

import { SigningKey } from '../identity/SigningKey.js';
import { SignaturePurpose } from 'nerva-connector-protocol/identity/IdentityFormat.js';
import { ConnectorLinkCodec } from 'nerva-connector-protocol/protocol/ConnectorLinkCodec.js';
import type { ConnectorTrustedAuthority } from './ConnectorAuthorityPin.js';
import { createHash } from 'node:crypto';
import { ConnectorSocket } from '../networking/ConnectorSocket.js';
import { ConnectorStartupStage, type ConnectorStartupObserver } from './ConnectorStartup.js';
import {
    ConnectorTransportCodec,
    ConnectorTransportLimits,
    ConnectorFrameKind,
    type ConnectorLinkStartFrame,
    type ConnectorLinkPollFrame,
    type ConnectorLinkIssuedFrame,
    type ConnectorLinkStatusFrame,
    type ConnectorLinkErrorFrame,
    type ConnectorServerFrame,
} from '../protocol/ConnectorTransport.js';
import {
    ConnectorLinkFailure,
    ConnectorLinkLimits,
    type ConnectorLinkProof,
} from 'nerva-connector-protocol/protocol/ConnectorLink.js';

/** Pairing uses only the bounded linking lane, never an enrolled session or a file permit. */
export type ConnectorPairReply =
    ConnectorLinkIssuedFrame | ConnectorLinkStatusFrame | ConnectorLinkErrorFrame;

/** Network loss is distinct from a verified response that rejects this original device request. */
class ConnectorPairDisconnected extends Error {
    public constructor() {
        super('Connector pairing transport unavailable');
    }
}

/** Each finite verified TLS exchange owns its socket, deadline and abort subscription; no redirect or plaintext fallback exists. */
export class ConnectorPairTransport {
    #next: number = 0;
    /** Endpoints and trust come from protected local deployment configuration. */
    public constructor(
        public readonly endpoints: readonly string[],
        public readonly ca: Buffer | undefined,
        public readonly authority: ConnectorTrustedAuthority,
        public readonly progress?: ConnectorStartupObserver,
    ) {}
    /** Only network loss tries another configured edge; returned rate/authorization decisions are preserved. */
    public async exchange(
        frame: ConnectorLinkStartFrame | ConnectorLinkPollFrame,
        signal: AbortSignal,
    ): Promise<ConnectorPairReply> {
        const captured: ReturnType<typeof ConnectorTransportCodec.client> =
            ConnectorTransportCodec.client(ConnectorTransportCodec.encode(frame));
        if (
            captured.kind !== ConnectorFrameKind.LinkStart &&
            captured.kind !== ConnectorFrameKind.LinkPoll
        ) {
            throw new Error('Pairing transport requires a linking operation');
        }
        const deadline: AbortSignal = AbortSignal.any([signal, AbortSignal.timeout(60000)]);
        for (let attempt: number = 0; attempt < this.endpoints.length; attempt++) {
            deadline.throwIfAborted();
            const endpoint: string | undefined = this.endpoints[this.#next];
            this.#next = (this.#next + 1) % this.endpoints.length;
            if (endpoint === undefined) {
                throw new Error('Pairing endpoint set is empty');
            }
            try {
                return await this.#single(endpoint, captured, deadline);
            } catch (caught: unknown) {
                if (!(caught instanceof ConnectorPairDisconnected)) {
                    throw caught;
                }
            }
        }
        deadline.throwIfAborted();
        return {
            kind: ConnectorFrameKind.LinkError,
            failure: ConnectorLinkFailure.Unavailable,
            retryAfterMs: ConnectorLinkLimits.pollMs,
        };
    }
    async #single(
        endpoint: string,
        frame: ConnectorLinkStartFrame | ConnectorLinkPollFrame,
        signal: AbortSignal,
    ): Promise<ConnectorPairReply> {
        const payload: string = ConnectorTransportCodec.encode(frame);
        if (Buffer.byteLength(payload) > ConnectorTransportLimits.frameBytes) {
            throw new Error('Pairing request exceeds its frame bound');
        }
        const input: ConnectorLinkProof =
            frame.kind === ConnectorFrameKind.LinkStart ? frame.request : frame.proof;
        const expected: string = createHash('sha256')
            .update(Buffer.from(input.requestId, 'base64url'))
            .digest('hex');
        const publicKey: string = input.publicKey;
        if (input.authorityId !== this.authority.authorityId) {
            throw new Error('Pairing request changed its installed authority');
        }
        const done: PromiseWithResolvers<ConnectorPairReply> =
            Promise.withResolvers<ConnectorPairReply>();
        const socket: ConnectorSocket = new ConnectorSocket(
            endpoint,
            ConnectorTransportLimits.protocol,
            {
                ca: this.ca,
                maximumPayload: ConnectorTransportLimits.frameBytes,
                handshakeMs: ConnectorTransportLimits.handshakeMs,
                ...(this.progress === undefined ? {} : { progress: this.progress }),
            },
        );
        const abort: () => void = (): void => socket.terminate();
        const timer: NodeJS.Timeout = setTimeout(abort, ConnectorTransportLimits.handshakeMs);
        signal.addEventListener('abort', abort, { once: true });
        socket.on('error', (): void => {
            done.reject(new ConnectorPairDisconnected());
            socket.terminate();
        });
        socket.once('close', (): void => done.reject(new ConnectorPairDisconnected()));
        socket.once('open', (): void => {
            if (signal.aborted) {
                abort();
            } else {
                this.progress?.({
                    stage:
                        frame.kind === ConnectorFrameKind.LinkStart
                            ? ConnectorStartupStage.PairingRequest
                            : ConnectorStartupStage.PairingStatus,
                });
                socket.send(payload);
            }
        });
        socket.once('message', (data: Buffer, binary: boolean): void => {
            try {
                this.progress?.({ stage: ConnectorStartupStage.Verification });
                if (
                    binary ||
                    !Buffer.isBuffer(data) ||
                    data.byteLength > ConnectorTransportLimits.frameBytes
                ) {
                    throw new Error('Pairing response exceeds its frame bound');
                }
                const reply: ConnectorServerFrame = ConnectorTransportCodec.server(
                    new TextDecoder('utf-8', { fatal: true }).decode(data),
                );
                if (reply.kind === ConnectorFrameKind.LinkError) {
                    done.resolve(reply);
                } else if (
                    frame.kind === ConnectorFrameKind.LinkStart &&
                    reply.kind === ConnectorFrameKind.LinkIssued &&
                    reply.issued.linkId === expected
                ) {
                    this.#verify(input, reply);
                    done.resolve(reply);
                } else if (
                    frame.kind === ConnectorFrameKind.LinkPoll &&
                    reply.kind === ConnectorFrameKind.LinkStatus &&
                    reply.status.linkId === expected &&
                    reply.status.publicKey === publicKey
                ) {
                    this.#verify(input, reply);
                    done.resolve(reply);
                } else {
                    throw new Error('Pairing response does not match the original request');
                }
            } catch {
                done.reject(new Error('Connector pairing response violates its contract'));
            }
        });
        try {
            return await done.promise;
        } finally {
            clearTimeout(timer);
            signal.removeEventListener('abort', abort);
            socket.terminate();
        }
    }
    /** The exact current nonce, signed device proof, reply bytes and finite server lifetime are verified before state changes. */
    #verify(
        input: ConnectorLinkStartFrame['request'] | ConnectorLinkPollFrame['proof'],
        reply: ConnectorLinkIssuedFrame | ConnectorLinkStatusFrame,
    ): void {
        const now: bigint = BigInt(Date.now());
        const result: ConnectorLinkIssuedFrame['issued'] | ConnectorLinkStatusFrame['status'] =
            reply.kind === ConnectorFrameKind.LinkIssued ? reply.issued : reply.status;
        const purpose: SignaturePurpose =
            reply.kind === ConnectorFrameKind.LinkIssued
                ? SignaturePurpose.LinkIssued
                : SignaturePurpose.LinkStatus;
        if (
            reply.receipt.authorityId !== this.authority.authorityId ||
            reply.receipt.issuedAtMs > now + BigInt(ConnectorLinkLimits.clockLeadMs) ||
            reply.receipt.expiresAtMs <= now ||
            !SigningKey.verify(
                purpose,
                this.authority.publicKey,
                Buffer.from(ConnectorLinkCodec.receiptPayload(input, result, reply.receipt)),
                reply.receipt.signature,
            )
        ) {
            throw new Error('Connector pairing authority proof rejected');
        }
    }
}
