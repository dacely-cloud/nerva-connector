// SPDX-FileCopyrightText: 2026 Dacely <business@dacely.com>
// SPDX-License-Identifier: LicenseRef-Proprietary

import { ConnectorTheme } from './ConnectorTheme.js';
import { ConnectorTerminalText } from './ConnectorTerminalText.js';
import type { ConnectorStyledRow } from './ConnectorLogo.js';

/** Display rows retain styling separately from sanitized terminal-cell content. */
export interface ConnectorPromptLine {
    readonly text: string;
    readonly color: string;
    /** Rows that paint their full width, such as the focused choice. */
    readonly fill?: boolean;
    /** Muted text aligned to the right edge when it fits. */
    readonly aside?: string;
    /** Muted label column printed before `text`. */
    readonly lead?: string;
    /** A trusted pre-painted row, such as the logo lockup, shown instead of `text`. */
    readonly art?: ConnectorStyledRow;
}

/** A smaller replacement used before a block is removed entirely. */
export interface ConnectorPromptFallback {
    readonly lines: readonly ConnectorPromptLine[];
    readonly priority: number;
    readonly cursorLine: number | null;
}

/** One layout section; when space runs out the least important sections shrink or disappear first. */
export interface ConnectorPromptBlock {
    readonly lines: readonly ConnectorPromptLine[];
    readonly priority: number;
    readonly cursorLine: number | null;
    readonly fallback: ConnectorPromptFallback | null;
}

/** Layout priorities: zero is never dropped; larger numbers go first when the terminal is short. */
export const ConnectorPromptPriority = {
    Essential: 0,
    Header: 1,
    Status: 2,
    Link: 3,
    Lead: 4,
    ChoiceDetail: 5,
    Details: 6,
    Banner: 7,
    Caption: 8,
    Extra: 9,
    Logo: 10,
    Rule: 12,
    Spacing: 20,
} as const;

/** Builds, fits and paints prioritized blocks of rows inside one terminal viewport. */
export class ConnectorPromptLayout {
    /** Appends a block unless it is empty. */
    public static add(
        blocks: ConnectorPromptBlock[],
        lines: readonly ConnectorPromptLine[],
        priority: number,
        cursorLine: number | null = null,
        fallback: ConnectorPromptFallback | null = null,
    ): void {
        if (lines.length > 0) {
            blocks.push({ lines, priority, cursorLine, fallback });
        }
    }

    /** Appends one blank row that is the first thing to go when space runs out. */
    public static spacer(blocks: ConnectorPromptBlock[]): void {
        this.add(
            blocks,
            [{ text: '', color: ConnectorTheme.text }],
            ConnectorPromptPriority.Spacing,
        );
    }

    /** Wraps text into colored rows. */
    public static lines(
        value: string,
        width: number,
        maximum: number,
        color: string,
    ): readonly ConnectorPromptLine[] {
        return ConnectorTerminalText.wrap(value, width, maximum).map(
            (text: string): ConnectorPromptLine => ({ text, color }),
        );
    }

    /** Shrinks or drops the least important blocks until the rows fit `height`. */
    public static fit(
        blocks: readonly ConnectorPromptBlock[],
        height: number,
    ): readonly ConnectorPromptBlock[] {
        const remaining: ConnectorPromptBlock[] = [...blocks];
        let total: number = remaining.reduce(
            (sum: number, block: ConnectorPromptBlock): number => sum + block.lines.length,
            0,
        );
        while (total > height) {
            let index: number = -1;
            let priority: number = ConnectorPromptPriority.Essential;
            remaining.forEach((block: ConnectorPromptBlock, candidate: number): void => {
                if (
                    block.priority > ConnectorPromptPriority.Essential &&
                    block.priority >= priority
                ) {
                    index = candidate;
                    priority = block.priority;
                }
            });
            const victim: ConnectorPromptBlock | undefined = remaining[index];
            if (victim === undefined) {
                break;
            }
            total -= victim.lines.length;
            if (victim.fallback === null) {
                remaining.splice(index, 1);
            } else {
                remaining[index] = { ...victim.fallback, fallback: null };
                total += victim.fallback.lines.length;
            }
        }
        return remaining;
    }

    /** Paints rows; each one restores the page style first, so it can be repainted on its own. */
    public static paint(
        lines: readonly ConnectorPromptLine[],
        width: number,
        padding: number,
    ): readonly string[] {
        return lines.map((line: ConnectorPromptLine): string => this.#line(line, width, padding));
    }

    static #line(line: ConnectorPromptLine, width: number, padding: number): string {
        const base: string = ConnectorTheme.reset + ConnectorTheme.background;
        if (line.art !== undefined) {
            return base + ' '.repeat(padding) + line.art.ansi;
        }
        const lead: string =
            line.lead === undefined
                ? ''
                : ConnectorTerminalText.clip(ConnectorTerminalText.safe(line.lead), width);
        if (lead !== '') {
            return (
                base +
                ' '.repeat(padding) +
                ConnectorTheme.muted +
                lead +
                line.color +
                ConnectorTerminalText.clip(
                    ConnectorTerminalText.safe(line.text),
                    Math.max(0, width - ConnectorTerminalText.width(lead)),
                )
            );
        }
        const clipped: string = ConnectorTerminalText.clip(
            ConnectorTerminalText.safe(line.text),
            width,
        );
        const aside: string =
            line.aside === undefined ? '' : ConnectorTerminalText.safe(line.aside);
        const gap: number =
            width - ConnectorTerminalText.width(clipped) - ConnectorTerminalText.width(aside);
        return (
            base +
            ' '.repeat(padding) +
            line.color +
            (aside !== '' && gap >= 2
                ? clipped +
                  ' '.repeat(gap) +
                  ConnectorTheme.reset +
                  ConnectorTheme.background +
                  ConnectorTheme.muted +
                  aside
                : line.fill === true
                  ? ConnectorTerminalText.pad(clipped, width)
                  : clipped)
        );
    }
}
