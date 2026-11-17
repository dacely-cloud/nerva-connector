// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

import { ConnectorTheme } from './ConnectorTheme.js';

/** One full viewport: every row, top to bottom, and where the terminal cursor belongs afterwards. */
export interface ConnectorScreenFrame {
    /** Each row starts by restoring the page style, so any row can be repainted on its own. */
    readonly rows: readonly string[];
    readonly cursorRow: number;
    readonly cursorColumn: number;
    readonly cursorVisible: boolean;
}

/**
 * Turns successive frames into the smallest terminal update: only rows whose text changed are rewritten.
 *
 * @remarks
 * Clearing and repainting the whole screen on every tick wipes the user's mouse selection, so text on the
 * screen could never be copied. An unchanged frame writes nothing at all; a changed row is rewritten in place
 * and erased to the end of the line in the page background. The whole screen is cleared only on the first
 * paint and after the terminal is resized.
 */
export class ConnectorScreenPainter {
    #rows: readonly string[] | null = null;
    #size: string = '';
    #cursor: string = '';

    /** Forgets what the terminal shows, so the next paint clears and redraws everything. */
    public reset(): void {
        this.#rows = null;
        this.#cursor = '';
    }

    /**
     * The escape output that changes the last painted frame into `frame`.
     *
     * @returns An empty string when nothing visible changed
     */
    public paint(frame: ConnectorScreenFrame, columns: number, rows: number): string {
        const size: string = columns.toString() + 'x' + rows.toString();
        const previous: readonly string[] | null = this.#size === size ? this.#rows : null;
        let output: string =
            previous === null ? ConnectorTheme.reset + ConnectorTheme.background + '\x1b[2J' : '';
        const count: number = Math.max(frame.rows.length, previous?.length ?? 0);
        for (let index: number = 0; index < count; index++) {
            const row: string = frame.rows[index] ?? '';
            if (previous !== null && previous[index] === row) {
                continue;
            }
            output +=
                '\x1b[' +
                (index + 1).toString() +
                ';1H' +
                row +
                ConnectorTheme.reset +
                ConnectorTheme.background +
                '\x1b[K';
        }
        const cursor: string =
            '\x1b[' +
            frame.cursorRow.toString() +
            ';' +
            frame.cursorColumn.toString() +
            'H' +
            (frame.cursorVisible ? '\x1b[?25h' : '\x1b[?25l');
        this.#rows = frame.rows;
        this.#size = size;
        if (output === '' && cursor === this.#cursor) {
            return '';
        }
        this.#cursor = cursor;
        return (output === '' ? '' : '\x1b[?25l' + output) + cursor;
    }
}
