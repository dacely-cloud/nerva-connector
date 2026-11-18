// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

import { createHash } from 'node:crypto';
import { ExecutionMachineBoundary as Data } from 'nerva-connector-protocol/execution/ExecutionMachineBoundary.js';
import { ExecutionInputCodec } from 'nerva-connector-protocol/execution/ExecutionInputCodec.js';
import {
    ExecutionNativePipeCommandKind,
    ExecutionNativePipeEventKind,
    ExecutionNativePipeLimits as Limits,
    type ExecutionNativePipeCommand,
    type ExecutionNativePipeControl,
    type ExecutionNativePipeCapturedCommand,
    type ExecutionNativePipeEvent,
} from './ExecutionNativePipeProtocol.js';

/** This strict local FFI grammar supplies no remote authorization; the signed operation owner remains responsible for it. */
export class ExecutionNativePipeCodec {
    /** Commands retain exact small decimal quantities and canonical binary bytes. */
    public static command(raw: unknown): ExecutionNativePipeCommand {
        const kind: unknown = this.#kind(raw);
        const fields: readonly string[] = [
            'kind',
            'incarnation',
            'inputSequence',
            'offset',
            'inputHash',
            'deliveryExpiresAtMs',
        ];
        const value: Readonly<Record<string, unknown>> = Data.record(
            raw,
            kind === ExecutionNativePipeCommandKind.Data
                ? [...fields, 'dataHash', 'byteLength', 'dataBase64']
                : fields,
        );
        const common: ExecutionNativePipeControl = {
            incarnation: ExecutionInputCodec.digest(value['incarnation']),
            inputSequence: this.#quantity(value['inputSequence'], Limits.controls - 1n),
            offset: this.#quantity(value['offset'], Limits.totalBytes),
            inputHash: ExecutionInputCodec.digest(value['inputHash']),
            deliveryExpiresAtMs: this.#expiry(value['deliveryExpiresAtMs']),
        };
        if (kind === ExecutionNativePipeCommandKind.End) {
            if (common.inputSequence === 0n) {
                throw new Error('Initial native Pipe control must be explicit data');
            }
            return Object.freeze({ kind, ...common });
        }
        if (
            kind !== ExecutionNativePipeCommandKind.Data ||
            typeof value['dataBase64'] !== 'string'
        ) {
            throw new Error('Explicit native Pipe data or EOF required');
        }
        const bytes: Buffer = this.bytes(value['dataBase64']);
        const digest: string = ExecutionInputCodec.digest(value['dataHash']);
        if (
            createHash('sha256').update(bytes).digest('hex') !== digest ||
            this.#quantity(value['byteLength'], BigInt(Limits.frameBytes)) !==
                BigInt(bytes.byteLength) ||
            common.offset + BigInt(bytes.byteLength) > Limits.totalBytes ||
            (bytes.byteLength === 0 && common.inputSequence !== 0n)
        ) {
            throw new Error('Native Pipe data commitment or range changed');
        }
        return Object.freeze({
            kind,
            ...common,
            dataHash: digest,
            byteLength: this.#quantity(value['byteLength'], BigInt(Limits.frameBytes)),
            dataBase64: value['dataBase64'],
        });
    }

    /** Only a closed native Ready or exact acceptance receipt is accepted from the separate broker descriptor. */
    public static event(raw: unknown): ExecutionNativePipeEvent {
        const kind: unknown = this.#kind(raw);
        const value: Readonly<Record<string, unknown>> = Data.record(
            raw,
            kind === ExecutionNativePipeEventKind.Ready
                ? ['kind', 'incarnation', 'initialInputBytes', 'initialInputHash']
                : kind === ExecutionNativePipeEventKind.TimedOut
                  ? ['kind', 'incarnation']
                  : kind === ExecutionNativePipeEventKind.Expired
                    ? ['kind', 'incarnation', 'inputSequence', 'inputHash', 'confirmedOffset']
                    : [
                          'kind',
                          'incarnation',
                          'inputSequence',
                          'inputHash',
                          'acceptedOffset',
                          'ended',
                      ],
        );
        const incarnation: string = ExecutionInputCodec.digest(value['incarnation']);
        if (kind === ExecutionNativePipeEventKind.Ready) {
            return Object.freeze({
                kind,
                incarnation,
                initialInputBytes: Data.count(value['initialInputBytes'], 0, 1024),
                initialInputHash: ExecutionInputCodec.digest(value['initialInputHash']),
            });
        }
        if (kind === ExecutionNativePipeEventKind.TimedOut) {
            return Object.freeze({ kind, incarnation });
        }
        if (kind === ExecutionNativePipeEventKind.Expired) {
            return Object.freeze({
                kind,
                incarnation,
                inputSequence: this.#quantity(value['inputSequence'], Limits.controls - 1n),
                inputHash: ExecutionInputCodec.digest(value['inputHash']),
                confirmedOffset: this.#quantity(value['confirmedOffset'], Limits.totalBytes),
            });
        }
        if (kind !== ExecutionNativePipeEventKind.Applied || typeof value['ended'] !== 'boolean') {
            throw new Error('Explicit native Pipe event required');
        }
        return Object.freeze({
            kind,
            incarnation,
            inputSequence: this.#quantity(value['inputSequence'], Limits.controls - 1n),
            inputHash: ExecutionInputCodec.digest(value['inputHash']),
            acceptedOffset: this.#quantity(value['acceptedOffset'], Limits.totalBytes),
            ended: value['ended'],
        });
    }

    /** Base64 is finite and canonical before decoding; input remains opaque binary. */
    public static bytes(raw: string): Buffer {
        if (
            raw.length > Math.ceil(Limits.frameBytes / 3) * 4 ||
            !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(raw)
        ) {
            throw new Error('Invalid native Pipe data bytes');
        }
        const bytes: Buffer = Buffer.from(raw, 'base64');
        if (bytes.byteLength > Limits.frameBytes || bytes.toString('base64') !== raw) {
            throw new Error('Noncanonical native Pipe bytes');
        }
        return bytes;
    }

    /** The local protocol encodes quantities as decimal strings, with one finite JSON frame per line. */
    public static encode(command: ExecutionNativePipeCommand): string {
        return this.capture(command).encoded;
    }

    /** Detach, validate and encode once; local callers need not reparse and rehash their own canonical serialization. */
    public static capture(command: ExecutionNativePipeCommand): ExecutionNativePipeCapturedCommand {
        const kind: unknown = this.#kind(command);
        const fields: readonly string[] = [
            'kind',
            'incarnation',
            'inputSequence',
            'offset',
            'inputHash',
            'deliveryExpiresAtMs',
            ...(kind === ExecutionNativePipeCommandKind.Data
                ? ['dataHash', 'byteLength', 'dataBase64']
                : []),
        ];
        const source: Readonly<Record<string, unknown>> = Data.record(command, fields);
        const wire: Record<string, string> = {};
        for (const field of fields) {
            const value: unknown = source[field];
            if (
                field === 'inputSequence' ||
                field === 'offset' ||
                field === 'byteLength' ||
                field === 'deliveryExpiresAtMs'
            ) {
                if (typeof value !== 'bigint') {
                    throw new Error('Typed native Pipe quantity required');
                }
                wire[field] = value.toString();
            } else {
                if (typeof value !== 'string') {
                    throw new Error('Typed native Pipe text required');
                }
                wire[field] = value;
            }
        }
        const detached: ExecutionNativePipeCommand = this.command(wire);
        const json: string = JSON.stringify(detached, (_key: string, value: unknown): unknown =>
            typeof value === 'bigint' ? value.toString() : value,
        );
        if (Buffer.byteLength(json) > Limits.encodedCommandBytes) {
            throw new Error('Native Pipe command exceeds its bound');
        }

        return Object.freeze({
            command: detached,
            encoded: json + '\n',
            identity: JSON.stringify(detached, (key: string, value: unknown): unknown =>
                key === 'deliveryExpiresAtMs'
                    ? undefined
                    : typeof value === 'bigint'
                      ? value.toString()
                      : value,
            ),
        });
    }

    static #expiry(raw: unknown): bigint {
        const value: bigint = this.#quantity(raw, 9223372036854775807n);
        if (value === 0n) {
            throw new Error('Positive native Pipe delivery expiry required');
        }
        return value;
    }

    static #quantity(raw: unknown, maximum: bigint): bigint {
        if (typeof raw !== 'string' || !/^(0|[1-9][0-9]{0,19})$/u.test(raw)) {
            throw new Error('Exact native Pipe quantity required');
        }
        const value: bigint = BigInt(raw);
        if (value > maximum) {
            throw new Error('Native Pipe quantity exceeds its bound');
        }
        return value;
    }

    static #kind(raw: unknown): unknown {
        if (typeof raw !== 'object' || raw === null) {
            throw new Error('Native Pipe record required');
        }
        const descriptor: PropertyDescriptor | undefined = Object.getOwnPropertyDescriptor(
            raw,
            'kind',
        );
        if (descriptor === undefined || !Object.hasOwn(descriptor, 'value')) {
            throw new Error('Native Pipe discriminant must be data');
        }
        const kind: unknown = descriptor.value;
        return kind;
    }
}
