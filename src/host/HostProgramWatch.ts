// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

import type { HostReadRevision } from './HostReadRevision.js';

/** What a program owner exposes for its end to be observed without polling. */
export interface HostWatchedProgram {
    readonly id: string;
    /** Advances on every state change of the program, and closes when its owner releases it. */
    readonly changes: HostReadRevision;
    /** The program and every process it started have exited, or its owner can no longer tell. */
    readonly ended: boolean;
}

/**
 * Reports once when a started program ends, from its owner's change notifications.
 *
 * @remarks
 * The connector screen listed a program from its start until a later read happened to see it exit, and Nexa
 * rarely read again, so a program the user had closed, or one its timeout ended, stayed "running" there. The owner
 * already advances its revision on every exit, tree-end, stop and release; this listens to those advances through
 * the owner-side subscription, which takes no native read observer slot, so nothing polls the process. Each check
 * runs in a microtask because an owner advances its revision before it finishes recording the state that changed.
 */
export class HostProgramWatch {
    /**
     * Starts watching one program.
     *
     * @param program - The started program
     * @param ended - Called once with the program's ID when it ends, is released or `signal` aborts
     * @param signal - Aborted when the owning workspace closes
     */
    public static watch(
        program: HostWatchedProgram,
        ended: (processId: string) => void,
        signal: AbortSignal,
    ): void {
        let done: boolean = false;
        let stop: () => void = (): void => undefined;
        const finish: () => void = (): void => {
            if (done) {
                return;
            }
            done = true;
            stop();
            signal.removeEventListener('abort', finish);
            try {
                ended(program.id);
            } catch {
                /** A screen that fails to record the end never affects the program or its owner. */
                return;
            }
        };
        const check: () => void = (): void => {
            queueMicrotask((): void => {
                if (program.changes.closed || program.ended) {
                    finish();
                }
            });
        };
        signal.addEventListener('abort', finish, { once: true });
        stop = program.changes.subscribe(check);
        if (signal.aborted) {
            finish();
        } else {
            check();
        }
    }
}
