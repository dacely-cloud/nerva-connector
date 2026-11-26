// SPDX-FileCopyrightText: 2026 Dacely <business@dacely.com>
// SPDX-License-Identifier: LicenseRef-Proprietary

import { Boundary } from 'nerva-connector-protocol/protocol/Boundary.js';

/** Private native messages are independent from raw stdin and raw merged terminal stdout. */
export const HostTerminalReportKind = {
    Hello: 'hello',
    Ready: 'ready',
    Input: 'input',
    State: 'state',
    Control: 'control',
} as const;
/** A Windows peer proves its private token before the controller returns the start capability. */
export interface HostTerminalHelloReport {
    readonly kind: typeof HostTerminalReportKind.Hello;
}
/** Initial readiness is emitted only after actual native user-process creation. */
export interface HostTerminalReadyReport {
    readonly kind: typeof HostTerminalReportKind.Ready;
    readonly cols: number;
    readonly rows: number;
}
/** Cumulative bytes are acknowledged only after reaching the native terminal input descriptor. */
export interface HostTerminalInputReport {
    readonly kind: typeof HostTerminalReportKind.Input;
    readonly acceptedBytes: bigint;
}
/** An exact native EOF commitment may arrive before its bytes reach the Node output ring. */
export interface HostTerminalStateReport {
    readonly kind: typeof HostTerminalReportKind.State;
    readonly running: boolean;
    readonly treeRunning: boolean | null;
    readonly exitCode: number | null;
    readonly signal: string | null;
    readonly outputComplete: boolean;
    readonly outputFinalBytes: bigint | null;
}
/** A negative acknowledgment proves no complete resize/shutdown success. */
export interface HostTerminalControlReport {
    readonly kind: typeof HostTerminalReportKind.Control;
    readonly id: bigint;
    readonly ok: boolean;
}
/** Every native variant is validated before entering the owner. */
export type HostTerminalReport =
    | HostTerminalHelloReport
    | HostTerminalReadyReport
    | HostTerminalInputReport
    | HostTerminalStateReport
    | HostTerminalControlReport;

/** One strict decoder serves Linux descriptor3 and the Windows authenticated local pipe. */
export class HostTerminalReportCodec {
    public static decode(raw: unknown, token: string): HostTerminalReport {
        const envelope: Readonly<Record<string, unknown>> = Boundary.record(raw, [
            'token',
            'kind',
            'cols',
            'rows',
            'acceptedBytes',
            'running',
            'treeRunning',
            'exitCode',
            'signal',
            'outputComplete',
            'outputFinalBytes',
            'id',
            'ok',
        ]);
        if (envelope['token'] !== token) {
            throw new Error('Terminal channel token changed');
        }
        switch (envelope['kind']) {
            case HostTerminalReportKind.Hello:
                Boundary.record(raw, ['token', 'kind']);
                return { kind: HostTerminalReportKind.Hello };
            case HostTerminalReportKind.Ready: {
                const value: Readonly<Record<string, unknown>> = Boundary.record(raw, [
                    'token',
                    'kind',
                    'cols',
                    'rows',
                ]);
                const cols: number = Boundary.count(value['cols'], 500);
                const rows: number = Boundary.count(value['rows'], 200);
                if (cols < 2 || rows < 1) {
                    throw new Error('Invalid terminal geometry');
                }
                return { kind: HostTerminalReportKind.Ready, cols, rows };
            }
            case HostTerminalReportKind.Input:
                Boundary.record(raw, ['token', 'kind', 'acceptedBytes']);
                return {
                    kind: HostTerminalReportKind.Input,
                    acceptedBytes: Boundary.integer(envelope['acceptedBytes']),
                };
            case HostTerminalReportKind.Control: {
                Boundary.record(raw, ['token', 'kind', 'id', 'ok']);
                const id: bigint = Boundary.integer(envelope['id']);
                if (id < 1n) {
                    throw new Error('Invalid terminal control ID');
                }
                return {
                    kind: HostTerminalReportKind.Control,
                    id,
                    ok: Boundary.boolean(envelope['ok']),
                };
            }
            case HostTerminalReportKind.State: {
                Boundary.record(raw, [
                    'token',
                    'kind',
                    'running',
                    'treeRunning',
                    'exitCode',
                    'signal',
                    'outputComplete',
                    'outputFinalBytes',
                ]);
                const running: boolean = Boundary.boolean(envelope['running']);
                const treeRunning: boolean | null =
                    envelope['treeRunning'] === null
                        ? null
                        : Boundary.boolean(envelope['treeRunning']);
                const exitCode: number | null =
                    envelope['exitCode'] === null
                        ? null
                        : Boundary.count(envelope['exitCode'], 4294967295);
                const signal: unknown = envelope['signal'];
                const outputComplete: boolean = Boundary.boolean(envelope['outputComplete']);
                const outputFinalBytes: bigint | null =
                    envelope['outputFinalBytes'] === null
                        ? null
                        : Boundary.integer(envelope['outputFinalBytes']);
                if (
                    (signal !== null &&
                        (typeof signal !== 'string' ||
                            !/^(?:SIG[A-Z0-9]+|UNKNOWN)$/u.test(signal) ||
                            signal.length > 64)) ||
                    (running && (exitCode !== null || signal !== null)) ||
                    (!running && (exitCode === null) === (signal === null)) ||
                    (treeRunning === false && running) ||
                    outputComplete !== (outputFinalBytes !== null)
                ) {
                    throw new Error('Invalid terminal native state');
                }
                return {
                    kind: HostTerminalReportKind.State,
                    running,
                    treeRunning,
                    exitCode,
                    signal,
                    outputComplete,
                    outputFinalBytes,
                };
            }
            default:
                throw new Error('Unknown terminal native report');
        }
    }
}
