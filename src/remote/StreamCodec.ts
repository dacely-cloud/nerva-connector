// SPDX-FileCopyrightText: 2026 Dacely <business@dacely.com>
// SPDX-License-Identifier: LicenseRef-Proprietary

import { Boundary } from 'nerva-connector-protocol/protocol/Boundary.js';
import {
    StreamChannel,
    StreamTerminal,
    StreamFailure,
    StreamLimits,
    type StreamRecord,
    type StreamBudget,
} from './StreamFormat.js';

/** Bounded output validation treats unknown JSON as data before granting a consumable stream event. */
export class StreamCodec {
    /** Resource policy belongs to the authorized request, not to an output frame. */
    public static budget(value: StreamBudget): StreamBudget {
        if (
            typeof value.maximumBytes !== 'bigint' ||
            value.maximumBytes < 0n ||
            value.maximumBytes > StreamLimits.maximumBytes ||
            typeof value.maximumFrames !== 'bigint' ||
            value.maximumFrames < 1n ||
            value.maximumFrames > StreamLimits.maximumFrames
        ) {
            throw new Error('Unsupported authenticated stream budget');
        }
        return Object.freeze({ ...value });
    }

    /** Only explicit terminal records may carry an exit code or safe failure; output records cannot smuggle terminal state. */
    public static decode(text: string): StreamRecord {
        if (Buffer.byteLength(text) > 32768) {
            throw new Error('Stream payload exceeds its bound');
        }
        const raw: unknown = JSON.parse(text);
        const value: Readonly<Record<string, unknown>> = Boundary.record(raw, [
            'sequence',
            'previousSha256',
            'channel',
            'dataBase64',
            'terminal',
            'exitCode',
            'failure',
        ]);
        const channel: StreamChannel | undefined = Object.values(StreamChannel).find(
            (entry: StreamChannel): boolean => entry.valueOf() === value['channel'],
        );
        const terminal: StreamTerminal | undefined = Object.values(StreamTerminal).find(
            (entry: StreamTerminal): boolean => entry.valueOf() === value['terminal'],
        );
        const failure: StreamFailure | undefined = Object.values(StreamFailure).find(
            (entry: StreamFailure): boolean => entry.valueOf() === value['failure'],
        );
        const exitCode: unknown = value['exitCode'];
        if (
            channel === undefined ||
            typeof value['dataBase64'] !== 'string' ||
            (value['terminal'] !== null && terminal === undefined) ||
            (value['failure'] !== null && failure === undefined) ||
            (exitCode !== null &&
                (typeof exitCode !== 'number' ||
                    !Number.isInteger(exitCode) ||
                    exitCode < 0 ||
                    exitCode > 255))
        ) {
            throw new Error('Invalid authenticated stream record');
        }
        const dataBase64: string = value['dataBase64'];
        this.bytes(dataBase64);
        if (
            channel === StreamChannel.Terminal
                ? dataBase64 !== '' ||
                  terminal === undefined ||
                  (terminal === StreamTerminal.Exited
                      ? exitCode === null || value['failure'] !== null
                      : exitCode !== null || failure === undefined)
                : value['terminal'] !== null || exitCode !== null || value['failure'] !== null
        ) {
            throw new Error('Inconsistent stream terminal state');
        }
        return Object.freeze({
            sequence: Boundary.integer(value['sequence']),
            previousSha256: this.digest(value['previousSha256']),
            channel,
            dataBase64,
            terminal: terminal ?? null,
            exitCode: typeof exitCode === 'number' ? exitCode : null,
            failure: failure ?? null,
        });
    }

    /** Canonical finite base64 is checked before allocation; bytes are opaque binary rather than lossy UTF-8. */
    public static bytes(value: string): Buffer {
        if (
            value.length > Math.ceil(StreamLimits.chunkBytes / 3) * 4 ||
            !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value)
        ) {
            throw new Error('Invalid authenticated stream bytes');
        }
        const bytes: Buffer = Buffer.from(value, 'base64');
        if (bytes.byteLength > StreamLimits.chunkBytes || bytes.toString('base64') !== value) {
            throw new Error('Noncanonical authenticated stream bytes');
        }
        return bytes;
    }

    /** Hashes select exact original requests or preceding accepted frames, never caller-controlled paths. */
    public static digest(raw: unknown): string {
        if (typeof raw !== 'string' || !/^[a-f0-9]{64}$/u.test(raw)) {
            throw new Error('Invalid stream commitment');
        }
        return raw;
    }

    /** Exact sequence quantities remain decimal on the wire. */
    public static encode(value: StreamRecord): string {
        return JSON.stringify(value, (_key: string, entry: unknown): unknown =>
            typeof entry === 'bigint' ? entry.toString() : entry,
        );
    }
}
