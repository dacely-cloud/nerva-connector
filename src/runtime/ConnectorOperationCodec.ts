// SPDX-FileCopyrightText: 2026 Dacely <business@dacely.com>
// SPDX-License-Identifier: LicenseRef-Proprietary

import type { ConnectorEffectContext } from './ConnectorEffectContext.js';
import type { ConnectorProgressCodec } from './ConnectorProgressCodec.js';
import type { ConnectorAuthorization } from 'nerva-connector-protocol/protocol/ConnectorAuthorization.js';

/** Purpose separates keys, encrypted files and exclusive owners for independent operation journals. */
export enum ConnectorOperationPurpose {
    Files = 'files',
    ExecutionFirst = 'execution-first',
    ExecutionSecond = 'execution-second',
}

/** A concrete operation validates decrypted request/result data before the generic durable owner uses it. */
export interface ConnectorOperationCodec<TRequest, TResponse, TProgress = never> {
    readonly purpose: ConnectorOperationPurpose;
    readonly progress: ConnectorProgressCodec<TRequest, TResponse, TProgress> | null;
    request(raw: unknown): TRequest;
    effectContext(raw: unknown, request: TRequest): ConnectorEffectContext;
    response(raw: unknown, request: TRequest, effectContext: ConnectorEffectContext): TResponse;
    requestHash(request: TRequest): string;
    admissionHash(requestHash: string, authorization: ConnectorAuthorization): string;
    responseHash(response: TResponse): string;
}

/** Cryptographic storage immediately validates decoded external JSON into this exact caller-owned state contract. */
export interface ConnectorStorageCodec<TState> {
    read(raw: unknown, sourceSha256: string): TState;
    encode(state: TState): string;
}
