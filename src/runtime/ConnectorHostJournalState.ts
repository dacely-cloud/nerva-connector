// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

import { Boundary } from 'nerva-connector-protocol/protocol/Boundary.js';
import { ConnectorEnrollmentCodec } from 'nerva-connector-protocol/protocol/ConnectorEnrollmentCodec.js';
import { ConnectorDeviceCodec } from 'nerva-connector-protocol/protocol/ConnectorDeviceCodec.js';
import { ConnectorHostCodec } from 'nerva-connector-protocol/protocol/ConnectorHostCodec.js';
import type {
    ConnectorHostRequest,
    ConnectorHostResponse,
} from 'nerva-connector-protocol/protocol/ConnectorHost.js';
import { ConnectorHostProof } from './ConnectorHostProof.js';
import type { ConnectorStorageCodec } from './ConnectorOperationCodec.js';

/** Original identity is independent of the shorter-lived delivery lease and signature wrapper. */
export interface ConnectorHostOriginal {
    readonly jobId: string;
    readonly sequence: bigint;
    readonly dispatchId: string;
    readonly requestHash: string;
}
/** A retained operation is written before effect admission and completed before transport delivery. */
export interface ConnectorHostPending extends ConnectorHostOriginal {
    readonly request: ConnectorHostRequest;
    readonly response: ConnectorHostResponse | null;
}
/** Only the latest acknowledged receipt is needed after permanent counter advancement. */
export interface ConnectorHostReceipt extends ConnectorHostOriginal {
    readonly responseHash: string;
}
/** One bounded snapshot retains the permanent sequence and at most one complete operation. */
export interface ConnectorHostSnapshot {
    readonly journalId: string;
    readonly sequence: bigint;
    readonly acknowledgedSequence: bigint;
    readonly pending: ConnectorHostPending | null;
    readonly receipt: ConnectorHostReceipt | null;
}

/** Authenticated decryption immediately validates exact host history and its internal commitments. */
export class ConnectorHostJournalState implements ConnectorStorageCodec<ConnectorHostSnapshot> {
    /** A directory/enrollment/grant-specific cipher supplies integrity; this codec supplies shape and range checks. */
    public read(raw: unknown, _sourceSha256: string): ConnectorHostSnapshot {
        const value: Readonly<Record<string, unknown>> = Boundary.record(raw, [
            'journalId',
            'sequence',
            'acknowledgedSequence',
            'pending',
            'receipt',
        ]);
        const sequence: bigint = Boundary.integer(value['sequence']);
        const acknowledgedSequence: bigint = Boundary.integer(value['acknowledgedSequence']);
        const pending: ConnectorHostPending | null =
            value['pending'] === null ? null : this.#pending(value['pending']);
        const receipt: ConnectorHostReceipt | null =
            value['receipt'] === null ? null : this.#receipt(value['receipt']);
        if (
            acknowledgedSequence > sequence ||
            sequence - acknowledgedSequence > 1n ||
            (pending === null) !== (sequence === acknowledgedSequence) ||
            (pending !== null && pending.sequence !== sequence) ||
            (receipt === null) !== (acknowledgedSequence === 0n) ||
            (receipt !== null && receipt.sequence !== acknowledgedSequence)
        ) {
            throw new Error('Invalid retained host sequence history');
        }
        return {
            journalId: ConnectorEnrollmentCodec.digest(value['journalId']),
            sequence,
            acknowledgedSequence,
            pending,
            receipt,
        };
    }
    /** Canonical serialization preserves exact counters and complete original request text. */
    public encode(state: ConnectorHostSnapshot): string {
        return ConnectorHostCodec.encode(state);
    }
    #original(value: Readonly<Record<string, unknown>>): ConnectorHostOriginal {
        const sequence: bigint = Boundary.integer(value['sequence']);
        if (sequence === 0n) {
            throw new Error('Invalid retained host original');
        }
        return {
            jobId: Boundary.id(value['jobId']),
            sequence,
            dispatchId: ConnectorDeviceCodec.nonce(value['dispatchId']),
            requestHash: ConnectorEnrollmentCodec.digest(value['requestHash']),
        };
    }
    #pending(raw: unknown): ConnectorHostPending {
        const value: Readonly<Record<string, unknown>> = Boundary.record(raw, [
            'jobId',
            'sequence',
            'dispatchId',
            'requestHash',
            'request',
            'response',
        ]);
        const original: ConnectorHostOriginal = this.#original(value);
        const request: ConnectorHostRequest = ConnectorHostCodec.request(value['request']);
        if (
            ConnectorHostProof.digest(ConnectorHostCodec.encode(request)) !== original.requestHash
        ) {
            throw new Error('Retained host request commitment changed');
        }
        return {
            ...original,
            request,
            response:
                value['response'] === null ? null : ConnectorHostCodec.response(value['response']),
        };
    }
    #receipt(raw: unknown): ConnectorHostReceipt {
        const value: Readonly<Record<string, unknown>> = Boundary.record(raw, [
            'jobId',
            'sequence',
            'dispatchId',
            'requestHash',
            'responseHash',
        ]);
        return {
            ...this.#original(value),
            responseHash: ConnectorEnrollmentCodec.digest(value['responseHash']),
        };
    }
}
