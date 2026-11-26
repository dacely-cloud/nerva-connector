// SPDX-FileCopyrightText: 2026 Dacely <business@dacely.com>
// SPDX-License-Identifier: LicenseRef-Proprietary

import type { HostTerminalStateReport } from './HostTerminalReport.js';

/** Required state corroborates a matched shutdown acknowledgment; Windows additionally requires actual Job zero. */
export class HostTerminalStopProof {
    /** POSIX null accompanies the caller's matched stop ACK and grants no complete tree-containment guarantee. */
    public static known(
        state: HostTerminalStateReport | null,
        platform: NodeJS.Platform = process.platform,
    ): boolean {
        return (
            state !== null &&
            !state.running &&
            state.outputComplete &&
            state.outputFinalBytes !== null &&
            (platform !== 'win32' || state.treeRunning === false)
        );
    }

    public static require(state: HostTerminalStateReport | null): void {
        if (!this.known(state)) {
            throw new Error('Terminal stop lacks exact native shutdown evidence');
        }
    }
}
