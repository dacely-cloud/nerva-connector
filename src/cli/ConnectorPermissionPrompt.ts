// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

import { ConnectorScreenPainter } from './ConnectorScreenPainter.js';
import { emitKeypressEvents, type Key } from 'node:readline';
import {
    ConnectorPermissionError,
    ConnectorPermissionFailure,
} from '../permissions/ConnectorPermissionError.js';
import { ConnectorPromptEditor } from './ConnectorPromptEditor.js';
import { ConnectorPromptScreen } from './ConnectorPromptScreen.js';
import {
    ConnectorPromptAction,
    type ConnectorPromptConfirm,
    type ConnectorPromptPanel,
    type ConnectorPromptResult,
    type ConnectorPromptSelect,
    type ConnectorPromptText,
    type ConnectorPromptWait,
} from './ConnectorPromptTypes.js';

/** A current prompt driver renders typed panels and controls; input cancellation cannot stand for approval. */
export interface ConnectorPermissionQuestions {
    /** Replace the complete current panel without inferring layout from prose. */
    show(panel: ConnectorPromptPanel): void;
    /** Edit the actual bounded initial field value and return explicit navigation. */
    text(question: ConnectorPromptText): Promise<ConnectorPromptResult>;
    /** Commit one exact option with native arrow-key selection. */
    select(question: ConnectorPromptSelect): Promise<ConnectorPromptResult>;
    /**
     * Enter performs the named action; Esc goes back.
     *
     * @param release - When aborted, the control submits on its own, as if Enter were pressed
     */
    confirm(
        question: ConnectorPromptConfirm,
        release?: AbortSignal,
    ): Promise<ConnectorPromptResult>;
    /**
     * Keep Esc and Ctrl+C available while work runs; the control submits when `release` aborts.
     *
     * @param release - Aborted by the caller when the awaited work has finished
     */
    wait(question: ConnectorPromptWait, release: AbortSignal): Promise<ConnectorPromptResult>;
}

/** One colored native-Node TUI owns raw input, screen geometry and cancellation for the setup and approval screens. */
export class ConnectorPermissionPrompt implements ConnectorPermissionQuestions, Disposable {
    readonly #stop: AbortController = new AbortController();
    readonly #signal: AbortSignal;
    readonly #wasRaw: boolean = process.stdin.isRaw;
    readonly #wasFlowing: boolean | null = process.stdin.readableFlowing;
    #panel: ConnectorPromptPanel = { title: '', description: [] };
    #editor: ConnectorPromptEditor | null = null;
    #pending: PromiseWithResolvers<ConnectorPromptResult> | null = null;
    #closed: boolean = false;
    readonly #painter: ConnectorScreenPainter = new ConnectorScreenPainter();
    #blocked: boolean = false;
    #redraw: boolean = false;
    #tick: number = 0;
    #animation: NodeJS.Timeout | null = null;
    readonly #resize: () => void = (): void => this.#draw();
    readonly #abort: () => void = (): void => {
        this.#settle({ action: ConnectorPromptAction.Cancel });
    };
    readonly #end: () => void = (): void => this.#stop.abort();
    readonly #drain: () => void = (): void => {
        this.#blocked = false;
        if (this.#redraw) {
            this.#draw();
        }
    };
    readonly #key: (text: string | undefined, key: Key) => void = (
        text: string | undefined,
        key: Key,
    ): void => {
        if (key.ctrl && (key.name === 'c' || key.name === 'd')) {
            this.#stop.abort();
            return;
        }
        const result: ConnectorPromptResult | null = this.#editor?.press(text, key) ?? null;
        if (result !== null) {
            this.#settle(result);
        } else {
            this.#draw();
        }
    };

    /** Redirected input cannot approve a grant; terminal ownership is restored exactly on disposal. */
    public constructor(signal: AbortSignal) {
        if (!process.stdin.isTTY || !process.stdout.isTTY) {
            throw new ConnectorPermissionError(ConnectorPermissionFailure.Terminal);
        }
        this.#signal = AbortSignal.any([signal, this.#stop.signal]);
        emitKeypressEvents(process.stdin);
        process.stdin.setRawMode(true);
        process.stdin.on('keypress', this.#key);
        process.stdin.once('end', this.#end);
        process.stdin.once('close', this.#end);
        process.stdin.on('error', this.#end);
        process.stdout.on('resize', this.#resize);
        process.stdout.on('drain', this.#drain);
        process.stdout.on('error', this.#end);
        this.#signal.addEventListener('abort', this.#abort);
        process.stdin.resume();
        process.stdout.write('\x1b[?1049h');
    }
    /** Local cancellation (Ctrl+C) also stops asynchronous work started from these screens. */
    public get signal(): AbortSignal {
        return this.#signal;
    }
    /** All user-controlled panel text is sanitized by the screen renderer before terminal output. */
    public show(panel: ConnectorPromptPanel): void {
        this.#panel = panel;
        this.#animate(panel.status?.busy === true);
        this.#draw();
    }
    /** Actual field contents, including defaults, remain editable without a readline compatibility path. */
    public async text(question: ConnectorPromptText): Promise<ConnectorPromptResult> {
        return await this.#question(new ConnectorPromptEditor(question), null);
    }
    /** Typed choices use the same owned keyboard and render lifecycle as text fields. */
    public async select(question: ConnectorPromptSelect): Promise<ConnectorPromptResult> {
        return await this.#question(new ConnectorPromptEditor(question), null);
    }
    /** A single named action; Enter or the release signal submits it. */
    public async confirm(
        question: ConnectorPromptConfirm,
        release?: AbortSignal,
    ): Promise<ConnectorPromptResult> {
        return await this.#question(new ConnectorPromptEditor(question), release ?? null);
    }
    /** Waiting work cannot be approved by Enter; only `release`, Esc or Ctrl+C end it. */
    public async wait(
        question: ConnectorPromptWait,
        release: AbortSignal,
    ): Promise<ConnectorPromptResult> {
        return await this.#question(new ConnectorPromptEditor(question), release);
    }

    /** Every listener, timer, raw/flowing mode, cursor, palette and alternate screen returns to its previous owner. */
    public [Symbol.dispose](): void {
        if (this.#closed) {
            return;
        }
        this.#closed = true;
        this.#animate(false);
        this.#stop.abort();
        process.stdin.off('keypress', this.#key);
        process.stdin.off('end', this.#end);
        process.stdin.off('close', this.#end);
        process.stdin.off('error', this.#end);
        process.stdout.off('resize', this.#resize);
        process.stdout.off('drain', this.#drain);
        process.stdout.off('error', this.#end);
        this.#signal.removeEventListener('abort', this.#abort);
        process.stdin.setRawMode(this.#wasRaw);
        if (this.#wasFlowing !== true) {
            process.stdin.pause();
        }
        process.stdout.write('\x1b[0m\x1b[?25h\x1b[?1049l');
    }

    async #question(
        editor: ConnectorPromptEditor,
        release: AbortSignal | null,
    ): Promise<ConnectorPromptResult> {
        if (this.#pending !== null) {
            throw new Error('Connector screen already owns a focused control');
        }
        if (this.#closed || this.#signal.aborted) {
            return { action: ConnectorPromptAction.Cancel };
        }
        const pending: PromiseWithResolvers<ConnectorPromptResult> =
            Promise.withResolvers<ConnectorPromptResult>();
        const submit: () => void = (): void => {
            if (this.#pending === pending) {
                this.#settle({ action: ConnectorPromptAction.Submit, value: '' });
            }
        };
        this.#editor = editor;
        this.#pending = pending;
        release?.addEventListener('abort', submit, { once: true });
        if (release?.aborted === true) {
            submit();
        }
        this.#draw();
        try {
            return await pending.promise;
        } finally {
            release?.removeEventListener('abort', submit);
        }
    }
    #settle(result: ConnectorPromptResult): void {
        const pending: PromiseWithResolvers<ConnectorPromptResult> | null = this.#pending;
        this.#pending = null;
        this.#editor = null;
        pending?.resolve(result);
    }
    #animate(active: boolean): void {
        if (active && this.#animation === null && !this.#closed) {
            this.#animation = setInterval((): void => {
                this.#tick = (this.#tick + 1) % ConnectorPromptScreen.spinner.length;
                this.#draw();
            }, 250);
            this.#animation.unref();
        } else if (!active && this.#animation !== null) {
            clearInterval(this.#animation);
            this.#animation = null;
        }
    }
    #draw(): void {
        if (this.#closed) {
            return;
        }
        if (this.#blocked) {
            this.#redraw = true;
            return;
        }
        this.#redraw = false;
        const columns: number = process.stdout.columns || 80;
        const rows: number = process.stdout.rows || 24;
        const output: string = this.#painter.paint(
            ConnectorPromptScreen.render(this.#panel, this.#editor, columns, rows, this.#tick),
            columns,
            rows,
        );
        if (output !== '') {
            this.#blocked = !process.stdout.write(output);
        }
    }
}
