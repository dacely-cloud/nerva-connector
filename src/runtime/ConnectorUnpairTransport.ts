// SPDX-FileCopyrightText: 2026 Dacely <business@dacely.com>
// SPDX-License-Identifier: LicenseRef-Proprietary

import { ConnectorSocket } from '../networking/ConnectorSocket.js';
import { SigningKey } from '../identity/SigningKey.js';
import { SignaturePurpose } from 'nerva-connector-protocol/identity/IdentityFormat.js';
import {
    ConnectorUnpairCodec,
    type ConnectorUnpair,
} from 'nerva-connector-protocol/protocol/ConnectorUnpair.js';
import {
    ConnectorFrameKind,
    ConnectorTransportCodec,
    ConnectorTransportLimits,
    type ConnectorServerFrame,
} from '../protocol/ConnectorTransport.js';
import type { ConnectorPairIdentity } from './ConnectorPairConfiguration.js';

/** Unpairing confirms a device-signed server revocation before the local identity can be retired. */
export class ConnectorUnpairTransport {
    /** Network loss preserves the same immutable key target, permitting safe retries across any configured edge. */
    public static async run(
        configuration: ConnectorPairIdentity,
        key: SigningKey,
        signal: AbortSignal,
    ): Promise<void> {
        const target: Pick<ConnectorUnpair, 'authorityId' | 'publicKey'> = {
            authorityId: configuration.authority.authorityId,
            publicKey: key.publicKey,
        };
        const request: ConnectorUnpair = {
            ...target,
            signature: key.sign(
                SignaturePurpose.DeviceUnpair,
                Buffer.from(ConnectorUnpairCodec.payload(target)),
            ),
        };
        const payload: string = ConnectorTransportCodec.encode({
            kind: ConnectorFrameKind.Unpair,
            request,
        });
        const active: AbortSignal = AbortSignal.any([signal, AbortSignal.timeout(30000)]);
        for (const endpoint of configuration.settings.endpoints) {
            active.throwIfAborted();
            try {
                await this.#exchange(endpoint, payload, configuration, request, active);
                return;
            } catch {
                active.throwIfAborted();
            }
        }
        throw new Error(
            'Unable to confirm unpairing. Your pairing is preserved; reconnect and retry /logout.',
        );
    }

    static async #exchange(
        endpoint: string,
        payload: string,
        configuration: ConnectorPairIdentity,
        request: ConnectorUnpair,
        signal: AbortSignal,
    ): Promise<void> {
        const done: PromiseWithResolvers<undefined> = Promise.withResolvers<undefined>();
        const socket: ConnectorSocket = new ConnectorSocket(
            endpoint,
            ConnectorTransportLimits.protocol,
            {
                ca: configuration.ca,
                maximumPayload: ConnectorTransportLimits.frameBytes,
                handshakeMs: ConnectorTransportLimits.handshakeMs,
            },
        );
        const abort: () => void = (): void => {
            done.reject(new Error('Unpairing interrupted'));
            socket.terminate();
        };
        const timer: NodeJS.Timeout = setTimeout(abort, ConnectorTransportLimits.handshakeMs);
        signal.addEventListener('abort', abort, { once: true });
        socket.on('error', (): void => done.reject(new Error('Unpairing connection failed')));
        socket.once('close', (): void => done.reject(new Error('Unpairing connection closed')));
        socket.once('open', (): void => {
            if (signal.aborted) {
                abort();
            } else {
                socket.send(payload);
            }
        });
        socket.once('message', (data: Buffer, binary: boolean): void => {
            try {
                if (binary || data.byteLength > ConnectorTransportLimits.frameBytes) {
                    throw new Error('Invalid unpair acknowledgment');
                }
                const reply: ConnectorServerFrame = ConnectorTransportCodec.server(
                    new TextDecoder('utf-8', { fatal: true }).decode(data),
                );
                if (
                    reply.kind !== ConnectorFrameKind.Unpaired ||
                    reply.receipt.authorityId !== request.authorityId ||
                    reply.receipt.publicKey !== request.publicKey ||
                    !SigningKey.verify(
                        SignaturePurpose.DeviceUnpaired,
                        configuration.authority.publicKey,
                        Buffer.from(ConnectorUnpairCodec.payload(reply.receipt)),
                        reply.receipt.signature,
                    )
                ) {
                    throw new Error('Unpairing authority proof rejected');
                }
                done.resolve(undefined);
            } catch (caught: unknown) {
                done.reject(caught);
            }
        });
        try {
            if (signal.aborted) {
                abort();
            }
            await done.promise;
        } finally {
            clearTimeout(timer);
            signal.removeEventListener('abort', abort);
            socket.terminate();
        }
    }
}
