// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

import { ConnectorHostLimits } from '../protocol/ConnectorHost.js';

/** Desktop backends describe actual session mechanisms, without assuming every machine has a GUI. */
export const HostDesktopBackend = {
    X11: 'x11',
    Windows: 'win32',
    WaylandPortal: 'wayland-portal',
    MacOs: 'macos',
    Unavailable: 'unavailable',
} as const;
/** Runtime-accessible backend names. */
export type HostDesktopBackend = (typeof HostDesktopBackend)[keyof typeof HostDesktopBackend];

/** Explicit unavailable states let agents select another linked computer. */
export const HostDesktopUnavailable = {
    NoDisplay: 'no-display',
    MissingTools: 'missing-tools',
    Unavailable: 'unavailable',
    Unsupported: 'unsupported',
    ConsentRequired: 'consent-required',
    ConsentDenied: 'consent-denied',
    SessionClosed: 'session-closed',
} as const;
/** Runtime-accessible desktop availability reasons. */
export type HostDesktopUnavailable =
    (typeof HostDesktopUnavailable)[keyof typeof HostDesktopUnavailable];

/** Portal sharing covers the exact selected monitor rather than an assumed entire Wayland desktop. */
export const HostDesktopScope = {
    Desktop: 'desktop',
    SelectedMonitor: 'selected-monitor',
} as const;
/** Runtime scope values describe the coordinate surface and never grant additional authority. */
export type HostDesktopScope = (typeof HostDesktopScope)[keyof typeof HostDesktopScope];

/** Physical desktop coordinates are bounded integers and may include negative monitor origins. */
export interface HostDesktopInfo {
    readonly platform: NodeJS.Platform;
    readonly backend: HostDesktopBackend;
    readonly scope: HostDesktopScope;
    readonly prerequisites: readonly string[];
    readonly available: boolean;
    readonly reason: HostDesktopUnavailable | null;
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
}

/** An intentional PNG artifact is read through existing bounded file operations. */
export interface HostDesktopScreenshot {
    readonly path: string;
    readonly width: number;
    readonly height: number;
    readonly sizeBytes: bigint;
    /** Desktop geometry observed immediately before capture; desktop resize remains an external event. */
    readonly desktop: HostDesktopInfo;
}

/** Pointer actions include held buttons so desktop drag operations are expressible. */
export const HostDesktopPointerAction = {
    Move: 'move',
    Click: 'click',
    Down: 'down',
    Up: 'up',
} as const;
/** Runtime-accessible pointer actions. */
export type HostDesktopPointerAction =
    (typeof HostDesktopPointerAction)[keyof typeof HostDesktopPointerAction];

/** Button labels map to ordinary OS pointer buttons. */
export const HostDesktopButton = { Left: 'left', Middle: 'middle', Right: 'right' } as const;
/** Runtime-accessible button names. */
export type HostDesktopButton = (typeof HostDesktopButton)[keyof typeof HostDesktopButton];

/** Pointer coordinates refer to the reported physical scope, independent of screenshot scaling. */
export interface HostDesktopPointerRequest {
    readonly x: number;
    readonly y: number;
    readonly action: HostDesktopPointerAction;
    readonly button: HostDesktopButton | null;
}

/** Image pixels and the physical desktop they depict must be supplied together when clicking a scaled screenshot. */
export interface HostDesktopViewport {
    readonly width: number;
    readonly height: number;
    readonly sourceX: number;
    readonly sourceY: number;
    readonly sourceWidth: number;
    readonly sourceHeight: number;
}

/** Held modifiers can be combined with ordinary key presses and are released on session cleanup. */
export const HostDesktopKeyAction = { Press: 'press', Down: 'down', Up: 'up' } as const;
/** Runtime-accessible key actions. */
export type HostDesktopKeyAction = (typeof HostDesktopKeyAction)[keyof typeof HostDesktopKeyAction];

/** Keys accept ASCII letters/digits, F1-F12 and named navigation/modifier keys; Unicode uses text entry. */
export interface HostDesktopKeyRequest {
    readonly key: string;
    readonly action: HostDesktopKeyAction;
}

/** Desktop commands inherit the connector session unless an explicit local session environment is supplied. */
export interface HostDesktopOptions {
    readonly windowsLauncher?: string;
    readonly environment?: Readonly<Record<string, string>>;
}

/** Capture and command bounds constrain the connector's own buffers and native image allocations. */
export class HostDesktopLimits {
    /** UTF-8 JSON accommodates the bounded text payload even when every character requires escaping. */
    public static readonly inputBytes: number = 128 * 1024;
    /** Native source captures fit within a bounded 64 MiB pixel allocation. */
    public static readonly sourcePixels: number = 16 * 1024 * 1024;
    /** Image output never exceeds sixteen MiB plus bounded PNG framing. */
    public static readonly imageBytes: number = 16 * 1024 * 1024 + 65536;
    /** Images retain native pixels up to 4096 pixels on either axis. */
    public static readonly dimension: number = 4096;
    /** Inline JPEG images have a finite signed-receipt budget independent of PNG artifact size. */
    public static readonly inlineBytes: number = 640000;
    /** Canonical base64 encoding of the inline JPEG byte bound. */
    public static readonly inlineBase64: number = 853336;
    /** One native JSON callback includes its image plus bounded application metadata. */
    public static readonly resultBytes: number = ConnectorHostLimits.resultBytes;
    /** Desktop program invocations have a finite wall deadline. */
    public static readonly timeoutMs: number = 10000;
}

/** Platform drivers perform fixed desktop commands after the workspace owner authorizes an operation. */
export interface HostDesktopDriver {
    /** Discovery never opens a chooser; an authorized operation may explicitly request local portal consent. */
    info(allowConsent?: boolean): Promise<HostDesktopInfo>;
    /** Return bounded PNG bytes without retaining intermediate files. */
    capture(maximumWidth: number, maximumHeight: number): Promise<Buffer>;
    /** Apply an already validated pointer action. */
    pointer(request: HostDesktopPointerRequest): Promise<void>;
    /** Release an owned held button without moving the user's current pointer. */
    releaseButton(button: HostDesktopButton): Promise<void>;
    /** Apply an already validated key action. */
    key(request: HostDesktopKeyRequest): Promise<void>;
    /** Type bounded text as data. */
    text(text: string): Promise<void>;
    /** Persistent backends close their portal/session and join pending consent or capture before returning. */
    [Symbol.asyncDispose]?(): Promise<void>;
}
