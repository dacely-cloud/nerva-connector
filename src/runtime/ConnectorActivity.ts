// SPDX-FileCopyrightText: 2026 Dacely <business@dacely.com>
// SPDX-License-Identifier: LicenseRef-Proprietary

/** What a request does to this computer, grouped so a person can tell at a glance. */
export const ConnectorActivityKind = {
    /** Reading, inspecting or listing files and folders. */
    ReadFile: 'read-file',
    /** Creating, changing, moving or deleting files and folders. */
    ChangeFile: 'change-file',
    /** Starting, feeding, reading or stopping a program. */
    RunCommand: 'run-command',
    /** Using an interactive terminal session. */
    Terminal: 'terminal',
    /** Looking at the screen. */
    Screen: 'screen',
    /** Moving the mouse, clicking or typing. */
    Control: 'control',
    /** Network lookups and web requests. */
    Web: 'web',
    /** Reading hardware, installed programs or settings. */
    System: 'system',
} as const;
/** Activity kinds derive from their runtime mapping. */
export type ConnectorActivityKind =
    (typeof ConnectorActivityKind)[keyof typeof ConnectorActivityKind];

/** Where one request is in its lifetime. */
export const ConnectorActivityState = {
    Running: 'running',
    Done: 'done',
    Failed: 'failed',
    Unconfirmed: 'unconfirmed',
} as const;
/** Activity states derive from their runtime mapping. */
export type ConnectorActivityState =
    (typeof ConnectorActivityState)[keyof typeof ConnectorActivityState];

/** One request Nexa made on this computer, described in plain words for the local screen only. */
export interface ConnectorActivityEntry {
    /** Increases by one for every request in this process. */
    readonly id: number;
    /** 1-based label of the requesting agent, in order of first appearance in this process. */
    readonly agent: number;
    readonly kind: ConnectorActivityKind;
    /** A short plain sentence such as "Reading a file". */
    readonly title: string;
    /** What it acts on, such as a path or a command line; sanitized and at most 2000 characters, or empty. */
    readonly subject: string;
    readonly state: ConnectorActivityState;
    /** Wall-clock milliseconds when the request started. */
    readonly startedAtMs: number;
    /** Wall-clock milliseconds when it finished, or `null` while running. */
    readonly endedAtMs: number | null;
}

/** A program or terminal Nexa started that is still running in the background. */
export interface ConnectorActivityProgram {
    /** The runtime's opaque process identifier. */
    readonly id: string;
    readonly agent: number;
    /** Started as an interactive terminal rather than a plain program. */
    readonly terminal: boolean;
    /** The command line it was started with; sanitized and at most 2000 characters. */
    readonly subject: string;
    readonly startedAtMs: number;
}

/** A consistent copy of the feed for one repaint. */
export interface ConnectorActivitySnapshot {
    /** Requests in progress, oldest first. */
    readonly running: readonly ConnectorActivityEntry[];
    /** Finished requests, newest first, at most 100. */
    readonly recent: readonly ConnectorActivityEntry[];
    /** Background programs and terminals still running, oldest first. */
    readonly programs: readonly ConnectorActivityProgram[];
    /** Requests handled since the connector started. */
    readonly total: number;
}

/** One request as it reaches a runtime lane, before any local effect. */
export interface ConnectorActivitySource {
    /** The account job that sent the request; identifies one agent. */
    readonly jobId: string;
    /** The host tool name, or the lane's own operation name. */
    readonly toolName: string;
    /** The request's raw JSON arguments; read defensively and never shown verbatim. */
    readonly argumentsJson: string;
}

/** Completes one started request. */
export interface ConnectorActivityHandle {
    /**
     * Records the outcome.
     *
     * @param succeeded - The request completed successfully
     * @param resultJson - The successful result, used only to track background programs
     */
    finish(succeeded: boolean, resultJson: string | null): void;
}

/** Receives requests from the runtime lanes; recording never throws and never changes a request. */
export interface ConnectorActivitySink {
    /** Records a request that is about to run. */
    begin(source: ConnectorActivitySource): ConnectorActivityHandle;
    /** Records that a program or terminal the lanes started has ended, so the screen stops listing it. */
    ended(processId: string): void;
}

/** What the screen reads: a snapshot, plus change notifications. */
export interface ConnectorActivityView {
    /** A consistent copy for one repaint. */
    snapshot(): ConnectorActivitySnapshot;
    /**
     * Calls `listener` after every change.
     *
     * @returns Stops the notifications
     */
    subscribe(listener: () => void): () => void;
}
