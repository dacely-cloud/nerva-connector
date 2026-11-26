// SPDX-FileCopyrightText: 2026 Dacely <business@dacely.com>
// SPDX-License-Identifier: LicenseRef-Proprietary

import { SystemInfo } from '../system/SystemInfo.js';
import { SystemSpecificationCodec } from 'nerva-connector-protocol/system/SystemSpecificationCodec.js';
import { Boundary } from 'nerva-connector-protocol/protocol/Boundary.js';
import { ExchangeCodec } from 'nerva-connector-protocol/remote/ExchangeCodec.js';
import type { SignedExchange } from 'nerva-connector-protocol/remote/ExchangeFormat.js';
import { DeviceSession } from './DeviceSession.js';

/** Only this finite read-only operation is accepted; there is no command string or caller-selected executable. */
export enum SystemInfoAction {
    Read = 'system-info',
}

/** Approved operation context is provided by the trusted transport owner, never adopted from the incoming message. */
export class SystemInfoOperation {
    /** Verifies both authority signatures, exact recipient/runtime/lease context and operation before collecting metadata. */
    public static async execute(
        bytes: Uint8Array,
        session: DeviceSession,
        signal: AbortSignal,
    ): Promise<SignedExchange> {
        try {
            signal.throwIfAborted();
            const request: SignedExchange = session.request(bytes, BigInt(Date.now()));
            const raw: unknown = JSON.parse(request.payload);
            const operation: Readonly<Record<string, unknown>> = Boundary.record(raw, ['action']);
            if (operation['action'] !== SystemInfoAction.Read.valueOf()) {
                throw new Error('Unsupported signed system information operation');
            }
            const specification: ReturnType<typeof SystemSpecificationCodec.read> =
                SystemSpecificationCodec.read(await SystemInfo.read(signal));
            signal.throwIfAborted();
            const now: bigint = BigInt(Date.now());
            if (request.expiresAtMs <= now) {
                throw new Error('Signed system information operation expired during collection');
            }
            return session.result(
                request,
                JSON.stringify({
                    requestSha256: ExchangeCodec.digest(request),
                    specification,
                }),
                now,
            );
        } catch (caught: unknown) {
            session[Symbol.dispose]();
            throw caught;
        }
    }
}
