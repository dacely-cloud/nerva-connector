// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

import type { ConnectorScreenFrame } from './ConnectorScreenPainter.js';
import { ConnectorPromptEditor } from './ConnectorPromptEditor.js';
import { ConnectorTheme } from './ConnectorTheme.js';
import { ConnectorTerminalText } from './ConnectorTerminalText.js';
import {
    ConnectorPromptLayout,
    ConnectorPromptPriority,
    type ConnectorPromptBlock,
    type ConnectorPromptLine,
} from './ConnectorPromptLayout.js';
import {
    ConnectorPromptKind,
    type ConnectorPromptChoice,
    type ConnectorPromptPanel,
    type ConnectorPromptQuestion,
} from './ConnectorPromptTypes.js';

/** Horizontal scrolling preserves a visible cursor without placing a partial wide glyph beyond its field. */
export interface ConnectorPromptField {
    readonly text: string;
    readonly cursor: number;
}

/** Renders the focused control and the tiny-terminal fallback frame. */
export class ConnectorPromptControl {
    /** Appends the focused control: choices, a button, or a boxed text field. Waiting shows nothing. */
    public static append(
        blocks: ConnectorPromptBlock[],
        editor: ConnectorPromptEditor,
        width: number,
        visibleChoices: number,
    ): void {
        const question: ConnectorPromptQuestion = editor.question;
        if (question.kind === ConnectorPromptKind.Wait) {
            return;
        }
        ConnectorPromptLayout.spacer(blocks);
        if (question.kind === ConnectorPromptKind.Select) {
            const count: number = Math.min(question.choices.length, visibleChoices);
            const start: number = Math.max(
                0,
                Math.min(editor.selected - Math.floor(count / 2), question.choices.length - count),
            );
            ConnectorPromptLayout.add(
                blocks,
                question.choices
                    .slice(start, start + count)
                    .map((choice: ConnectorPromptChoice, offset: number): ConnectorPromptLine => {
                        const focused: boolean = start + offset === editor.selected;
                        return {
                            text:
                                (focused ? '› ' : '  ') +
                                (start + offset + 1).toString() +
                                '. ' +
                                choice.label,
                            color: focused ? ConnectorTheme.selected : ConnectorTheme.text,
                            ...(choice.badge === undefined ? {} : { aside: choice.badge }),
                        };
                    }),
                ConnectorPromptPriority.Essential,
            );
            const focused: ConnectorPromptChoice | undefined = question.choices[editor.selected];
            if (focused !== undefined) {
                ConnectorPromptLayout.spacer(blocks);
                ConnectorPromptLayout.add(
                    blocks,
                    ConnectorPromptLayout.lines(
                        focused.description,
                        Math.max(1, width - 5),
                        6,
                        focused.caution === true ? ConnectorTheme.warning : ConnectorTheme.muted,
                    ).map((line: ConnectorPromptLine): ConnectorPromptLine => ({
                        ...line,
                        lead: '     ',
                    })),
                    ConnectorPromptPriority.ChoiceDetail,
                );
            }
            return;
        }
        if (question.kind === ConnectorPromptKind.Confirm) {
            ConnectorPromptLayout.add(
                blocks,
                [{ text: '› ' + question.label, color: ConnectorTheme.selected }],
                ConnectorPromptPriority.Essential,
            );
            return;
        }
        const single: ConnectorPromptLine = {
            text: this.field(editor, width).text,
            color: ConnectorTheme.text,
        };
        if (width < 12) {
            ConnectorPromptLayout.add(blocks, [single], ConnectorPromptPriority.Essential, 0);
            return;
        }
        const field: ConnectorPromptField = this.field(editor, width - 4);
        const caption: string = ConnectorTerminalText.clip(
            ConnectorTerminalText.safe(question.label),
            Math.max(0, width - 6),
        );
        ConnectorPromptLayout.add(
            blocks,
            [
                {
                    text:
                        '╭─ ' +
                        caption +
                        ' ' +
                        '─'.repeat(Math.max(0, width - 5 - ConnectorTerminalText.width(caption))) +
                        '╮',
                    color: ConnectorTheme.accent,
                },
                {
                    text: '│ ' + ConnectorTerminalText.pad(field.text, width - 4) + ' │',
                    color: ConnectorTheme.text,
                },
                { text: '╰' + '─'.repeat(width - 2) + '╯', color: ConnectorTheme.accent },
            ],
            ConnectorPromptPriority.Link,
            1,
            { lines: [single], priority: ConnectorPromptPriority.Essential, cursorLine: 0 },
        );
    }

    /** A minimal frame for terminals too small for the full layout. */
    public static compact(
        panel: ConnectorPromptPanel,
        editor: ConnectorPromptEditor | null,
        width: number,
        height: number,
    ): ConnectorScreenFrame {
        const question: ConnectorPromptQuestion | null = editor?.question ?? null;
        const field: ConnectorPromptField | null =
            editor !== null && question?.kind === ConnectorPromptKind.Text
                ? this.field(editor, width)
                : null;
        const value: string =
            field !== null
                ? field.text
                : question?.kind === ConnectorPromptKind.Select
                  ? (question.choices[editor?.selected ?? 0]?.label ?? '')
                  : question?.kind === ConnectorPromptKind.Confirm
                    ? '› ' + question.label
                    : (panel.code ?? panel.status?.text ?? panel.description[0] ?? '');
        const title: string =
            question?.kind === ConnectorPromptKind.Text ||
            question?.kind === ConnectorPromptKind.Select
                ? question.label
                : panel.title;
        const lines: string[] = height === 1 ? [value] : [title, value];
        if (height >= 3) {
            lines.push(question?.hint ?? panel.hint ?? '');
        }
        return {
            rows: lines
                .slice(0, height)
                .map(
                    (line: string, index: number): string =>
                        ConnectorTheme.reset +
                        ConnectorTheme.background +
                        (index === 0 && height > 1
                            ? ConnectorTheme.accent
                            : index === 2
                              ? ConnectorTheme.muted
                              : ConnectorTheme.text) +
                        ConnectorTerminalText.clip(ConnectorTerminalText.safe(line), width),
                ),
            cursorRow: height === 1 ? 1 : 2,
            cursorColumn: Math.min(width, (field?.cursor ?? 0) + 1),
            cursorVisible: field !== null,
        };
    }

    /** The visible slice of a text field and its cursor position, scrolling to keep the cursor in view. */
    public static field(editor: ConnectorPromptEditor, width: number): ConnectorPromptField {
        const characters: string[] = Array.from(editor.value);
        let start: number = Math.max(0, editor.cursor - width + 1);
        let prefix: string = ConnectorTerminalText.safe(
            characters.slice(start, editor.cursor).join(''),
        );
        while (
            ConnectorTerminalText.width(prefix) >=
                Math.max(1, width - (start > 0 && width > 1 ? 1 : 0)) &&
            start < editor.cursor
        ) {
            prefix = ConnectorTerminalText.safe(characters.slice(++start, editor.cursor).join(''));
        }
        const marker: string = start > 0 && width > 1 ? '‹' : '';
        return {
            text:
                marker +
                ConnectorTerminalText.clip(
                    ConnectorTerminalText.safe(characters.slice(start).join('')),
                    width - marker.length,
                ),
            cursor: marker.length + ConnectorTerminalText.width(prefix),
        };
    }
}
