// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

import type {
    ConnectorActivityEntry,
    ConnectorActivityProgram,
    ConnectorActivitySnapshot,
} from '../runtime/ConnectorActivity.js';
import { ConnectorActivityText } from './ConnectorActivityText.js';
import {
    ConnectorConsolePhase,
    type ConnectorConsoleCommand,
    type ConnectorConsoleModel,
} from './ConnectorConsoleModel.js';
import {
    ConnectorLogo,
    type ConnectorLockupLine,
    type ConnectorStyledRow,
} from './ConnectorLogo.js';
import { ConnectorTerminalText } from './ConnectorTerminalText.js';
import { ConnectorTheme } from './ConnectorTheme.js';
import type { ConnectorScreenFrame } from './ConnectorScreenPainter.js';

/** The two console views: a calm summary, and the full list of what happened. */
export const ConnectorConsoleView = {
    Home: 'home',
    Activity: 'activity',
} as const;
/** Views derive from their runtime mapping. */
export type ConnectorConsoleView = (typeof ConnectorConsoleView)[keyof typeof ConnectorConsoleView];

/** A menu row: the command and what it does, in plain words. */
export interface ConnectorConsoleChoice {
    readonly command: ConnectorConsoleCommand;
    readonly description: string;
}

/** The editable prompt's current text, cursor and highlighted menu row. */
export interface ConnectorConsoleInput {
    readonly text: string;
    readonly cursor: number;
    readonly selected: number;
}

/** Everything one repaint shows; built from public state only, never keys, proofs or raw requests. */
export interface ConnectorConsoleScreenState {
    readonly model: ConnectorConsoleModel;
    readonly activity: ConnectorActivitySnapshot;
    readonly view: ConnectorConsoleView;
    /** First history row shown in the activity view. */
    readonly scroll: number;
    readonly input: ConnectorConsoleInput;
    /** Menu rows matching the input, already filtered by availability. */
    readonly choices: readonly ConnectorConsoleChoice[];
    /** Spinner frame. */
    readonly tick: number;
}

/** One complete viewport, plus how far the activity history can scroll. */
export interface ConnectorConsoleFrame extends ConnectorScreenFrame {
    /** The furthest first history row the activity view can show; 0 when everything fits. */
    readonly scrollLimit: number;
    /** The clamped position after a resize or a change in history. */
    readonly scroll: number;
    /** The number of history rows visible in one page. */
    readonly scrollPage: number;
}

/** The rows above the prompt and the history scroll limit they imply. */
interface ConnectorConsoleBody {
    readonly lines: ConnectorStyledRow[];
    readonly scrollLimit: number;
    readonly scroll: number;
    readonly scrollPage: number;
}

/** Rows taken from a list of cards, and how many cards they show. */
interface ConnectorConsoleCards {
    readonly rows: readonly ConnectorStyledRow[];
    readonly count: number;
}

/** Renders the console into exactly one terminal viewport. */
export class ConnectorConsoleScreen {
    static readonly #padding: number = 2;

    /**
     * Builds one repaint.
     *
     * @param now - Wall-clock milliseconds for activity times
     * @param monotonic - `performance.now()` for the retry countdown
     */
    public static frame(
        state: ConnectorConsoleScreenState,
        columns: number,
        rows: number,
        now: number,
        monotonic: number,
    ): ConnectorConsoleFrame {
        const width: number = Math.max(
            8,
            Math.min(Number.isSafeInteger(columns) && columns > 0 ? columns : 80, 140) -
                this.#padding * 2 -
                1,
        );
        const height: number = Math.max(6, Number.isSafeInteger(rows) && rows > 0 ? rows : 24);
        const footer: ConnectorStyledRow[] = this.#footer(state, width, height);
        const budget: number = height - footer.length;
        const body: ConnectorConsoleBody =
            state.view === ConnectorConsoleView.Activity
                ? this.#activityView(state, width, budget, now)
                : {
                      lines: this.#home(state, width, budget, now, monotonic),
                      scrollLimit: 0,
                      scroll: 0,
                      scrollPage: 0,
                  };
        const shown: ConnectorStyledRow[] = body.lines.slice(0, Math.max(0, budget));
        while (shown.length < budget) {
            shown.push(this.#blank());
        }
        const lines: readonly ConnectorStyledRow[] = [...shown, ...footer];
        const promptRow: number = shown.length + 2;
        return {
            rows: lines.map(
                (line: ConnectorStyledRow): string =>
                    ConnectorTheme.reset +
                    ConnectorTheme.background +
                    ' '.repeat(this.#padding) +
                    line.ansi,
            ),
            cursorRow: promptRow,
            cursorColumn:
                this.#padding +
                3 +
                ConnectorTerminalText.width(
                    ConnectorTerminalText.safe(
                        Array.from(state.input.text).slice(0, state.input.cursor).join(''),
                    ),
                ),
            cursorVisible: true,
            scrollLimit: body.scrollLimit,
            scroll: body.scroll,
            scrollPage: body.scrollPage,
        };
    }

    static #home(
        state: ConnectorConsoleScreenState,
        width: number,
        budget: number,
        now: number,
        monotonic: number,
    ): ConnectorStyledRow[] {
        const model: ConnectorConsoleModel = state.model;
        const lines: ConnectorStyledRow[] = [];
        const status: readonly string[] = ConnectorTerminalText.wrap(
            model.status(monotonic),
            Math.max(8, width - ConnectorLogo.width - ConnectorLogo.gap),
            ConnectorLogo.height - 3,
        );
        const side: ConnectorLockupLine[] = [
            this.#wordmark(model.computer),
            [],
            [
                {
                    text: '● ' + model.phase,
                    color: '\x1b[1m' + this.#phaseColor(model.phase),
                },
            ],
            ...status.map((row: string): ConnectorLockupLine => [
                { text: row, color: ConnectorTheme.muted },
            ]),
        ];
        const lockup: readonly ConnectorStyledRow[] | null =
            budget >= 16 ? ConnectorLogo.lockup(side, width) : null;
        if (lockup === null) {
            lines.push(ConnectorLogo.line(this.#wordmark(model.computer), width));
            lines.push(this.#blank());
            lines.push(ConnectorLogo.line(side[2] ?? [], width));
            for (const row of status) {
                lines.push(ConnectorLogo.line([{ text: row, color: ConnectorTheme.muted }], width));
            }
        } else {
            lines.push(this.#blank(), ...lockup);
        }
        if (model.retryAt === null && model.activity !== '') {
            for (const row of ConnectorTerminalText.wrap(model.activity, width, 3)) {
                lines.push(ConnectorLogo.line([{ text: row, color: ConnectorTheme.dim }], width));
            }
        }
        lines.push(this.#blank());
        lines.push(this.#access(model, width));
        if (model.details.length > 0) {
            lines.push(this.#blank());
            let remaining: number = 6;
            for (const detail of model.details.slice(0, 6)) {
                for (const row of ConnectorTerminalText.wrap(detail, width - 2, remaining)) {
                    lines.push(
                        ConnectorLogo.line(
                            [
                                { text: '│ ', color: ConnectorTheme.accentDim },
                                { text: row, color: ConnectorTheme.text },
                            ],
                            width,
                        ),
                    );
                    remaining -= 1;
                }
                if (remaining <= 0) {
                    break;
                }
            }
        }
        const activity: ConnectorActivitySnapshot = state.activity;
        const quiet: boolean =
            activity.running.length === 0 &&
            activity.programs.length === 0 &&
            activity.recent.length === 0;
        if (model.phase !== ConnectorConsolePhase.Connected && quiet) {
            return lines;
        }
        const room: number = budget - lines.length;
        if (room < 4) {
            return lines;
        }
        const programs: number = Math.min(activity.programs.length, 3);
        lines.push(this.#blank());
        lines.push(
            this.#heading(
                'Right now',
                activity.running.length === 0 ? '' : this.#agents(activity.running) + ' working',
                width,
            ),
        );
        if (activity.running.length === 0) {
            lines.push(
                ConnectorLogo.line(
                    [
                        {
                            text: 'Nothing is running. When Nexa uses this computer, you will see it here.',
                            color: ConnectorTheme.dim,
                        },
                    ],
                    width,
                ),
            );
        }
        lines.push(
            ...this.#take(
                activity.running.map(
                    (entry: ConnectorActivityEntry): readonly ConnectorStyledRow[] =>
                        ConnectorActivityText.entry(entry, width, now, state.tick),
                ),
                Math.max(1, budget - lines.length - (programs > 0 ? 3 : 0) - 3),
            ).rows,
        );
        if (programs > 0 && budget - lines.length >= 3) {
            const shown: ConnectorConsoleCards = this.#take(
                activity.programs
                    .slice(0, programs)
                    .map((program: ConnectorActivityProgram): readonly ConnectorStyledRow[] =>
                        ConnectorActivityText.program(program, width, now),
                    ),
                budget - lines.length - 2,
            );
            lines.push(this.#blank());
            lines.push(
                this.#heading(
                    'Programs running',
                    activity.programs.length > shown.count
                        ? '+' + (activity.programs.length - shown.count).toString() + ' more'
                        : '',
                    width,
                ),
            );
            lines.push(...shown.rows);
        }
        const left: number = budget - lines.length - 2;
        if (activity.recent.length > 0 && left >= 1) {
            lines.push(this.#blank());
            lines.push(this.#heading('Recent', 'Tab to browse history', width));
            lines.push(
                ...this.#take(
                    activity.recent
                        .slice(0, 8)
                        .map((entry: ConnectorActivityEntry): readonly ConnectorStyledRow[] =>
                            ConnectorActivityText.entry(entry, width, now, state.tick),
                        ),
                    left,
                ).rows,
            );
        }
        return lines;
    }

    static #activityView(
        state: ConnectorConsoleScreenState,
        width: number,
        budget: number,
        now: number,
    ): ConnectorConsoleBody {
        const activity: ConnectorActivitySnapshot = state.activity;
        const lines: ConnectorStyledRow[] = [
            this.#split(
                [
                    { text: ConnectorTheme.product, color: ConnectorTheme.strong },
                    { text: ' / Activity', color: ConnectorTheme.accentSoft },
                ],
                activity.total === 1
                    ? '1 request so far'
                    : activity.total.toString() + ' requests so far',
                width,
            ),
        ];
        const liveRoom: number = Math.max(0, Math.floor((budget - 5) / 2));
        if (liveRoom > 0 && activity.running.length > 0) {
            lines.push(
                this.#heading('Right now', this.#agents(activity.running) + ' working', width),
                ...this.#take(
                    activity.running.map(
                        (entry: ConnectorActivityEntry): readonly ConnectorStyledRow[] =>
                            ConnectorActivityText.entry(entry, width, now, state.tick),
                    ),
                    liveRoom - 1,
                ).rows,
            );
        }
        if (liveRoom > 0 && activity.programs.length > 0) {
            lines.push(this.#heading('Programs running', '', width));
            lines.push(
                ...this.#take(
                    activity.programs.map(
                        (program: ConnectorActivityProgram): readonly ConnectorStyledRow[] =>
                            ConnectorActivityText.program(program, width, now),
                    ),
                    liveRoom - 1,
                ).rows,
            );
        }
        const scrollPage: number = Math.max(1, budget - lines.length - 1);
        const history: readonly ConnectorStyledRow[] = activity.recent.flatMap(
            (entry: ConnectorActivityEntry): readonly ConnectorStyledRow[] =>
                ConnectorActivityText.entry(entry, width, now, state.tick),
        );
        const scrollLimit: number = Math.max(0, history.length - scrollPage);
        const scroll: number = Math.max(0, Math.min(state.scroll, scrollLimit));
        const end: number = Math.min(history.length, scroll + scrollPage);
        lines.push(
            this.#heading(
                'History',
                scrollLimit === 0
                    ? ''
                    : (scroll + 1).toString() +
                          '–' +
                          end.toString() +
                          ' of ' +
                          history.length.toString() +
                          ' lines',
                width,
            ),
        );
        if (activity.recent.length === 0) {
            lines.push(
                ConnectorLogo.line(
                    [
                        {
                            text: 'Nothing yet. Everything Nexa does on this computer will be listed here.',
                            color: ConnectorTheme.dim,
                        },
                    ],
                    width,
                ),
            );
        }
        lines.push(...history.slice(scroll, end));
        return { lines, scrollLimit, scroll, scrollPage };
    }

    /**
     * Whole cards, in order, while they fit in `limit` rows.
     *
     * @remarks
     * When even the first card is taller than the space, its first rows are shown so the newest item is
     * never hidden entirely.
     */
    static #take(
        cards: readonly (readonly ConnectorStyledRow[])[],
        limit: number,
    ): ConnectorConsoleCards {
        const rows: ConnectorStyledRow[] = [];
        let count: number = 0;
        for (const card of cards) {
            if (rows.length + card.length > limit) {
                if (count === 0 && limit > 0) {
                    rows.push(...card.slice(0, limit));
                    count = 1;
                }
                break;
            }
            rows.push(...card);
            count += 1;
        }
        return { rows, count };
    }

    /** The rule, the prompt, the matching menu rows and the key hints, in that order. */
    static #footer(
        state: ConnectorConsoleScreenState,
        width: number,
        height: number,
    ): ConnectorStyledRow[] {
        const lines: ConnectorStyledRow[] = [
            ConnectorLogo.line([{ text: '─'.repeat(width), color: ConnectorTheme.faint }], width),
            ConnectorLogo.line(
                [
                    { text: '› ', color: ConnectorTheme.accent },
                    { text: state.input.text, color: ConnectorTheme.text },
                ],
                width,
            ),
        ];
        const limit: number =
            state.view === ConnectorConsoleView.Activity
                ? Math.max(0, height - 6)
                : state.choices.length;
        const first: number = Math.max(0, state.input.selected - limit + 1);
        state.choices
            .slice(first, first + limit)
            .forEach((choice: ConnectorConsoleChoice, index: number): void => {
                const focused: boolean = first + index === state.input.selected;
                lines.push(
                    ConnectorLogo.line(
                        [
                            {
                                text: (focused ? '› /' : '  /') + choice.command.padEnd(15),
                                color: focused ? ConnectorTheme.selected : ConnectorTheme.text,
                            },
                            {
                                text: choice.description,
                                color: focused ? ConnectorTheme.text : ConnectorTheme.muted,
                            },
                        ],
                        width,
                    ),
                );
            });
        lines.push(
            ConnectorLogo.line(
                [
                    {
                        text:
                            state.choices.length > 0
                                ? '↑↓ choose · Enter run · Tab complete · Esc close'
                                : state.view === ConnectorConsoleView.Activity
                                  ? '↑↓ / PgUp PgDn scroll · Home/End · Tab or Esc back'
                                  : '/ menu · Tab activity history · Ctrl+C quit',
                        color: ConnectorTheme.dim,
                    },
                ],
                width,
            ),
        );
        return lines;
    }

    static #wordmark(computer: string): ConnectorLockupLine {
        return [
            { text: ConnectorTheme.product, color: ConnectorTheme.strong },
            { text: ' / ' + computer, color: ConnectorTheme.accentSoft },
        ];
    }

    static #access(model: ConnectorConsoleModel, width: number): ConnectorStyledRow {
        const level: string = model.host
            ? 'Full computer'
            : model.execution
              ? 'One folder and its commands'
              : model.files
                ? 'One folder'
                : 'Just connected';
        const folder: string =
            model.folder === null || (!model.host && !model.files) ? '' : ' · ' + model.folder;
        return ConnectorLogo.line(
            [
                { text: 'Nexa can use  ', color: ConnectorTheme.muted },
                { text: level, color: ConnectorTheme.text },
                { text: folder, color: ConnectorTheme.muted },
            ],
            width,
        );
    }

    static #agents(entries: readonly ConnectorActivityEntry[]): string {
        const count: number = new Set(
            entries.map((entry: ConnectorActivityEntry): number => entry.agent),
        ).size;
        return count === 1 ? '1 agent' : count.toString() + ' agents';
    }

    static #heading(title: string, aside: string, width: number): ConnectorStyledRow {
        return this.#split([{ text: title, color: ConnectorTheme.accentSoft }], aside, width);
    }

    static #split(left: ConnectorLockupLine, aside: string, width: number): ConnectorStyledRow {
        const start: ConnectorStyledRow = ConnectorLogo.line(left, width);
        const safe: string = ConnectorTerminalText.safe(aside);
        const gap: number = width - start.width - ConnectorTerminalText.width(safe);
        if (safe === '' || gap < 2) {
            return start;
        }
        const end: ConnectorStyledRow = ConnectorLogo.line(
            [
                { text: ' '.repeat(gap), color: ConnectorTheme.text },
                { text: safe, color: ConnectorTheme.dim },
            ],
            width - start.width,
        );
        return { ansi: start.ansi + end.ansi, width: start.width + end.width };
    }

    static #blank(): ConnectorStyledRow {
        return { ansi: '', width: 0 };
    }

    static #phaseColor(phase: ConnectorConsolePhase): string {
        return phase === ConnectorConsolePhase.Connected
            ? ConnectorTheme.success
            : phase === ConnectorConsolePhase.Unavailable
              ? ConnectorTheme.error
              : phase === ConnectorConsolePhase.NotLinked
                ? ConnectorTheme.warning
                : phase === ConnectorConsolePhase.Stopped
                  ? ConnectorTheme.muted
                  : ConnectorTheme.accent;
    }
}
