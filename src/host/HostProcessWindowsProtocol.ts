// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

import { Boundary } from 'nerva-connector-protocol/protocol/Boundary.js';
import { HostProcessReportCodec, type HostProcessReport } from './HostProcessReport.js';
import { ConnectorHostErrorCode } from 'nerva-connector-protocol/protocol/ConnectorHost.js';

/** Control readiness, lifecycle evidence and failed shutdown remain distinct private messages. */
export const HostProcessWindowsFrameKind = {
    Ready: 'ready',
    Started: 'started',
    LaunchRejected: 'launch-rejected',
    Report: 'report',
    StopFailed: 'stop-failed',
} as const;
/** An authenticated broker can request creation only after the parent acknowledges this readiness frame. */
export interface HostProcessWindowsReadyFrame {
    readonly kind: typeof HostProcessWindowsFrameKind.Ready;
}
/** Actual native creation is independent from authenticated broker readiness. */
export interface HostProcessWindowsStartedFrame {
    readonly kind: typeof HostProcessWindowsFrameKind.Started;
}
/** Only a verified empty job with no created root may emit this pre-effect rejection. */
export interface HostProcessWindowsRejectedFrame {
    readonly kind: typeof HostProcessWindowsFrameKind.LaunchRejected;
    readonly errorCode: ConnectorHostErrorCode;
    readonly nativeError: number | null;
}
/** A root exit can arrive while the job still contains GUI descendants. */
export interface HostProcessWindowsReportFrame {
    readonly kind: typeof HostProcessWindowsFrameKind.Report;
    readonly report: HostProcessReport;
}
/** A failed stop contains no fabricated job-empty acknowledgment. */
export interface HostProcessWindowsStopFailedFrame {
    readonly kind: typeof HostProcessWindowsFrameKind.StopFailed;
}
/** Exact private frame variants have independent authority and lifecycle meanings. */
export type HostProcessWindowsFrame =
    | HostProcessWindowsReadyFrame
    | HostProcessWindowsStartedFrame
    | HostProcessWindowsRejectedFrame
    | HostProcessWindowsReportFrame
    | HostProcessWindowsStopFailedFrame;

/** Named-pipe input remains untrusted until its token and complete bounded message shape agree. */
export class HostProcessWindowsProtocol {
    /** Unknown fields, unauthenticated reports and missing tree evidence cannot reach the process owner. */
    public static decode(raw: unknown, token: string): HostProcessWindowsFrame {
        const frame: Readonly<Record<string, unknown>> = Boundary.record(raw, [
            'token',
            'kind',
            'errorCode',
            'nativeError',
            'exitCode',
            'signal',
            'launchFailed',
            'treeRunning',
            'stdoutFinalBytes',
            'stderrFinalBytes',
        ]);
        if (frame['token'] !== token) {
            throw new Error('Invalid Windows host process token');
        }
        if (
            frame['kind'] === HostProcessWindowsFrameKind.Ready ||
            frame['kind'] === HostProcessWindowsFrameKind.Started ||
            frame['kind'] === HostProcessWindowsFrameKind.StopFailed
        ) {
            Boundary.record(raw, ['token', 'kind']);
            return { kind: frame['kind'] };
        }
        if (frame['kind'] === HostProcessWindowsFrameKind.LaunchRejected) {
            Boundary.record(raw, ['token', 'kind', 'errorCode', 'nativeError']);
            const errorCode: ConnectorHostErrorCode | undefined = [
                ConnectorHostErrorCode.NotFound,
                ConnectorHostErrorCode.PermissionDenied,
                ConnectorHostErrorCode.ResourceLimit,
                ConnectorHostErrorCode.Unsupported,
                ConnectorHostErrorCode.InvalidRequest,
                ConnectorHostErrorCode.NotDirectory,
                ConnectorHostErrorCode.Canceled,
                ConnectorHostErrorCode.OperationFailed,
            ].find((code: ConnectorHostErrorCode): boolean => code === frame['errorCode']);
            const nativeError: unknown = frame['nativeError'];
            if (
                errorCode === undefined ||
                (nativeError !== null &&
                    (typeof nativeError !== 'number' ||
                        !Number.isSafeInteger(nativeError) ||
                        nativeError < 0 ||
                        nativeError > 4294967295))
            ) {
                throw new Error('Invalid Windows launch rejection');
            }
            return { kind: HostProcessWindowsFrameKind.LaunchRejected, errorCode, nativeError };
        }
        if (frame['kind'] !== HostProcessWindowsFrameKind.Report) {
            throw new Error('Invalid Windows host report kind');
        }
        return {
            kind: HostProcessWindowsFrameKind.Report,
            report: HostProcessReportCodec.decode({
                exitCode: frame['exitCode'],
                signal: frame['signal'],
                launchFailed: frame['launchFailed'],
                treeRunning: frame['treeRunning'],
                stdoutFinalBytes: frame['stdoutFinalBytes'],
                stderrFinalBytes: frame['stderrFinalBytes'],
            }),
        };
    }
}
