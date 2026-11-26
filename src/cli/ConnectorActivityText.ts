// SPDX-FileCopyrightText: 2026 Dacely <business@dacely.com>
// SPDX-License-Identifier: LicenseRef-Proprietary

import {
    ConnectorActivityState,
    type ConnectorActivityEntry,
    type ConnectorActivityProgram,
} from '../runtime/ConnectorActivity.js';
import { ConnectorTheme } from './ConnectorTheme.js';
import { ConnectorTerminalText } from './ConnectorTerminalText.js';
import {
    ConnectorLogo,
    type ConnectorLockupLine,
    type ConnectorLockupText,
    type ConnectorStyledRow,
} from './ConnectorLogo.js';

/**
 * Plain wording and word-wrapped cards for activity lists.
 *
 * @remarks
 * Each card reads like a sentence, as in Nerva Code's action cards: a status mark, what is happening in bold,
 * the complete path or command line, then who did it and when. Long text wraps under the title instead of being
 * cut short. Times of finished work move in whole minutes, so finished cards stay still and can be selected.
 */
export class ConnectorActivityText {
    /** Calm progress frames for requests in progress. */
    public static readonly spinner: readonly string[] = Object.freeze(['◜', '◝', '◞', '◟']);
    /** Continuation rows start under the title, past the status mark. */
    static readonly #indent: number = 2;

    /** A compact elapsed time such as "12s", "3m" or "2h". */
    public static elapsed(milliseconds: number): string {
        const seconds: number = Math.max(0, Math.floor(milliseconds / 1000));
        if (seconds < 60) {
            return seconds.toString() + 's';
        }
        const minutes: number = Math.floor(seconds / 60);
        if (minutes < 60) {
            return minutes.toString() + 'm';
        }
        const hours: number = Math.floor(minutes / 60);
        return hours < 48 ? hours.toString() + 'h' : Math.floor(hours / 24).toString() + 'd';
    }

    /** How long ago something happened in whole minutes: "just now", "5m ago", "2h ago". */
    public static ago(milliseconds: number): string {
        return milliseconds < 60000 ? 'just now' : this.elapsed(milliseconds) + ' ago';
    }

    /** "Agent 1"; agents are numbered in the order they first used this computer. */
    public static agent(agent: number): string {
        return 'Agent ' + agent.toString();
    }

    /**
     * One request as a card of one or more rows.
     *
     * @param now - Wall-clock milliseconds
     * @param tick - Spinner frame for requests in progress
     */
    public static entry(
        entry: ConnectorActivityEntry,
        width: number,
        now: number,
        tick: number,
    ): readonly ConnectorStyledRow[] {
        const running: boolean = entry.state === ConnectorActivityState.Running;
        const failed: boolean = entry.state === ConnectorActivityState.Failed;
        const unconfirmed: boolean = entry.state === ConnectorActivityState.Unconfirmed;
        const mark: ConnectorLockupText = running
            ? {
                  text: this.spinner[Math.abs(Math.trunc(tick)) % this.spinner.length] ?? '•',
                  color: ConnectorTheme.accent,
              }
            : failed
              ? { text: '✕', color: ConnectorTheme.error }
              : unconfirmed
                ? { text: '?', color: ConnectorTheme.warning }
                : { text: '✓', color: ConnectorTheme.success };
        const time: ConnectorLockupText = running
            ? { text: this.elapsed(now - entry.startedAtMs), color: ConnectorTheme.dim }
            : failed
              ? { text: 'failed', color: ConnectorTheme.error }
              : unconfirmed
                ? { text: 'unconfirmed', color: ConnectorTheme.warning }
                : {
                      text: this.ago(now - (entry.endedAtMs ?? entry.startedAtMs)),
                      color: ConnectorTheme.dim,
                  };
        return this.#card(mark, entry.title, entry.subject, entry.agent, time, width);
    }

    /** One background program or terminal as a card of one or more rows. */
    public static program(
        program: ConnectorActivityProgram,
        width: number,
        now: number,
    ): readonly ConnectorStyledRow[] {
        return this.#card(
            { text: '▸', color: ConnectorTheme.accent },
            program.terminal ? 'Terminal' : 'Program',
            program.subject,
            program.agent,
            { text: 'started ' + this.ago(now - program.startedAtMs), color: ConnectorTheme.dim },
            width,
        );
    }

    static #card(
        mark: ConnectorLockupText,
        title: string,
        subject: string,
        agent: number,
        time: ConnectorLockupText,
        width: number,
    ): readonly ConnectorStyledRow[] {
        return this.#wrap(
            [
                mark,
                { text: ' ' + title, color: ConnectorTheme.strong },
                ...(subject === '' ? [] : [{ text: '  ' + subject, color: ConnectorTheme.text }]),
                { text: '  ' + this.agent(agent), color: ConnectorTheme.agent },
                { text: ' · ', color: ConnectorTheme.faint },
                time,
            ],
            width,
        );
    }

    /**
     * Word-wraps colored runs into rows of at most `width` cells.
     *
     * @remarks
     * Words move whole to the next row; a word longer than a row, such as a long path, is split where the row
     * ends. Continuation rows are indented under the title, and spaces at the ends of rows are dropped.
     */
    static #wrap(runs: ConnectorLockupLine, width: number): readonly ConnectorStyledRow[] {
        const rows: ConnectorLockupText[][] = [[]];
        let used: number = 0;
        const room: (row: number) => number = (row: number): number =>
            Math.max(1, row === 0 ? width : width - this.#indent);
        const next: () => void = (): void => {
            rows.push([]);
            used = 0;
        };
        for (const run of runs) {
            for (const token of ConnectorTerminalText.safe(run.text).split(/( +)/u)) {
                let rest: string = token;
                while (rest !== '') {
                    const row: ConnectorLockupText[] = rows[rows.length - 1] ?? [];
                    const left: number = room(rows.length - 1) - used;
                    const cells: number = ConnectorTerminalText.width(rest);
                    if (rest.startsWith(' ')) {
                        if (used > 0 && cells <= left) {
                            row.push({ text: rest, color: run.color });
                            used += cells;
                        }
                        break;
                    }
                    if (cells <= left) {
                        row.push({ text: rest, color: run.color });
                        used += cells;
                        break;
                    }
                    if (used > 0 && cells <= room(rows.length)) {
                        next();
                        continue;
                    }
                    const head: string =
                        ConnectorTerminalText.clip(rest, left) || (Array.from(rest)[0] ?? '');
                    row.push({ text: head, color: run.color });
                    rest = rest.slice(head.length);
                    next();
                }
            }
        }
        return rows
            .map((row: ConnectorLockupText[]): ConnectorLockupText[] => {
                while ((row[row.length - 1]?.text ?? 'x').trim() === '') {
                    row.pop();
                }
                return row;
            })
            .filter((row: readonly ConnectorLockupText[]): boolean => row.length > 0)
            .map((row: readonly ConnectorLockupText[], index: number): ConnectorStyledRow =>
                ConnectorLogo.line(
                    index === 0
                        ? row
                        : [{ text: ' '.repeat(this.#indent), color: ConnectorTheme.text }, ...row],
                    width,
                ),
            );
    }
}
