// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

import { ConnectorColor, ConnectorTheme, type ConnectorRgb } from './ConnectorTheme.js';
import { ConnectorTerminalText } from './ConnectorTerminalText.js';

/** One colored run of plain text beside the logo; the text is sanitized before painting. */
export interface ConnectorLockupText {
    readonly text: string;
    /** A trusted `ConnectorTheme` style. */
    readonly color: string;
}

/** One row beside the logo, made of colored runs. */
export type ConnectorLockupLine = readonly ConnectorLockupText[];

/** A row already painted with trusted escape sequences, and the terminal cells it occupies. */
export interface ConnectorStyledRow {
    readonly ansi: string;
    readonly width: number;
}

/**
 * The Nerva emblem in terminal half blocks, and the brand lockup that places text to its right.
 *
 * @remarks
 * The pixels are the same 16 by 16 sample of the Nerva UI's folded orange mark that Nerva Code
 * draws. Two vertical pixels share one terminal cell, so the emblem is 16 columns by 8 rows and
 * needs only 24-bit color, no image protocol. Transparent pixels show the page background.
 */
export class ConnectorLogo {
    /** Emblem width in terminal columns. */
    public static readonly width: number = 16;
    /** Emblem height in terminal rows. */
    public static readonly height: number = 8;
    /** Columns between the emblem and the text beside it. */
    public static readonly gap: number = 3;
    /** The narrowest text column worth showing beside the emblem. */
    public static readonly minimumText: number = 18;

    static readonly #colors: ReadonlyMap<string, ConnectorRgb> = new Map<string, ConnectorRgb>([
        ['0', [160, 49, 2]],
        ['1', [193, 66, 0]],
        ['2', [216, 79, 0]],
        ['3', [245, 97, 1]],
        ['4', [250, 122, 16]],
        ['5', [254, 137, 25]],
    ]);

    static readonly #pixels: readonly string[] = [
        '333            3',
        '3333          33',
        '33334        333',
        '333344      4433',
        '33344444    4544',
        '102344554   4455',
        '2112345554  3444',
        '32113334554 3344',
        '3322  3334442133',
        '3332   333332013',
        '3333    33333302',
        '3333     3333332',
        '333       333333',
        '333        33333',
        '33          3333',
        '3             33',
    ];

    static readonly #rows: readonly string[] = ConnectorLogo.#paint();

    /** The emblem's painted rows, each exactly `width` cells, ending on the page style. */
    public static rows(): readonly string[] {
        return this.#rows;
    }

    /**
     * The emblem with `side` vertically centered to its right, or `null` when `width` is too narrow.
     *
     * @param width - Available terminal columns
     */
    public static lockup(
        side: readonly ConnectorLockupLine[],
        width: number,
    ): readonly ConnectorStyledRow[] | null {
        const textWidth: number = width - this.width - this.gap;
        if (textWidth < this.minimumText) {
            return null;
        }
        const lines: readonly ConnectorLockupLine[] = side.slice(0, this.height);
        const top: number = Math.floor((this.height - lines.length) / 2);
        return this.#rows.map((emblem: string, row: number): ConnectorStyledRow => {
            const line: ConnectorLockupLine = lines[row - top] ?? [];
            const text: ConnectorStyledRow = this.line(line, textWidth);
            return {
                ansi: emblem + ' '.repeat(this.gap) + text.ansi,
                width: this.width + this.gap + text.width,
            };
        });
    }

    /** One line of colored runs, sanitized and clipped to `width` cells. */
    public static line(line: ConnectorLockupLine, width: number): ConnectorStyledRow {
        let ansi: string = '';
        let used: number = 0;
        for (const run of line) {
            const text: string = ConnectorTerminalText.clip(
                ConnectorTerminalText.safe(run.text),
                Math.max(0, width - used),
            );
            if (text === '') {
                continue;
            }
            ansi += ConnectorTheme.reset + ConnectorTheme.background + run.color + text;
            used += ConnectorTerminalText.width(text);
        }
        return {
            ansi: ansi + ConnectorTheme.reset + ConnectorTheme.background,
            width: used,
        };
    }

    static #paint(): readonly string[] {
        const rows: string[] = [];
        for (let pair: number = 0; pair < this.#pixels.length; pair += 2) {
            const upper: string = this.#pixels[pair] ?? '';
            const lower: string = this.#pixels[pair + 1] ?? '';
            let row: string = '';
            for (let column: number = 0; column < this.width; column++) {
                row += this.#cell(
                    this.#colors.get(upper[column] ?? ' '),
                    this.#colors.get(lower[column] ?? ' '),
                );
            }
            rows.push(row + ConnectorTheme.reset + ConnectorTheme.background);
        }
        return rows;
    }

    static #cell(top: ConnectorRgb | undefined, bottom: ConnectorRgb | undefined): string {
        const page: string = ConnectorTheme.backgroundOf(ConnectorColor.Background);
        if (top === undefined && bottom === undefined) {
            return page + ' ';
        }
        if (top === undefined && bottom !== undefined) {
            return page + ConnectorTheme.foregroundOf(bottom) + '▄';
        }
        if (top !== undefined && bottom === undefined) {
            return page + ConnectorTheme.foregroundOf(top) + '▀';
        }
        return (
            ConnectorTheme.backgroundOf(bottom ?? ConnectorColor.Background) +
            ConnectorTheme.foregroundOf(top ?? ConnectorColor.Background) +
            '▀'
        );
    }
}
