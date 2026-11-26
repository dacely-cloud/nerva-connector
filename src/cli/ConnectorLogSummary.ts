// SPDX-FileCopyrightText: 2026 Dacely <business@dacely.com>
// SPDX-License-Identifier: LicenseRef-Proprietary

/**
 * Turns the connection log's most recent disconnect lines into short console rows.
 *
 * @remarks
 * Only why sockets ended, stalls and runtime failures are shown: a local refusal, or a close by Nerva or the
 * network. Routine connecting, sign-in and retry lines are left in the file. Every field is read as untrusted data: a line that is not the expected shape is skipped.
 */
export class ConnectorLogSummary {
    static readonly #shown: ReadonlySet<string> = new Set([
        'ending',
        'closed',
        'stall',
        'failed',
        'startup-failed',
        'host-operation-failed',
        'host-application-result',
    ]);

    /**
     * The console rows for the log's recent lines, oldest first.
     *
     * @param lines - Parsed log lines, oldest first
     * @param count - How many rows to return at most
     */
    public static rows(
        lines: readonly Readonly<Record<string, unknown>>[],
        count: number,
    ): readonly string[] {
        const rows: string[] = [];
        for (const line of lines) {
            const event: unknown = line['event'];
            const time: unknown = line['time'];
            if (
                typeof event !== 'string' ||
                !this.#shown.has(event) ||
                typeof time !== 'string' ||
                (event === 'closed' && line['reason'] !== 'closed')
            ) {
                continue;
            }
            const at: Date = new Date(time);
            if (Number.isNaN(at.getTime())) {
                continue;
            }
            rows.push(at.toLocaleTimeString() + '  ' + this.#describe(event, line));
        }
        return rows.slice(-count);
    }

    static #describe(event: string, line: Readonly<Record<string, unknown>>): string {
        const text: (key: string) => string | null = (key: string): string | null => {
            const value: unknown = line[key];
            return typeof value === 'string' && value !== '' ? value : null;
        };
        const number: (key: string) => number | null = (key: string): number | null => {
            const value: unknown = line[key];
            return typeof value === 'number' && Number.isFinite(value) ? value : null;
        };
        if (event === 'host-operation-failed') {
            const code: number | null = number('nativeCode');
            return (
                (text('tool') ?? 'Computer operation') +
                ': ' +
                (text('reason') ?? text('code') ?? 'failed') +
                (text('nativeReason') === null ? '' : ' [' + (text('nativeReason') ?? '') + ']') +
                (code === null ? '' : ' (native code ' + code.toString() + ')')
            );
        }
        if (event === 'host-application-result') {
            return (
                'Application launch: ' +
                (text('status') ?? 'unknown') +
                (line['windowObserved'] === true
                    ? ' · window observed'
                    : ' · no application window confirmed')
            );
        }
        if (event === 'ending') {
            const frame: string | null = text('frame');
            const error: string | null = text('error');
            return (
                'Disconnected: ' +
                (text('reason') ?? 'unknown') +
                (frame === null ? '' : ' (' + frame + ')') +
                (error === null ? '' : ' · ' + error)
            );
        }
        if (event === 'closed') {
            const code: number | null = number('closeCode');
            const after: number | null = number('afterMs');
            return (
                'Nerva or the network closed the connection' +
                (code === null ? '' : ' (code ' + code.toString() + ')') +
                (after === null ? '' : ' after ' + (after / 1000).toFixed(1) + 's')
            );
        }
        if (event === 'stall') {
            const blocked: number | null = number('blockedMs');
            return (
                'The connector was busy' +
                (blocked === null ? '' : ' for ' + (blocked / 1000).toFixed(1) + 's') +
                ' after ' +
                (text('after') ?? 'an unknown step')
            );
        }
        if (event === 'startup-failed') {
            const code: string | null = text('code');
            return (
                'Startup failed: ' +
                (text('error') ?? text('stage') ?? 'Unknown startup step') +
                (code === null ? '' : ' [' + code + ']')
            );
        }
        const error: string | null = text('error');
        return 'Stopped with an error' + (error === null ? '' : ': ' + error);
    }
}
