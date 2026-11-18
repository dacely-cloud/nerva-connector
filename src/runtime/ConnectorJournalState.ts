// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

import type { ConnectorAuthorization } from 'nerva-connector-protocol/protocol/ConnectorAuthorization.js';
import type { ConnectorJournalReceipt } from 'nerva-connector-protocol/protocol/ConnectorJournalReceipt.js';
import { ConnectorAuthorizationCodec } from 'nerva-connector-protocol/protocol/ConnectorAuthorizationCodec.js';
import { ConnectorJournalFormatError } from './ConnectorJournalFormatError.js';
import type { ConnectorEffectContext } from './ConnectorEffectContext.js';
import { Boundary } from 'nerva-connector-protocol/protocol/Boundary.js';
import { ConnectorDeviceCodec } from 'nerva-connector-protocol/protocol/ConnectorDeviceCodec.js';
import { ConnectorEnrollmentCodec } from 'nerva-connector-protocol/protocol/ConnectorEnrollmentCodec.js';
import type { ConnectorOperationCodec, ConnectorStorageCodec } from './ConnectorOperationCodec.js';

/** One current storage format requires local effect provenance even when its original capture is unproven. */
export enum ConnectorJournalSchema {
    AuthorizedEffectContext = 'authorized-effect-context',
}

/** Null response means execution may have started; recovery must never repeat that operation. */
export interface ConnectorJournalPending<TRequest, TResponse, TProgress = never> extends Omit<
    ConnectorJournalReceipt,
    'responseHash'
> {
    readonly authorization: ConnectorAuthorization;
    readonly request: TRequest;
    readonly effectContext: ConnectorEffectContext;
    readonly response: TResponse | null;
    readonly progress: TProgress | null;
}
/** One capability lane has an ordered pending request, a permanent acknowledgment watermark and its last receipt. */
export interface ConnectorJournalSnapshot<TRequest, TResponse, TProgress = never> {
    readonly schema: ConnectorJournalSchema.AuthorizedEffectContext;
    readonly journalId: string;
    readonly acknowledgedSequence: bigint;
    readonly receipt: ConnectorJournalReceipt | null;
    readonly pending: ConnectorJournalPending<TRequest, TResponse, TProgress> | null;
}

/** Decrypted local storage is untrusted until its exact counter, hashes and response correlation validate. */
export class ConnectorJournalState<
    TRequest,
    TResponse,
    TProgress = never,
> implements ConnectorStorageCodec<ConnectorJournalSnapshot<TRequest, TResponse, TProgress>> {
    /** Concrete codecs define authorization shapes; the journal never interprets a program or file operation. */
    public constructor(
        public readonly codec: ConnectorOperationCodec<TRequest, TResponse, TProgress>,
    ) {}
    /** A newly initialized journal grants no authority and retains no content. */
    public empty(journalId: string): ConnectorJournalSnapshot<TRequest, TResponse, TProgress> {
        return {
            schema: ConnectorJournalSchema.AuthorizedEffectContext,
            journalId: ConnectorEnrollmentCodec.digest(journalId),
            acknowledgedSequence: 0n,
            receipt: null,
            pending: null,
        };
    }
    /** Exact decimal counters cannot be reconstructed from missing, old or contradictory fields. */
    public read(raw: unknown): ConnectorJournalSnapshot<TRequest, TResponse, TProgress> {
        const value: Readonly<Record<string, unknown>> = Boundary.record(raw, [
            'schema',
            'acknowledgedSequence',
            'journalId',
            'receipt',
            'pending',
        ]);
        if (value['schema'] !== ConnectorJournalSchema.AuthorizedEffectContext) {
            throw new ConnectorJournalFormatError();
        }
        const acknowledgedSequence: bigint = Boundary.integer(value['acknowledgedSequence']);
        const receipt: ConnectorJournalReceipt | null =
            value['receipt'] === null ? null : this.receipt(value['receipt']);
        const pending: ConnectorJournalPending<TRequest, TResponse, TProgress> | null =
            value['pending'] === null ? null : this.pending(value['pending']);
        if (
            (acknowledgedSequence === 0n) !== (receipt === null) ||
            (receipt !== null && receipt.sequence !== acknowledgedSequence) ||
            (pending !== null && pending.sequence !== acknowledgedSequence + 1n)
        ) {
            throw new Error('Invalid connector journal ordering');
        }
        return {
            schema: ConnectorJournalSchema.AuthorizedEffectContext,
            journalId: ConnectorEnrollmentCodec.digest(value['journalId']),
            acknowledgedSequence,
            receipt,
            pending,
        };
    }
    /** Retained metadata must identify one finite original dispatch. */
    public receipt(raw: unknown): ConnectorJournalReceipt {
        const value: Readonly<Record<string, unknown>> = Boundary.record(raw, [
            'jobId',
            'sequence',
            'dispatchId',
            'requestHash',
            'admissionHash',
            'responseHash',
        ]);
        const sequence: bigint = Boundary.integer(value['sequence']);
        if (sequence === 0n) {
            throw new Error('Invalid connector receipt sequence');
        }
        return {
            jobId: Boundary.id(value['jobId']),
            sequence,
            dispatchId: ConnectorDeviceCodec.nonce(value['dispatchId']),
            requestHash: ConnectorEnrollmentCodec.digest(value['requestHash']),
            admissionHash: ConnectorEnrollmentCodec.digest(value['admissionHash']),
            responseHash: ConnectorEnrollmentCodec.digest(value['responseHash']),
        };
    }
    /** Payload and result hashes always refer to normalized validated shapes. */
    public pending(raw: unknown): ConnectorJournalPending<TRequest, TResponse, TProgress> {
        const value: Readonly<Record<string, unknown>> = Boundary.record(raw, [
            'jobId',
            'sequence',
            'dispatchId',
            'requestHash',
            'admissionHash',
            'authorization',
            'request',
            'effectContext',
            'response',
            'progress',
        ]);
        const request: TRequest = this.codec.request(value['request']);
        const sequence: bigint = Boundary.integer(value['sequence']);
        const requestHash: string = ConnectorEnrollmentCodec.digest(value['requestHash']);
        const authorization: ConnectorAuthorization = ConnectorAuthorizationCodec.read(
            value['authorization'],
        );
        const admissionHash: string = ConnectorEnrollmentCodec.digest(value['admissionHash']);
        if (
            sequence === 0n ||
            requestHash !== this.codec.requestHash(request) ||
            admissionHash !== this.codec.admissionHash(requestHash, authorization)
        ) {
            throw new Error('Invalid connector retained request');
        }
        const effectContext: ConnectorEffectContext = this.codec.effectContext(
            value['effectContext'],
            request,
        );
        const response: TResponse | null =
            value['response'] === null
                ? null
                : this.codec.response(value['response'], request, effectContext);
        let progress: TProgress | null = null;
        if (value['progress'] !== null) {
            if (this.codec.progress === null || response !== null) {
                throw new Error('Invalid retained progress phase');
            }
            progress = this.codec.progress.read(value['progress'], request, effectContext);
        }
        return Object.freeze({
            jobId: Boundary.id(value['jobId']),
            sequence,
            dispatchId: ConnectorDeviceCodec.nonce(value['dispatchId']),
            requestHash,
            admissionHash,
            authorization,
            request,
            effectContext,
            response,
            progress,
        });
    }
    /** Storage contains only exact decimal wire quantities and finite validated state. */
    public encode(value: ConnectorJournalSnapshot<TRequest, TResponse, TProgress>): string {
        return JSON.stringify(value, (_key: string, entry: unknown): unknown =>
            typeof entry === 'bigint' ? entry.toString() : entry,
        );
    }
}
