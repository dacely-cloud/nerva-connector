// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

import { ConnectorDisconnect } from '../runtime/ConnectorDisconnect.js';
import {
    ConnectorStartupStage,
    type ConnectorStartupProgress,
} from '../runtime/ConnectorStartup.js';

/** Owns a finite-rate activity display; completion and disposal release its only timer. */
export class ConnectorStartupDisplay implements Disposable {
    #progress: ConnectorStartupProgress | null = null;
    #started: number = 0;
    #waitingStarted: number | null = null;
    #timer: NodeJS.Timeout | null = null;
    #closed: boolean = false;
    #active: boolean = false;
    #attempt: number = 1;
    #lastWait: ConnectorStartupStage | null = null;
    #lastHttpStatus: number | undefined;
    #retryContext: string = '';

    /** TTY repainting is frequent; redirected output gets stage changes and a ten-second heartbeat. */
    public constructor(
        public readonly render: (text: string) => void,
        public readonly interactive: boolean,
    ) {}

    /** Repeated notifications for the same stage cannot reset its elapsed clock. */
    public update(progress: ConnectorStartupProgress): void {
        if (this.#closed) {
            return;
        }
        const now: number = performance.now();
        if (this.#waitingStarted === null) {
            this.#waitingStarted = now;
        }
        if (
            progress.stage === ConnectorStartupStage.LocalSecurity &&
            this.#progress?.stage !== ConnectorStartupStage.LocalSecurity
        ) {
            this.#waitingStarted = now;
        }
        if (
            progress.stage === ConnectorStartupStage.LocalSecurity ||
            progress.stage === ConnectorStartupStage.Ready
        ) {
            this.#attempt = 1;
            this.#lastWait = null;
            this.#lastHttpStatus = undefined;
            this.#retryContext = '';
        }
        if (progress.stage === ConnectorStartupStage.Retry) {
            this.#attempt = progress.attempt ?? this.#attempt + 1;
            if (this.#progress?.stage !== ConnectorStartupStage.Retry) {
                this.#retryContext =
                    (this.#lastWait === null
                        ? ''
                        : ' · after: ' +
                          this.#lastWait +
                          (this.#lastHttpStatus === undefined
                              ? ''
                              : ' (HTTP ' + this.#lastHttpStatus.toString() + ')')) +
                    (progress.disconnect === undefined ||
                    progress.disconnect === ConnectorDisconnect.Closed
                        ? ''
                        : ' · disconnected: ' + progress.disconnect);
            }
        } else if (
            progress.stage !== ConnectorStartupStage.Closing &&
            progress.stage !== ConnectorStartupStage.Ready &&
            progress.stage !== ConnectorStartupStage.Stopped
        ) {
            this.#lastWait = progress.stage;
            this.#lastHttpStatus = progress.httpStatus;
            this.#retryContext = '';
        }
        const current: ConnectorStartupProgress = {
            ...progress,
            ...(this.#attempt > 1 ? { attempt: this.#attempt } : {}),
        };
        const changed: boolean =
            this.#progress?.stage !== current.stage || this.#progress.attempt !== current.attempt;
        this.#progress = current;
        if (
            progress.stage === ConnectorStartupStage.Ready ||
            progress.stage === ConnectorStartupStage.Stopped
        ) {
            this.#clear();
            this.#waitingStarted = null;
            this.render('');
            return;
        }
        if (changed) {
            this.#clear();
            this.#started = now;
        }
        this.#active = true;
        this.#schedule();
        if (changed) {
            this.#draw();
        }
    }

    /** A terminal failure keeps its last real stage visible without leaving a heartbeat running. */
    public pause(): void {
        this.#clear();
        this.#draw();
    }

    /** An idle display cannot keep the process alive or redraw a restored terminal after shutdown. */
    public [Symbol.dispose](): void {
        this.#closed = true;
        this.#clear();
    }

    #draw(): void {
        const progress: ConnectorStartupProgress | null = this.#progress;
        if (this.#closed || progress === null) {
            return;
        }
        const elapsed: number = Math.max(0, Math.floor((performance.now() - this.#started) / 1000));
        const total: number = Math.max(
            elapsed,
            Math.floor((performance.now() - (this.#waitingStarted ?? this.#started)) / 1000),
        );
        const remaining: number = Math.max(
            0,
            Math.ceil((progress.retryAfterMs ?? 0) / 1000) - elapsed,
        );
        const position: number = elapsed % 12;
        const offset: number = Math.min(position, 12 - position);
        this.render(
            (this.interactive
                ? '[' + ' '.repeat(offset) + '==' + ' '.repeat(6 - offset) + '] '
                : '') +
                progress.stage +
                (progress.httpStatus === undefined
                    ? ''
                    : ' · HTTP ' + progress.httpStatus.toString()) +
                ' · ' +
                elapsed.toString() +
                's' +
                (progress.attempt === undefined
                    ? ''
                    : ' · attempt ' + progress.attempt.toString()) +
                (remaining > 0 ? ' · retry in ' + remaining.toString() + 's' : '') +
                (progress.stage === ConnectorStartupStage.Retry ? this.#retryContext : '') +
                (total > elapsed ? ' · total ' + total.toString() + 's' : '') +
                (elapsed >= 15 &&
                progress.stage !== ConnectorStartupStage.Retry &&
                progress.stage !== ConnectorStartupStage.Approval
                    ? ' · still waiting'
                    : ''),
        );
    }
    #schedule(): void {
        if (!this.#active || this.#closed || this.#timer !== null) {
            return;
        }
        const period: number = this.interactive ? 1000 : 10000;
        const elapsed: number = Math.max(0, performance.now() - this.#started);
        const delay: number = Math.max(1, Math.ceil(period - (elapsed % period)));
        this.#timer = setTimeout((): void => {
            this.#timer = null;
            this.#draw();
            this.#schedule();
        }, delay);
        this.#timer.unref();
    }
    #clear(): void {
        this.#active = false;
        if (this.#timer !== null) {
            clearTimeout(this.#timer);
            this.#timer = null;
        }
    }
}
