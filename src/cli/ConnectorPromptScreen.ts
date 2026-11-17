// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

import type { ConnectorScreenFrame } from './ConnectorScreenPainter.js';
import { ConnectorPromptEditor } from './ConnectorPromptEditor.js';
import { ConnectorCodeBanner } from './ConnectorCodeBanner.js';
import { ConnectorTheme } from './ConnectorTheme.js';
import { ConnectorTerminalText } from './ConnectorTerminalText.js';
import {
    ConnectorLogo,
    type ConnectorLockupLine,
    type ConnectorStyledRow,
} from './ConnectorLogo.js';
import {
    ConnectorPromptLayout,
    ConnectorPromptPriority,
    type ConnectorPromptBlock,
    type ConnectorPromptLine,
} from './ConnectorPromptLayout.js';
import { ConnectorPromptControl } from './ConnectorPromptControl.js';
import {
    ConnectorPromptKind,
    ConnectorPromptTone,
    type ConnectorPromptDetail,
    type ConnectorPromptPanel,
    type ConnectorPromptStatus,
} from './ConnectorPromptTypes.js';

/** A responsive screen keeps the focused control visible and bounds every repaint to one terminal viewport. */
export class ConnectorPromptScreen {
    /** Calm indicator frames for work in progress. */
    public static readonly spinner: readonly string[] = Object.freeze(['◜', '◝', '◞', '◟']);

    /**
     * Geometry changes reflow the same current panel and editor without changing entered values.
     *
     * @param tick - Animation frame for a busy status line
     */
    public static render(
        panel: ConnectorPromptPanel,
        editor: ConnectorPromptEditor | null,
        columns: number,
        rows: number,
        tick: number = 0,
    ): ConnectorScreenFrame {
        const width: number = Math.max(
            1,
            Math.min(Number.isSafeInteger(columns) ? columns : 80, 160) - 1,
        );
        const height: number = Math.max(1, Math.min(Number.isSafeInteger(rows) ? rows : 24, 60));
        if (height < 5 || width < 12) {
            return ConnectorPromptControl.compact(panel, editor, width, height);
        }
        const padding: number = width >= 16 ? 2 : 0;
        const contentWidth: number = Math.max(1, Math.min(width - padding * 2, 96));
        const blocks: ConnectorPromptBlock[] = [];
        this.#brand(blocks, panel, contentWidth);
        ConnectorPromptLayout.spacer(blocks);
        ConnectorPromptLayout.add(
            blocks,
            ConnectorPromptLayout.lines(
                panel.title,
                contentWidth,
                2,
                this.#toneColor(panel.tone, true),
            ),
            ConnectorPromptPriority.Essential,
        );
        panel.description.slice(0, 3).forEach((description: string, index: number): void => {
            ConnectorPromptLayout.add(
                blocks,
                ConnectorPromptLayout.lines(description, contentWidth, 6, ConnectorTheme.text),
                index === 0 ? ConnectorPromptPriority.Lead : ConnectorPromptPriority.Extra,
            );
        });
        const details: readonly ConnectorPromptLine[] = this.#details(panel, contentWidth);
        if (details.length > 0) {
            ConnectorPromptLayout.spacer(blocks);
            ConnectorPromptLayout.add(blocks, details, ConnectorPromptPriority.Details);
        }
        if (panel.link !== undefined) {
            ConnectorPromptLayout.spacer(blocks);
            ConnectorPromptLayout.add(
                blocks,
                ConnectorPromptLayout.lines(panel.link, contentWidth, 3, ConnectorTheme.accent),
                ConnectorPromptPriority.Link,
            );
        }
        if (panel.code !== undefined) {
            ConnectorPromptLayout.spacer(blocks);
            this.#code(blocks, panel.code, contentWidth);
            if (panel.caption !== undefined) {
                ConnectorPromptLayout.add(
                    blocks,
                    ConnectorPromptLayout.lines(
                        panel.caption,
                        contentWidth,
                        1,
                        ConnectorTheme.muted,
                    ),
                    ConnectorPromptPriority.Caption,
                );
            }
        }
        if (panel.status !== undefined) {
            ConnectorPromptLayout.spacer(blocks);
            ConnectorPromptLayout.add(
                blocks,
                this.#status(panel.status, contentWidth, tick),
                ConnectorPromptPriority.Status,
            );
        }
        if (editor !== null) {
            ConnectorPromptControl.append(blocks, editor, contentWidth, Math.max(1, height - 4));
        }
        ConnectorPromptLayout.spacer(blocks);
        ConnectorPromptLayout.add(
            blocks,
            [
                editor?.notice === null || editor?.notice === undefined
                    ? {
                          text: editor?.question.hint ?? panel.hint ?? '',
                          color: ConnectorTheme.muted,
                      }
                    : { text: editor.notice, color: ConnectorTheme.warning },
            ],
            ConnectorPromptPriority.Essential,
        );
        const lines: ConnectorPromptLine[] = [];
        let cursorRow: number = 1;
        let cursorColumn: number = padding + 1;
        for (const block of ConnectorPromptLayout.fit(blocks, height)) {
            if (block.cursorLine !== null && editor !== null) {
                cursorRow = lines.length + block.cursorLine + 1;
                cursorColumn =
                    block.lines.length === 3
                        ? padding +
                          3 +
                          ConnectorPromptControl.field(editor, contentWidth - 4).cursor
                        : padding + 1 + ConnectorPromptControl.field(editor, contentWidth).cursor;
            }
            lines.push(...block.lines);
        }
        return {
            rows: ConnectorPromptLayout.paint(lines.slice(0, height), contentWidth, padding),
            cursorRow: Math.min(height, Math.max(1, cursorRow)),
            cursorColumn: Math.min(width, Math.max(1, cursorColumn)),
            cursorVisible: editor !== null && editor.question.kind === ConnectorPromptKind.Text,
        };
    }

    static #details(panel: ConnectorPromptPanel, width: number): readonly ConnectorPromptLine[] {
        const entries: readonly ConnectorPromptDetail[] = (panel.details ?? []).slice(0, 6);
        const column: number = Math.min(
            Math.floor(width / 3),
            entries.reduce(
                (widest: number, entry: ConnectorPromptDetail): number =>
                    Math.max(
                        widest,
                        ConnectorTerminalText.width(ConnectorTerminalText.safe(entry.label)),
                    ),
                0,
            ) + 3,
        );
        const lines: ConnectorPromptLine[] = [];
        for (const entry of entries) {
            const label: string = ConnectorTerminalText.clip(
                ConnectorTerminalText.safe(entry.label),
                Math.max(0, column - 2),
            );
            ConnectorPromptLayout.lines(
                entry.value,
                Math.max(1, width - column),
                4,
                ConnectorTheme.text,
            ).forEach((line: ConnectorPromptLine, index: number): void => {
                lines.push({
                    ...line,
                    lead: ConnectorTerminalText.pad(index === 0 ? label : '', column),
                });
            });
        }
        return lines;
    }

    /** The logo lockup, falling back to a one-line wordmark when the terminal is short or narrow. */
    static #brand(
        blocks: ConnectorPromptBlock[],
        panel: ConnectorPromptPanel,
        width: number,
    ): void {
        const context: string = panel.context ?? 'Setup';
        const step: string =
            panel.step === undefined
                ? ''
                : 'Step ' + panel.step.current.toString() + ' of ' + panel.step.total.toString();
        const wordmark: ConnectorPromptLine = {
            text: '',
            color: ConnectorTheme.text,
            art: ConnectorLogo.line(
                [
                    { text: ConnectorTheme.product, color: ConnectorTheme.strong },
                    { text: ' / ' + context, color: ConnectorTheme.accentSoft },
                    ...(step === ''
                        ? []
                        : [
                              {
                                  text: ' '.repeat(
                                      Math.max(
                                          2,
                                          width -
                                              ConnectorTerminalText.width(
                                                  ConnectorTheme.product + ' / ' + context,
                                              ) -
                                              ConnectorTerminalText.width(step),
                                      ),
                                  ),
                                  color: ConnectorTheme.text,
                              },
                              { text: step, color: ConnectorTheme.muted },
                          ]),
                ],
                width,
            ),
        };
        const side: ConnectorLockupLine[] = [
            [
                { text: ConnectorTheme.product, color: ConnectorTheme.strong },
                { text: ' / ' + context, color: ConnectorTheme.accentSoft },
            ],
            [],
            [{ text: 'Let Nexa work on this computer.', color: ConnectorTheme.text }],
        ];
        if (panel.step !== undefined) {
            const track: number = 16;
            const filled: number = Math.max(
                1,
                Math.min(track, Math.round((panel.step.current / panel.step.total) * track)),
            );
            side.push([
                { text: '━'.repeat(filled), color: ConnectorTheme.accent },
                { text: '━'.repeat(track - filled), color: ConnectorTheme.faint },
                { text: '  ' + step, color: ConnectorTheme.muted },
            ]);
        }
        const lockup: readonly ConnectorStyledRow[] | null = ConnectorLogo.lockup(side, width);
        if (lockup === null) {
            ConnectorPromptLayout.add(blocks, [wordmark], ConnectorPromptPriority.Header);
            return;
        }
        ConnectorPromptLayout.add(
            blocks,
            lockup.map((row: ConnectorStyledRow): ConnectorPromptLine => ({
                text: '',
                color: ConnectorTheme.text,
                art: row,
            })),
            ConnectorPromptPriority.Logo,
            null,
            { lines: [wordmark], priority: ConnectorPromptPriority.Header, cursorLine: null },
        );
    }

    static #code(blocks: ConnectorPromptBlock[], code: string, width: number): void {
        const safe: string = ConnectorTerminalText.safe(code);
        const compact: ConnectorPromptLine = {
            text: Array.from(safe).join(' '),
            color: ConnectorTheme.accentStrong,
        };
        const banner: readonly string[] | null = ConnectorCodeBanner.render(safe, width);
        if (banner === null) {
            ConnectorPromptLayout.add(blocks, [compact], ConnectorPromptPriority.Status);
            return;
        }
        ConnectorPromptLayout.add(
            blocks,
            banner.map((row: string): ConnectorPromptLine => ({
                text: row,
                color: ConnectorTheme.accent,
            })),
            ConnectorPromptPriority.Banner,
            null,
            { lines: [compact], priority: ConnectorPromptPriority.Status, cursorLine: null },
        );
    }

    static #status(
        status: ConnectorPromptStatus,
        width: number,
        tick: number,
    ): readonly ConnectorPromptLine[] {
        const glyph: string = status.busy
            ? (this.spinner[Math.abs(Math.trunc(tick)) % this.spinner.length] ?? '•')
            : status.tone === ConnectorPromptTone.Success
              ? '✓'
              : status.tone === ConnectorPromptTone.Error
                ? '✕'
                : status.tone === ConnectorPromptTone.Warning
                  ? '!'
                  : '•';
        return ConnectorPromptLayout.lines(
            glyph + '  ' + status.text,
            width,
            5,
            this.#toneColor(status.tone, false),
        );
    }

    static #toneColor(tone: ConnectorPromptTone | undefined, title: boolean): string {
        return tone === ConnectorPromptTone.Success
            ? ConnectorTheme.success
            : tone === ConnectorPromptTone.Warning
              ? ConnectorTheme.warning
              : tone === ConnectorPromptTone.Error
                ? ConnectorTheme.error
                : title
                  ? ConnectorTheme.strong
                  : ConnectorTheme.text;
    }
}
