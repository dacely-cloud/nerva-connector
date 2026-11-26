// SPDX-FileCopyrightText: 2026 Dacely <business@dacely.com>
// SPDX-License-Identifier: LicenseRef-Proprietary

import { createHash } from 'node:crypto';
import type { Stats } from 'node:fs';
import { mkdir, open, readFile, rename, stat, type FileHandle } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';

/** A value one log line may carry: fixed words, local error text, counts and flags. */
export type ConnectorLogValue = string | number | boolean | null;

/** The named fields of one log line, after its time and event. */
export type ConnectorLogFields = Readonly<Record<string, ConnectorLogValue>>;

/**
 * What the connector did with its connection to Nerva, one JSON line per event, in a bounded file the person owns.
 *
 * @remarks
 * The console owns the terminal, so nothing here is printed. Lines name connection steps, why a socket ended, the
 * local error message behind a refusal, retry delays and event-loop stalls; they never carry keys, signatures,
 * leases, permits, file contents or command text. Each device is named by the same twelve-digit pseudonym the
 * Nerva server journal uses, so both sides of one disconnect can be matched. The file rotates at
 * {@link ConnectorConnectionLog.maximumBytes} into one `.1` predecessor, so it never holds more than twice that.
 * Writes are queued and never fail or delay the connection; after a write error the log stops trying.
 */
export class ConnectorConnectionLog {
    /** Size at which the current file is rotated into its single predecessor. */
    public static readonly maximumBytes: number = 1048576;
    static readonly #valueLength: number = 300;
    #queue: Promise<void> = Promise.resolve();
    #failed: boolean = false;
    #last: string = 'started';

    /** @param path - The current log file; its directory is created owner-only when missing */
    public constructor(public readonly path: string) {}

    /**
     * The per-user log location for this platform.
     *
     * @remarks
     * Windows uses `%LOCALAPPDATA%\Nerva Connector\Logs`, macOS `~/Library/Logs/Nerva Connector`, and Linux
     * `$XDG_STATE_HOME/nerva-connector` or `~/.local/state/nerva-connector`.
     */
    public static location(
        platform: NodeJS.Platform = process.platform,
        environment: NodeJS.ProcessEnv = process.env,
        home: string = homedir(),
    ): string {
        const name: string = 'connection.log';
        if (platform === 'win32') {
            const local: string | undefined = environment['LOCALAPPDATA'];
            return join(
                local !== undefined && isAbsolute(local) ? local : join(home, 'AppData', 'Local'),
                'Nerva Connector',
                'Logs',
                name,
            );
        }
        if (platform === 'darwin') {
            return join(home, 'Library', 'Logs', 'Nerva Connector', name);
        }
        const state: string | undefined = environment['XDG_STATE_HOME'];
        return join(
            state !== undefined && isAbsolute(state) ? state : join(home, '.local', 'state'),
            'nerva-connector',
            name,
        );
    }

    /**
     * The pseudonym the connector and the Nerva server journal both log for one device.
     *
     * @param enrollmentId - This device's enrollment
     * @param slot - This device's slot within the enrollment
     * @returns Twelve lowercase hex digits; the enrollment cannot be recovered from them
     */
    public static pseudonym(enrollmentId: string, slot: number): string {
        return createHash('sha256')
            .update('nerva-connector-log-device\0' + enrollmentId + '\0' + slot.toString())
            .digest('hex')
            .slice(0, 12);
    }

    /**
     * The local error text one line may carry: control and format characters removed, bounded in length.
     *
     * @param cause - What was thrown
     * @returns The message of an `Error`, or `null` for anything else
     */
    public static error(cause: unknown): string | null {
        if (!(cause instanceof Error)) {
            return null;
        }
        return ConnectorConnectionLog.#clean(cause.message === '' ? cause.name : cause.message);
    }

    /** Queues one line; it never throws and never waits for the disk. */
    public record(event: string, fields: ConnectorLogFields = {}): void {
        if (this.#failed) {
            return;
        }
        this.#last = event;
        const values: Record<string, ConnectorLogValue> = {};
        for (const [key, value] of Object.entries(fields)) {
            values[key] = typeof value === 'string' ? ConnectorConnectionLog.#clean(value) : value;
        }
        const line: string =
            JSON.stringify({ time: new Date().toISOString(), event, ...values }) + '\n';
        this.#queue = this.#queue.then(async (): Promise<void> => await this.#append(line));
    }

    /** Resolves once every queued line was written or dropped. */
    public async flush(): Promise<void> {
        await this.#queue;
    }

    /**
     * Records each time the event loop was blocked for longer than a second, naming the event logged before it.
     *
     * @remarks
     * A blocked loop also stops the console from reading keys, so a stall line next to an unresponsive terminal
     * says the connector itself was busy rather than the terminal having lost its input.
     *
     * @returns Stops watching when disposed
     */
    public watchStalls(): Disposable {
        const periodMs: number = 500;
        let expected: number = performance.now() + periodMs;
        const timer: NodeJS.Timeout = setInterval((): void => {
            const now: number = performance.now();
            const blocked: number = Math.round(now - expected);
            expected = now + periodMs;
            if (blocked > 1000) {
                this.record('stall', { blockedMs: blocked, after: this.#last });
            }
        }, periodMs);
        timer.unref();
        return {
            [Symbol.dispose]: (): void => clearInterval(timer),
        };
    }

    /**
     * The most recent lines, newest last, read from the current file only.
     *
     * @param count - How many lines to return
     * @returns The parsed lines; an absent or unreadable file yields none
     */
    public async recent(count: number): Promise<readonly Readonly<Record<string, unknown>>[]> {
        await this.flush();
        let text: string;
        try {
            const bytes: Buffer = await readFile(this.path);
            text = bytes.subarray(Math.max(0, bytes.byteLength - 65536)).toString('utf8');
        } catch {
            return [];
        }
        const lines: Readonly<Record<string, unknown>>[] = [];
        for (const line of text.split('\n').slice(-count - 1)) {
            try {
                const value: unknown = JSON.parse(line);
                if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
                    lines.push(value as Readonly<Record<string, unknown>>);
                }
            } catch {
                /** A line cut by the read window or by rotation is skipped. */
                continue;
            }
        }
        return lines.slice(-count);
    }

    async #append(line: string): Promise<void> {
        let handle: FileHandle | null = null;
        try {
            await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
            const size: number = await stat(this.path).then(
                (stats: Stats): number => stats.size,
                (): number => 0,
            );
            if (size > 0 && size + Buffer.byteLength(line) > ConnectorConnectionLog.maximumBytes) {
                await rename(this.path, this.path + '.1');
            }
            handle = await open(this.path, 'a', 0o600);
            await handle.write(line);
        } catch {
            this.#failed = true;
        } finally {
            await handle?.close().catch((): void => {
                this.#failed = true;
            });
        }
    }

    static #clean(value: string): string {
        const text: string = value.replace(/[\p{Cc}\p{Cf}]+/gu, ' ').trim();
        return text.length > ConnectorConnectionLog.#valueLength
            ? text.slice(0, ConnectorConnectionLog.#valueLength) + '…'
            : text;
    }
}
