// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

import { emitKeypressEvents, type Key } from 'node:readline';
import {
    ConnectorConsoleCommand,
    ConnectorConsoleModel,
    ConnectorConsolePhase,
} from './ConnectorConsoleModel.js';
import {
    ConnectorConsoleScreen,
    ConnectorConsoleView,
    type ConnectorConsoleChoice,
    type ConnectorConsoleFrame,
} from './ConnectorConsoleScreen.js';
import type {
    ConnectorActivitySnapshot,
    ConnectorActivityView,
} from '../runtime/ConnectorActivity.js';
import { ConnectorScreenPainter } from './ConnectorScreenPainter.js';

/** Small native-Node terminal owner: the live summary, the activity list and the slash menu. */
export class ConnectorConsole implements Disposable {
    /** Every command in menu order, with what it does in plain words. */
    public static readonly commands: readonly ConnectorConsoleChoice[] = Object.freeze([
        {
            command: ConnectorConsoleCommand.Activity,
            description: 'See everything Nexa did on this computer',
        },
        {
            command: ConnectorConsoleCommand.Settings,
            description: 'Change the name, folder or what Nexa can do',
        },
        { command: ConnectorConsoleCommand.Reconnect, description: 'Connect again now' },
        {
            command: ConnectorConsoleCommand.Pair,
            description: 'Link this computer to your Nerva account',
        },
        { command: ConnectorConsoleCommand.Permissions, description: 'Share a folder with Nexa' },
        {
            command: ConnectorConsoleCommand.DisableHost,
            description: 'Turn off full computer access',
        },
        {
            command: ConnectorConsoleCommand.System,
            description: "Show this computer's processor, memory and graphics",
        },
        {
            command: ConnectorConsoleCommand.Startup,
            description: 'Start in the background when you sign in to Windows, or stop doing so',
        },
        {
            command: ConnectorConsoleCommand.Log,
            description: 'Show why recent connections ended',
        },
        {
            command: ConnectorConsoleCommand.Logout,
            description: 'Unlink this computer from your account',
        },
        { command: ConnectorConsoleCommand.Help, description: 'Show every command' },
        { command: ConnectorConsoleCommand.Quit, description: 'Close the connector' },
    ]);
    static readonly #empty: ConnectorActivitySnapshot = Object.freeze({
        running: [],
        recent: [],
        programs: [],
        total: 0,
    });
    readonly #wasRaw: boolean = process.stdin.isRaw;
    readonly #wasFlowing: boolean | null = process.stdin.readableFlowing;
    readonly #activity: ConnectorActivityView | null;
    readonly #painter: ConnectorScreenPainter = new ConnectorScreenPainter();
    #unsubscribe: (() => void) | null = null;
    #closed: boolean = false;
    #attached: boolean = false;
    #text: string = '';
    #cursor: number = 0;
    #selected: number = 0;
    #view: ConnectorConsoleView = ConnectorConsoleView.Home;
    #scroll: number = 0;
    #scrollLimit: number = 0;
    #tick: number = 0;
    #timer: NodeJS.Timeout | null = null;
    #period: number = 0;
    #prompts: Promise<void> = Promise.resolve();
    readonly #resize: () => void = (): void => this.draw();
    readonly #end: () => void = (): void => this.command(ConnectorConsoleCommand.Quit);
    readonly #key: (text: string | undefined, key: Key) => void = (
        text: string | undefined,
        key: Key,
    ): void => this.#input(text, key);

    /**
     * Only the foreground TTY takes raw input; teardown restores its prior owner state.
     *
     * @param activity - What Nexa is doing here, or `null` when nothing is recorded
     */
    public constructor(
        public readonly model: ConnectorConsoleModel,
        public readonly command: (command: ConnectorConsoleCommand) => void,
        activity: ConnectorActivityView | null = null,
    ) {
        if (!process.stdin.isTTY || !process.stdout.isTTY) {
            throw new Error('An interactive terminal is required');
        }
        this.#activity = activity;
        this.#attach();
    }

    /**
     * Menu rows matching `input` that make sense right now.
     *
     * @remarks
     * Linking is offered only while not connected, folder sharing only where it is supported, and
     * turning off full computer access only while it is on.
     */
    public static choices(
        input: string,
        model: ConnectorConsoleModel,
        platform: NodeJS.Platform = process.platform,
    ): readonly ConnectorConsoleChoice[] {
        if (!input.startsWith('/')) {
            return [];
        }
        const typed: string = input.slice(1).toLowerCase();
        return this.commands.filter(
            (choice: ConnectorConsoleChoice): boolean =>
                choice.command.startsWith(typed) &&
                (choice.command !== ConnectorConsoleCommand.Pair ||
                    model.phase !== ConnectorConsolePhase.Connected) &&
                (choice.command !== ConnectorConsoleCommand.Permissions || platform === 'linux') &&
                (choice.command !== ConnectorConsoleCommand.DisableHost || model.host) &&
                (choice.command !== ConnectorConsoleCommand.Startup || model.startup !== null),
        );
    }

    /** The view currently shown. */
    public get view(): ConnectorConsoleView {
        return this.#view;
    }

    /** Switches between the summary and the full activity list. */
    public show(view: ConnectorConsoleView): void {
        this.#view = view;
        this.#scroll = 0;
        this.draw();
    }

    /**
     * Brings the terminal up to date with the current state.
     *
     * @remarks
     * Only rows whose text changed are written, and nothing at all when nothing changed, so text the user
     * selected with the mouse stays selected and can be copied.
     */
    public draw(): void {
        if (this.#closed || !this.#attached) {
            return;
        }
        const activity: ConnectorActivitySnapshot =
            this.#activity?.snapshot() ?? ConnectorConsole.#empty;
        this.#ticking(
            this.model.retryAt !== null || activity.running.length > 0
                ? 1000
                : activity.programs.length > 0 || activity.recent.length > 0
                  ? 15000
                  : 0,
        );
        const columns: number = process.stdout.columns || 80;
        const rows: number = process.stdout.rows || 24;
        const frame: ConnectorConsoleFrame = ConnectorConsoleScreen.frame(
            {
                model: this.model,
                activity,
                view: this.#view,
                scroll: this.#scroll,
                input: { text: this.#text, cursor: this.#cursor, selected: this.#selected },
                choices: ConnectorConsole.choices(this.#text, this.model),
                tick: this.#tick,
            },
            columns,
            rows,
            Date.now(),
            performance.now(),
        );
        this.#scrollLimit = frame.scrollLimit;
        const output: string = this.#painter.paint(frame, columns, rows);
        if (output !== '') {
            process.stdout.write(output);
        }
    }

    /** Raw mode, listeners, timers, colors and the prior shell screen are restored even after connection failure. */
    public [Symbol.dispose](): void {
        if (this.#closed) {
            return;
        }
        this.#closed = true;
        this.#detach();
    }

    /** A setup or approval screen temporarily owns input; one screen at a time, then the console returns. */
    public async withPrompt<T>(operation: () => Promise<T>): Promise<T> {
        const previous: Promise<void> = this.#prompts;
        const turn: PromiseWithResolvers<undefined> = Promise.withResolvers<undefined>();
        this.#prompts = turn.promise;
        await previous;
        try {
            if (this.#closed || !this.#attached) {
                throw new Error('Connector terminal is unavailable');
            }
            this.#detach();
            process.stdin.once('end', this.#end);
            try {
                return await operation();
            } finally {
                process.stdin.off('end', this.#end);
                if (!this.#closed) {
                    this.#attach();
                }
            }
        } finally {
            turn.resolve(undefined);
        }
    }

    /**
     * Repaints on a timer only while something on screen changes with time.
     *
     * @param period - Milliseconds between repaints: every second for spinners, elapsed seconds and the retry
     * countdown, every 15 seconds for minute-based times, or 0 to stop
     */
    #ticking(period: number): void {
        if (period === this.#period) {
            return;
        }
        if (this.#timer !== null) {
            clearInterval(this.#timer);
            this.#timer = null;
        }
        this.#period = period;
        if (period > 0) {
            this.#timer = setInterval((): void => {
                this.#tick += 1;
                this.draw();
            }, period);
            this.#timer.unref();
        }
    }

    #attach(): void {
        this.#attached = true;
        emitKeypressEvents(process.stdin);
        process.stdin.setRawMode(true);
        process.stdin.on('keypress', this.#key);
        process.stdin.once('end', this.#end);
        process.stdout.on('resize', this.#resize);
        process.stdin.resume();
        process.stdout.write('\x1b[?1049h');
        this.#painter.reset();
        this.#unsubscribe = this.#activity?.subscribe((): void => this.draw()) ?? null;
        this.draw();
    }

    #detach(): void {
        this.#ticking(0);
        this.#unsubscribe?.();
        this.#unsubscribe = null;
        if (!this.#attached) {
            return;
        }
        this.#attached = false;
        process.stdin.off('keypress', this.#key);
        process.stdin.off('end', this.#end);
        process.stdout.off('resize', this.#resize);
        process.stdin.setRawMode(this.#wasRaw);
        if (this.#wasFlowing !== true) {
            process.stdin.pause();
        }
        process.stdout.write('\x1b[0m\x1b[?25h\x1b[?1049l');
    }

    #input(text: string | undefined, key: Key): void {
        if (key.ctrl && (key.name === 'c' || key.name === 'd')) {
            this.#end();
            return;
        }
        const choices: readonly ConnectorConsoleChoice[] = ConnectorConsole.choices(
            this.#text,
            this.model,
        );
        if (key.name === 'up' || key.name === 'down') {
            if (choices.length > 0) {
                this.#selected =
                    (this.#selected + (key.name === 'up' ? -1 : 1) + choices.length) %
                    choices.length;
            } else if (this.#view === ConnectorConsoleView.Activity) {
                this.#scrollBy(key.name === 'up' ? -1 : 1);
            }
        } else if (key.name === 'pageup' || key.name === 'pagedown') {
            if (this.#view === ConnectorConsoleView.Activity) {
                this.#scrollBy(key.name === 'pageup' ? -10 : 10);
            }
        } else if (key.name === 'escape') {
            if (this.#text !== '') {
                this.#text = '';
                this.#cursor = 0;
                this.#selected = 0;
            } else if (this.#view === ConnectorConsoleView.Activity) {
                this.#view = ConnectorConsoleView.Home;
                this.#scroll = 0;
            }
        } else if (key.name === 'tab') {
            if (choices[this.#selected] !== undefined) {
                this.#text = '/' + (choices[this.#selected]?.command ?? '');
                this.#cursor = this.#text.length;
                this.#selected = 0;
            } else if (this.#text === '') {
                this.#view =
                    this.#view === ConnectorConsoleView.Home
                        ? ConnectorConsoleView.Activity
                        : ConnectorConsoleView.Home;
                this.#scroll = 0;
            }
        } else if (key.name === 'left') {
            this.#cursor = Math.max(0, this.#cursor - 1);
        } else if (key.name === 'right') {
            this.#cursor = Math.min(this.#text.length, this.#cursor + 1);
        } else if (key.name === 'backspace') {
            this.#text =
                this.#text.slice(0, Math.max(0, this.#cursor - 1)) + this.#text.slice(this.#cursor);
            this.#cursor = Math.max(0, this.#cursor - 1);
            this.#selected = 0;
        } else if (key.name === 'return') {
            this.#submit(choices[this.#selected]);
        } else if (
            text !== undefined &&
            !key.ctrl &&
            !key.meta &&
            /^[a-z/?-]+$/i.test(text) &&
            this.#text.length + text.length <= 64
        ) {
            this.#text = this.#text.slice(0, this.#cursor) + text + this.#text.slice(this.#cursor);
            this.#cursor += text.length;
            this.#selected = 0;
        }
        this.draw();
    }

    #submit(choice: ConnectorConsoleChoice | undefined): void {
        const empty: boolean = this.#text === '';
        this.#text = '';
        this.#cursor = 0;
        this.#selected = 0;
        if (empty || choice?.command === ConnectorConsoleCommand.Help) {
            this.#text = '/';
            this.#cursor = 1;
            return;
        }
        if (choice === undefined) {
            return;
        }
        if (choice.command === ConnectorConsoleCommand.Activity) {
            this.#view = ConnectorConsoleView.Activity;
            this.#scroll = 0;
            return;
        }
        this.command(choice.command);
    }

    #scrollBy(rows: number): void {
        this.#scroll = Math.max(0, Math.min(this.#scrollLimit, this.#scroll + rows));
    }
}
