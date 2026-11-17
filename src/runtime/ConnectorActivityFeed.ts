// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

import { ConnectorHostTool } from '../protocol/ConnectorHost.js';
import {
    ConnectorActivityState,
    type ConnectorActivityEntry,
    type ConnectorActivityHandle,
    type ConnectorActivityProgram,
    type ConnectorActivitySink,
    type ConnectorActivitySnapshot,
    type ConnectorActivitySource,
    type ConnectorActivityView,
} from './ConnectorActivity.js';
import { ConnectorActivityArguments } from './ConnectorActivityArguments.js';
import {
    ConnectorActivityDescription,
    type ConnectorActivityDescribed,
} from './ConnectorActivityDescription.js';

/** One request in progress and what its outcome may change in the program list. */
interface ConnectorActivityRun {
    readonly entry: ConnectorActivityEntry;
    readonly toolName: string;
    /** The owned program a read, write, stop or release names, or empty. */
    readonly processId: string;
}

/**
 * The bounded, in-memory record of what Nexa does on this computer, read by the local activity screen.
 *
 * @remarks
 * Recording is constant work per request apart from reading its bounded JSON arguments once, plus the result of a
 * program start or of a read of a tracked program. Running requests, the most recent finished requests,
 * background programs and agent labels each have a fixed cap, so a long session never grows memory. Entries are
 * frozen and every snapshot is a fresh copy. Nothing here can throw into, delay or change the runtime lane that
 * reports a request, and nothing is scheduled while no listener is subscribed.
 *
 * Listeners are notified at most once per microtask burst, after the lane's synchronous work. A listener failure
 * is kept in {@link ConnectorActivityFeed.listenerFailure} and the listener stays subscribed for the next change,
 * because a screen that failed one repaint should still show the next one.
 */
export class ConnectorActivityFeed implements ConnectorActivitySink, ConnectorActivityView {
    /** Finished requests kept for the screen, newest first. */
    public static readonly recentLimit: number = 100;
    /** Background programs and terminals tracked; the oldest is forgotten beyond this. */
    public static readonly programLimit: number = 64;
    /** Requests tracked as running; the lanes run few at a time, so this only bounds a misbehaving caller. */
    public static readonly runningLimit: number = 256;
    /** Agents remembered for numbering; the least recently active is forgotten beyond this. */
    public static readonly agentLimit: number = 1024;
    static readonly #starts: ReadonlyMap<string, boolean> = new Map<string, boolean>([
        [ConnectorHostTool.ProcessStart, false],
        [ConnectorHostTool.TerminalStart, true],
    ]);
    static readonly #reads: ReadonlySet<string> = new Set<string>([
        ConnectorHostTool.ProcessRead,
        ConnectorHostTool.TerminalRead,
    ]);
    static readonly #ends: ReadonlySet<string> = new Set<string>([
        ConnectorHostTool.ProcessStop,
        ConnectorHostTool.ProcessRelease,
        ConnectorHostTool.TerminalStop,
        ConnectorHostTool.TerminalRelease,
    ]);
    static readonly #targets: ReadonlySet<string> = new Set<string>([
        ...ConnectorActivityFeed.#reads,
        ...ConnectorActivityFeed.#ends,
        ConnectorHostTool.ProcessWrite,
        ConnectorHostTool.TerminalWrite,
        ConnectorHostTool.TerminalResize,
    ]);
    readonly #running: Map<number, ConnectorActivityRun> = new Map<number, ConnectorActivityRun>();
    readonly #recent: (ConnectorActivityEntry | null)[] = new Array<ConnectorActivityEntry | null>(
        ConnectorActivityFeed.recentLimit,
    ).fill(null);
    readonly #programs: Map<string, ConnectorActivityProgram> = new Map<
        string,
        ConnectorActivityProgram
    >();
    readonly #agents: Map<string, number> = new Map<string, number>();
    readonly #listeners: Set<() => void> = new Set<() => void>();
    #recentNext: number = 0;
    #recentCount: number = 0;
    #nextId: number = 1;
    #nextAgent: number = 1;
    #total: number = 0;
    #notifying: boolean = false;
    #listenerFailure: Error | null = null;

    /** The most recent error a listener threw, or `null`; it never reached the lane that reported the change. */
    public get listenerFailure(): Error | null {
        return this.#listenerFailure;
    }

    /** Records a request that is about to run and returns the handle that completes it once. */
    public begin(source: ConnectorActivitySource): ConnectorActivityHandle {
        const args: ConnectorActivityArguments = ConnectorActivityArguments.parse(
            source.argumentsJson,
        );
        const described: ConnectorActivityDescribed = ConnectorActivityDescription.describe(
            source.toolName,
            args,
        );
        const processId: string = ConnectorActivityFeed.#targets.has(source.toolName)
            ? args.text('processId')
            : '';
        const entry: ConnectorActivityEntry = Object.freeze({
            id: this.#nextId,
            agent: this.#agent(source.jobId),
            kind: described.kind,
            title: described.title,
            subject:
                described.subject === '' && processId !== ''
                    ? (this.#programs.get(processId)?.subject ?? '')
                    : described.subject,
            state: ConnectorActivityState.Running,
            startedAtMs: Date.now(),
            endedAtMs: null,
        });
        this.#nextId += 1;
        this.#total += 1;
        this.#running.set(entry.id, { entry, toolName: source.toolName, processId });
        if (this.#running.size > ConnectorActivityFeed.runningLimit) {
            const oldest: number | undefined = this.#running.keys().next().value;
            if (oldest !== undefined) {
                this.#running.delete(oldest);
            }
        }
        this.#changed();
        let open: boolean = true;
        return {
            finish: (succeeded: boolean, resultJson: string | null): void => {
                if (open) {
                    open = false;
                    this.#finish(entry.id, succeeded, resultJson);
                }
            },
        };
    }

    /** A consistent copy for one repaint. */
    public snapshot(): ConnectorActivitySnapshot {
        const recent: ConnectorActivityEntry[] = [];
        for (let offset: number = 1; offset <= this.#recentCount; offset++) {
            const entry: ConnectorActivityEntry | null =
                this.#recent[
                    (this.#recentNext - offset + ConnectorActivityFeed.recentLimit) %
                        ConnectorActivityFeed.recentLimit
                ] ?? null;
            if (entry !== null) {
                recent.push(entry);
            }
        }
        return Object.freeze({
            running: Object.freeze(
                Array.from(
                    this.#running.values(),
                    (run: ConnectorActivityRun): ConnectorActivityEntry => run.entry,
                ),
            ),
            recent: Object.freeze(recent),
            programs: Object.freeze(Array.from(this.#programs.values())),
            total: this.#total,
        });
    }

    /**
     * Calls `listener` after every burst of changes.
     *
     * @returns Stops the notifications
     */
    public subscribe(listener: () => void): () => void {
        this.#listeners.add(listener);
        return (): void => {
            this.#listeners.delete(listener);
        };
    }

    #finish(id: number, succeeded: boolean, resultJson: string | null): void {
        const run: ConnectorActivityRun | undefined = this.#running.get(id);
        if (run === undefined) {
            return;
        }
        this.#running.delete(id);
        const entry: ConnectorActivityEntry = Object.freeze({
            ...run.entry,
            state: succeeded ? ConnectorActivityState.Done : ConnectorActivityState.Failed,
            endedAtMs: Date.now(),
        });
        this.#recent[this.#recentNext] = entry;
        this.#recentNext = (this.#recentNext + 1) % ConnectorActivityFeed.recentLimit;
        this.#recentCount = Math.min(this.#recentCount + 1, ConnectorActivityFeed.recentLimit);
        if (succeeded) {
            this.#track(run, resultJson);
        }
        this.#changed();
    }

    /**
     * A program or terminal that ended leaves the running list.
     *
     * @remarks
     * The host workspace reports this when the program and everything it started have exited, when it is stopped,
     * released or expires, and when the workspace closes. Before, only a later read that happened to see the exit
     * removed it, so a program the user had closed stayed listed as running.
     */
    public ended(processId: string): void {
        if (this.#programs.delete(processId)) {
            this.#changed();
        }
    }

    /** Successful starts add a still-running program; ends, and reads that saw it exit, remove one. */
    #track(run: ConnectorActivityRun, resultJson: string | null): void {
        const terminal: boolean | undefined = ConnectorActivityFeed.#starts.get(run.toolName);
        if (terminal !== undefined) {
            const result: ConnectorActivityArguments = ConnectorActivityArguments.parse(resultJson);
            const processId: string = result.text('processId');
            if (processId !== '' && result.flag('running')) {
                this.#programs.delete(processId);
                this.#programs.set(
                    processId,
                    Object.freeze({
                        id: processId,
                        agent: run.entry.agent,
                        terminal,
                        subject: run.entry.subject,
                        startedAtMs: run.entry.startedAtMs,
                    }),
                );
                if (this.#programs.size > ConnectorActivityFeed.programLimit) {
                    const oldest: string | undefined = this.#programs.keys().next().value;
                    if (oldest !== undefined) {
                        this.#programs.delete(oldest);
                    }
                }
            }
        } else if (run.processId === '' || !this.#programs.has(run.processId)) {
            return;
        } else if (ConnectorActivityFeed.#ends.has(run.toolName)) {
            this.#programs.delete(run.processId);
        } else if (ConnectorActivityFeed.#reads.has(run.toolName)) {
            const result: ConnectorActivityArguments = ConnectorActivityArguments.parse(resultJson);
            if (
                result.text('processId') === run.processId &&
                result.boolean('running') === false &&
                result.boolean('treeRunning') !== true
            ) {
                this.#programs.delete(run.processId);
            }
        }
    }

    /** 1-based labels follow first appearance; a returning agent keeps its label while it stays remembered. */
    #agent(jobId: string): number {
        const known: number | undefined = this.#agents.get(jobId);
        if (known !== undefined) {
            this.#agents.delete(jobId);
            this.#agents.set(jobId, known);
            return known;
        }
        const label: number = this.#nextAgent;
        this.#nextAgent += 1;
        this.#agents.set(jobId, label);
        if (this.#agents.size > ConnectorActivityFeed.agentLimit) {
            const oldest: string | undefined = this.#agents.keys().next().value;
            if (oldest !== undefined) {
                this.#agents.delete(oldest);
            }
        }
        return label;
    }

    #changed(): void {
        if (this.#notifying || this.#listeners.size === 0) {
            return;
        }
        this.#notifying = true;
        queueMicrotask((): void => this.#notify());
    }

    /**
     * Calls every current listener once.
     *
     * @remarks
     * A listener runs in its own microtask, so a throw would otherwise become an uncaught exception that stops
     * the connector. Each failure is caught and kept as {@link ConnectorActivityFeed.listenerFailure} instead;
     * the remaining listeners still run and the request that caused the change is unaffected.
     */
    #notify(): void {
        this.#notifying = false;
        for (const listener of Array.from(this.#listeners)) {
            try {
                listener();
            } catch (caught: unknown) {
                this.#listenerFailure =
                    caught instanceof Error
                        ? caught
                        : new Error('Activity listener failed', { cause: caught });
            }
        }
    }
}
