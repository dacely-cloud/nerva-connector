// SPDX-FileCopyrightText: 2026 Dacely <business@dacely.com>
// SPDX-License-Identifier: LicenseRef-Proprietary

import type {
    HostProcessRequest,
    HostProcessFailure,
    HostProcessOutput,
} from './HostWorkspaceTypes.js';

/** A real terminal uses explicit initial geometry and the existing reviewed launch contract. */
export interface HostTerminalRequest extends HostProcessRequest {
    readonly cols: number;
    readonly rows: number;
}

/** Root exit, actual tree evidence and fully received terminal EOF remain independent. */
export interface HostTerminalSnapshot {
    readonly processId: string;
    readonly running: boolean;
    readonly treeRunning: boolean | null;
    /** Last acknowledged native geometry; an uncertain resize never invents a confirmed size. */
    readonly cols: number;
    readonly rows: number;
    readonly outputComplete: boolean;
    readonly finalOutputBytes: bigint | null;
    readonly exitCode: number | null;
    readonly signal: string | null;
    readonly failure: HostProcessFailure | null;
    readonly output: HostProcessOutput;
}

/** Only these private controls may alter an already owned terminal. */
export const HostTerminalControlKind = { Resize: 'resize', Stop: 'stop' } as const;
/** Control values derive from the runtime mapping. */
export type HostTerminalControlKind =
    (typeof HostTerminalControlKind)[keyof typeof HostTerminalControlKind];
/** A finite private control retains its original geometry through a late acknowledgment. */
export interface HostTerminalControl {
    readonly operation: HostTerminalControlKind;
    readonly id: bigint;
    readonly cols: number | null;
    readonly rows: number | null;
}

/** One owner bounds private requests and transport allocation independently from program output volume. */
export class HostTerminalLimits {
    public static readonly readyMs: number = 15000;
    public static readonly inputMs: number = 10000;
    public static readonly controlMs: number = 10000;
    public static readonly stopMs: number = 30000;
    public static readonly controls: bigint = 4096n;
    public static readonly pendingControls: number = 16;
}
