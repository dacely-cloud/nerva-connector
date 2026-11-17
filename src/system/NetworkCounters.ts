// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { win32 } from 'node:path';

/** Cumulative bytes moved over the computer's external interfaces since an unspecified start. */
export interface NetworkTotals {
    readonly receivedBytes: bigint;
    readonly transmittedBytes: bigint;
    /** The operating system counts in 32 bits, so a smaller later total can mean one wraparound. */
    readonly wraps32: boolean;
}

/** Raw bytes are decoded strictly after the finite native child exits. */
interface NetstatOutput {
    readonly stdout: Buffer;
    readonly stderr: Buffer;
}

/** Reads interface byte counters from the operating system without a shell. */
export class NetworkCounters {
    /** Returns null on platforms with no supported counter source. */
    public static async read(signal: AbortSignal): Promise<NetworkTotals | null> {
        signal.throwIfAborted();
        if (process.platform === 'linux') {
            const text: string = await readFile('/proc/net/dev', { encoding: 'utf8', signal });
            return this.parseLinux(text);
        }
        if (process.platform === 'win32') {
            const root: string | undefined = process.env['SystemRoot'];
            if (root === undefined || !/^[A-Za-z]:\\/u.test(root) || win32.resolve(root) !== root) {
                return null;
            }
            const result: NetstatOutput = await promisify(execFile)(
                win32.join(root, 'System32', 'NETSTAT.EXE'),
                ['-e'],
                {
                    signal,
                    timeout: 2000,
                    killSignal: 'SIGKILL',
                    maxBuffer: 16384,
                    encoding: 'buffer',
                    windowsHide: true,
                    env: { SystemRoot: root },
                },
            );
            return this.parseWindows(new TextDecoder('utf-8').decode(result.stdout));
        }
        return null;
    }

    /** Sums every interface except loopback from the kernel's `/proc/net/dev` table. */
    public static parseLinux(text: string): NetworkTotals {
        if (text.length > 1048576) {
            throw new Error('Network counters exceed their byte limit');
        }
        let received: bigint = 0n;
        let transmitted: bigint = 0n;
        for (const line of text.split('\n').slice(2)) {
            const separator: number = line.indexOf(':');
            if (separator < 0) {
                continue;
            }
            const name: string = line.slice(0, separator).trim();
            const fields: readonly string[] = line
                .slice(separator + 1)
                .trim()
                .split(/\s+/u);
            const receive: string | undefined = fields[0];
            const transmit: string | undefined = fields[8];
            if (
                receive === undefined ||
                transmit === undefined ||
                !/^[0-9]{1,20}$/u.test(receive) ||
                !/^[0-9]{1,20}$/u.test(transmit)
            ) {
                throw new Error('Invalid network counter record');
            }
            if (name === 'lo') {
                continue;
            }
            received += BigInt(receive);
            transmitted += BigInt(transmit);
        }
        return Object.freeze({
            receivedBytes: received,
            transmittedBytes: transmitted,
            wraps32: false,
        });
    }

    /**
     * Reads the first counter row of `netstat -e`, which is the byte totals.
     *
     * @remarks
     * Row labels are localized, so the row is found by shape: a label followed by exactly two
     * integers. Thousands separators are not used by this command.
     */
    public static parseWindows(text: string): NetworkTotals {
        if (text.length > 16384) {
            throw new Error('Network counters exceed their byte limit');
        }
        for (const line of text.split(/\r?\n/u)) {
            const match: RegExpExecArray | null =
                /^\S.*?\s+([0-9]{1,20})\s+([0-9]{1,20})\s*$/u.exec(line);
            if (match?.[1] !== undefined && match[2] !== undefined) {
                return Object.freeze({
                    receivedBytes: BigInt(match[1]),
                    transmittedBytes: BigInt(match[2]),
                    wraps32: true,
                });
            }
        }
        throw new Error('Network byte counters were not reported');
    }
}
