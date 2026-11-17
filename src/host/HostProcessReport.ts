// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

import { Boundary } from 'nerva-connector-protocol/protocol/Boundary.js';

/** Exit observation and optional EOF totals are independent of delivery across the output pipes. */
export interface HostProcessReport {
    readonly exitCode: number | null;
    readonly signal: string | null;
    readonly launchFailed: boolean;
    readonly treeRunning: boolean | null;
    readonly stdoutFinalBytes: bigint | null;
    readonly stderrFinalBytes: bigint | null;
}

/** Exact counters cross private JSON channels as decimal strings. */
export interface HostProcessWireReport {
    readonly exitCode: number | null;
    readonly signal: string | null;
    readonly launchFailed: boolean;
    readonly treeRunning: boolean | null;
    readonly stdoutFinalBytes: string | null;
    readonly stderrFinalBytes: string | null;
}

/** One report decoder serves the POSIX IPC worker and Windows named-pipe broker. */
export class HostProcessReportCodec {
    /** Unknown fields, partial totals and unsafe numeric exits cannot become EOF evidence. */
    public static decode(raw: unknown): HostProcessReport {
        const value: Readonly<Record<string, unknown>> = Boundary.record(raw, [
            'exitCode',
            'signal',
            'launchFailed',
            'treeRunning',
            'stdoutFinalBytes',
            'stderrFinalBytes',
        ]);
        if (
            (value['exitCode'] !== null &&
                (typeof value['exitCode'] !== 'number' ||
                    !Number.isSafeInteger(value['exitCode']))) ||
            (value['signal'] !== null &&
                (typeof value['signal'] !== 'string' || value['signal'].length > 64)) ||
            typeof value['launchFailed'] !== 'boolean' ||
            (value['exitCode'] === null && value['signal'] === null && !value['launchFailed']) ||
            (value['exitCode'] !== null && value['signal'] !== null) ||
            (value['treeRunning'] !== null && typeof value['treeRunning'] !== 'boolean') ||
            (value['stdoutFinalBytes'] === null) !== (value['stderrFinalBytes'] === null)
        ) {
            throw new Error('Invalid host process report');
        }
        return {
            exitCode: value['exitCode'],
            signal: value['signal'],
            launchFailed: value['launchFailed'],
            treeRunning: value['treeRunning'],
            stdoutFinalBytes:
                value['stdoutFinalBytes'] === null
                    ? null
                    : Boundary.integer(value['stdoutFinalBytes']),
            stderrFinalBytes:
                value['stderrFinalBytes'] === null
                    ? null
                    : Boundary.integer(value['stderrFinalBytes']),
        };
    }

    /** Only exact JSON quantities are emitted by trusted workers. */
    public static encode(report: HostProcessReport): HostProcessWireReport {
        return {
            exitCode: report.exitCode,
            signal: report.signal,
            launchFailed: report.launchFailed,
            treeRunning: report.treeRunning,
            stdoutFinalBytes: report.stdoutFinalBytes?.toString() ?? null,
            stderrFinalBytes: report.stderrFinalBytes?.toString() ?? null,
        };
    }
}
