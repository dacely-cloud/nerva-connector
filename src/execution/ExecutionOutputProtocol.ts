// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

import { ExecutionOutputCodec } from './ExecutionOutputCodec.js';
import { Boundary } from 'nerva-connector-protocol/protocol/Boundary.js';
import { ConnectorDeviceCodec } from 'nerva-connector-protocol/protocol/ConnectorDeviceCodec.js';
import { ConnectorEnrollmentCodec } from 'nerva-connector-protocol/protocol/ConnectorEnrollmentCodec.js';
import { IdentityLengths } from 'nerva-connector-protocol/identity/IdentityFormat.js';
import { ExecutionJobsCodec } from './ExecutionJobsCodec.js';
import type {
    ExecutionOutput,
    ExecutionOutputOriginal,
    ExecutionOutputUpdate,
    ExecutionOutputAck,
} from './ExecutionOutput.js';

/** Exact binary-prefix contracts never turn provisional output into successful completion. */
export class ExecutionOutputProtocol {
    /** Canonical base64 and the combined byte bound apply before hashing or comparison. */
    public static bytes(raw: unknown): ExecutionOutput {
        const value: Readonly<Record<string, unknown>> = Boundary.record(raw, [
            'stdoutBase64',
            'stderrBase64',
        ]);
        return ExecutionOutputCodec.output(value);
    }
    /** Full prefixes permit reconnect recovery without an unbounded delta or signature history. */
    public static update(raw: unknown): ExecutionOutputUpdate {
        const value: Readonly<Record<string, unknown>> = Boundary.record(raw, [
            ...this.#fields,
            'output',
            'signature',
        ]);
        const output: ExecutionOutput = this.bytes(value['output']);
        if (output.stdoutBase64 === '' && output.stderrBase64 === '') {
            throw new Error('Empty execution output update');
        }
        return {
            ...this.#original(value),
            output,
            signature: ConnectorEnrollmentCodec.binary(
                value['signature'],
                IdentityLengths.signature,
            ),
        };
    }
    /** Acknowledgments retain the exact prefix commitment and receiver-selected authority. */
    public static ack(raw: unknown): ExecutionOutputAck {
        const value: Readonly<Record<string, unknown>> = Boundary.record(raw, [
            ...this.#fields,
            'authorityId',
            'signature',
        ]);
        return {
            ...this.#original(value),
            authorityId: Boundary.id(value['authorityId']),
            signature: ConnectorEnrollmentCodec.binary(
                value['signature'],
                IdentityLengths.signature,
            ),
        };
    }
    /** Only validated contracts enter this canonical decimal serializer. */
    public static encode(value: ExecutionOutputUpdate | ExecutionOutputAck): string {
        return JSON.stringify(value, (_key: string, entry: unknown): unknown =>
            typeof entry === 'bigint' ? entry.toString() : entry,
        );
    }
    static readonly #fields: readonly string[] = [
        'lane',
        'environmentId',
        'enrollmentId',
        'leaseId',
        'jobId',
        'sequence',
        'dispatchId',
        'requestHash',
        'admissionHash',
        'outputHash',
    ];
    static #original(value: Readonly<Record<string, unknown>>): ExecutionOutputOriginal {
        const sequence: bigint = Boundary.integer(value['sequence']);
        if (sequence === 0n) {
            throw new Error('Invalid execution output sequence');
        }
        return {
            lane: ExecutionJobsCodec.lane(value['lane']),
            environmentId: Boundary.id(value['environmentId']),
            enrollmentId: ConnectorEnrollmentCodec.id(value['enrollmentId']),
            leaseId: ConnectorDeviceCodec.nonce(value['leaseId']),
            jobId: Boundary.id(value['jobId']),
            sequence,
            dispatchId: ConnectorDeviceCodec.nonce(value['dispatchId']),
            requestHash: ConnectorEnrollmentCodec.digest(value['requestHash']),
            admissionHash: ConnectorEnrollmentCodec.digest(value['admissionHash']),
            outputHash: ConnectorEnrollmentCodec.digest(value['outputHash']),
        };
    }
}
