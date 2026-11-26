// SPDX-FileCopyrightText: 2026 Dacely <business@dacely.com>
// SPDX-License-Identifier: LicenseRef-Proprietary

import { mkdtemp, open, rm, type FileHandle } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HostDesktopCommand } from './HostDesktopCommand.js';
import { HostDesktopMacScript as Script } from './HostDesktopMacScript.js';
import { HostWorkspaceValidation } from './HostWorkspaceValidation.js';
import {
    HostDesktopBackend,
    HostDesktopScope,
    HostDesktopUnavailable,
    HostDesktopPointerAction,
    HostDesktopButton,
    HostDesktopKeyAction,
    HostDesktopLimits,
    type HostDesktopDriver,
    type HostDesktopInfo,
    type HostDesktopPointerRequest,
    type HostDesktopKeyRequest,
} from './HostDesktopTypes.js';

/** One display probe: geometry in points plus the two macOS privacy permissions desktop control needs. */
interface HostDesktopMacProbe {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
    readonly screen: boolean;
    readonly input: boolean;
}

/** CoreGraphics event numbers for one mouse button, from `CGEventTypes.h`. */
interface HostDesktopMacButtonEvents {
    readonly down: number;
    readonly up: number;
    readonly dragged: number;
    readonly button: number;
}

/**
 * Desktop control on macOS with programs every Mac already has.
 *
 * @remarks
 * `osascript` runs fixed JavaScript-for-Automation scripts that call CoreGraphics directly: the main
 * display's bounds, synthetic mouse and keyboard events, and Unicode typing. `screencapture` takes the
 * picture and `sips` scales it. Nothing is installed or compiled. Coordinates are the main display's
 * points, the same space CoreGraphics events use; screenshots report their own pixel size so a Retina
 * capture can be mapped back. macOS asks the user once for Screen Recording and Accessibility for the
 * app that runs the connector; until both are allowed the backend reports `consent-required`.
 */
export class HostDesktopMac implements HostDesktopDriver {
    static readonly #osascript: string = '/usr/bin/osascript';
    static readonly #screencapture: string = '/usr/sbin/screencapture';
    static readonly #sips: string = '/usr/bin/sips';
    /** Shift, Control, Option and Command masks from `CGEventFlags`. */
    static readonly #flags: Readonly<Record<string, number>> = {
        Shift: 0x20000,
        Control: 0x40000,
        Alt: 0x80000,
        Meta: 0x100000,
    };
    /** US-layout virtual key codes from `HIToolbox/Events.h`; text entry is layout independent. */
    static readonly #codes: Readonly<Record<string, number>> = {
        A: 0,
        S: 1,
        D: 2,
        F: 3,
        H: 4,
        G: 5,
        Z: 6,
        X: 7,
        C: 8,
        V: 9,
        B: 11,
        Q: 12,
        W: 13,
        E: 14,
        R: 15,
        Y: 16,
        T: 17,
        '1': 18,
        '2': 19,
        '3': 20,
        '4': 21,
        '6': 22,
        '5': 23,
        '9': 25,
        '7': 26,
        '8': 28,
        '0': 29,
        O: 31,
        U: 32,
        I: 34,
        P: 35,
        L: 37,
        J: 38,
        K: 40,
        N: 45,
        M: 46,
        Enter: 36,
        Tab: 48,
        Space: 49,
        Backspace: 51,
        Escape: 53,
        Meta: 55,
        Shift: 56,
        Alt: 58,
        Control: 59,
        F1: 122,
        F2: 120,
        F3: 99,
        F4: 118,
        F5: 96,
        F6: 97,
        F7: 98,
        F8: 100,
        F9: 101,
        F10: 109,
        F11: 103,
        F12: 111,
        Insert: 114,
        Home: 115,
        PageUp: 116,
        Delete: 117,
        End: 119,
        PageDown: 121,
        Left: 123,
        Right: 124,
        Down: 125,
        Up: 126,
    };
    static readonly #buttons: Readonly<Record<HostDesktopButton, HostDesktopMacButtonEvents>> = {
        [HostDesktopButton.Left]: { down: 1, up: 2, dragged: 6, button: 0 },
        [HostDesktopButton.Right]: { down: 3, up: 4, dragged: 7, button: 1 },
        [HostDesktopButton.Middle]: { down: 25, up: 26, dragged: 27, button: 2 },
    };
    /** `kCGEventMouseMoved`. */
    static readonly #moved: number = 5;
    readonly #held: Set<HostDesktopButton> = new Set();
    readonly #modifiers: Set<string> = new Set();
    #prompted: boolean = false;

    public constructor(public readonly environment: NodeJS.ProcessEnv) {}

    /**
     * The main display and whether macOS currently allows screen capture and synthetic input.
     *
     * @param allowConsent - An authorized operation may show the system permission prompts, once per session
     */
    public async info(allowConsent: boolean = false): Promise<HostDesktopInfo> {
        if (process.platform !== 'darwin') {
            return this.#unavailable(HostDesktopUnavailable.Unsupported, []);
        }
        const prompt: boolean = allowConsent && !this.#prompted;
        let probe: HostDesktopMacProbe;
        try {
            probe = HostDesktopMac.#probe(
                await this.#script(Script.info, [prompt ? 'prompt' : 'check']),
            );
        } catch {
            return this.#unavailable(HostDesktopUnavailable.Unavailable, []);
        }
        if (prompt && (!probe.screen || !probe.input)) {
            this.#prompted = true;
        }
        if (probe.width === 0 || probe.height === 0) {
            return this.#unavailable(HostDesktopUnavailable.NoDisplay, []);
        }
        const missing: readonly string[] = [
            ...(probe.screen
                ? []
                : [
                      'Screen Recording: System Settings › Privacy & Security › Screen & System Audio Recording, allow the app that runs the connector, then restart the connector',
                  ]),
            ...(probe.input
                ? []
                : [
                      'Accessibility: System Settings › Privacy & Security › Accessibility, allow the app that runs the connector',
                  ]),
        ];
        return {
            platform: process.platform,
            backend: HostDesktopBackend.MacOs,
            scope: HostDesktopScope.SelectedMonitor,
            prerequisites: missing,
            available: missing.length === 0,
            reason: missing.length === 0 ? null : HostDesktopUnavailable.ConsentRequired,
            x: probe.x,
            y: probe.y,
            width: probe.width,
            height: probe.height,
        };
    }

    /** Capture the main display to a private temporary file, scale it to fit, and return the PNG bytes. */
    public async capture(maximumWidth: number, maximumHeight: number): Promise<Buffer> {
        const directory: string = await mkdtemp(join(tmpdir(), 'nerva-desktop-'));
        try {
            const file: string = join(directory, 'capture.png');
            await HostDesktopCommand.run(
                HostDesktopMac.#screencapture,
                ['-x', '-m', '-t', 'png', file],
                this.environment,
                4096,
            );
            const [width, height]: readonly [number, number] = await HostDesktopMac.#size(file);
            const scale: number = Math.min(1, maximumWidth / width, maximumHeight / height);
            if (scale < 1) {
                await HostDesktopCommand.run(
                    HostDesktopMac.#sips,
                    [
                        '-z',
                        Math.min(maximumHeight, Math.max(1, Math.round(height * scale))).toString(),
                        Math.min(maximumWidth, Math.max(1, Math.round(width * scale))).toString(),
                        file,
                    ],
                    this.environment,
                    65536,
                );
            }
            return await HostDesktopMac.#read(file);
        } finally {
            await rm(directory, { recursive: true, force: true });
        }
    }

    /** Moves become drags while a button is held, as macOS applications expect. */
    public async pointer(request: HostDesktopPointerRequest): Promise<void> {
        const events: number[] = [];
        if (request.action === HostDesktopPointerAction.Move || request.button === null) {
            const held: HostDesktopButton | undefined = this.#held.values().next().value;
            events.push(
                ...(held === undefined
                    ? [HostDesktopMac.#moved, 0]
                    : [
                          HostDesktopMac.#buttons[held].dragged,
                          HostDesktopMac.#buttons[held].button,
                      ]),
            );
        } else {
            const button: HostDesktopMacButtonEvents = HostDesktopMac.#buttons[request.button];
            if (request.action !== HostDesktopPointerAction.Up) {
                events.push(button.down, button.button);
            }
            if (request.action !== HostDesktopPointerAction.Down) {
                events.push(button.up, button.button);
            }
            if (request.action === HostDesktopPointerAction.Down) {
                this.#held.add(request.button);
            } else {
                this.#held.delete(request.button);
            }
        }
        await this.#script(Script.pointer, [
            request.x.toString(),
            request.y.toString(),
            ...events.map((value: number): string => value.toString()),
        ]);
    }

    /** Release a held button where the pointer is now, without moving it. */
    public async releaseButton(button: HostDesktopButton): Promise<void> {
        const events: HostDesktopMacButtonEvents = HostDesktopMac.#buttons[button];
        await this.#script(Script.pointer, [
            'here',
            'here',
            events.up.toString(),
            events.button.toString(),
        ]);
        this.#held.delete(button);
    }

    /** Named keys become virtual key codes; held modifiers apply to every later key until released. */
    public async key(request: HostDesktopKeyRequest): Promise<void> {
        const code: number | undefined =
            HostDesktopMac.#codes[
                /^[a-z]$/u.test(request.key) ? request.key.toUpperCase() : request.key
            ];
        if (code === undefined) {
            throw new Error('Unsupported desktop key');
        }
        const modifier: number | undefined = HostDesktopMac.#flags[request.key];
        const extra: number = /^[A-Z]$/u.test(request.key)
            ? (HostDesktopMac.#flags['Shift'] ?? 0)
            : 0;
        const events: string[] = [];
        if (request.action !== HostDesktopKeyAction.Up) {
            if (modifier !== undefined) {
                this.#modifiers.add(request.key);
            }
            events.push(code.toString(), '1', (this.#mask() | extra).toString());
        }
        if (request.action !== HostDesktopKeyAction.Down) {
            if (modifier !== undefined) {
                this.#modifiers.delete(request.key);
            }
            events.push(code.toString(), '0', (this.#mask() | extra).toString());
        }
        await this.#script(Script.key, events);
    }

    /** Text is read from standard input and typed one character at a time, independent of the keyboard layout. */
    public async text(text: string): Promise<void> {
        await this.#script(Script.text, [], text);
    }

    #mask(): number {
        let mask: number = 0;
        for (const key of this.#modifiers) {
            mask |= HostDesktopMac.#flags[key] ?? 0;
        }
        return mask;
    }

    async #script(source: string, arguments_: readonly string[], input?: string): Promise<Buffer> {
        return await HostDesktopCommand.run(
            HostDesktopMac.#osascript,
            ['-l', 'JavaScript', '-e', source, ...arguments_],
            this.environment,
            65536,
            input,
        );
    }

    static #probe(output: Buffer): HostDesktopMacProbe {
        const raw: unknown = JSON.parse(output.toString('utf8'));
        if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
            throw new Error('Invalid macOS display probe');
        }
        const value: Readonly<Record<string, unknown>> = Object.fromEntries(Object.entries(raw));
        const number: (key: string, minimum: number) => number = (
            key: string,
            minimum: number,
        ): number => {
            const field: unknown = value[key];
            if (typeof field !== 'number' || !Number.isFinite(field)) {
                throw new Error('Invalid macOS display probe');
            }
            return HostWorkspaceValidation.count(Math.round(field), minimum, 65535);
        };
        if (typeof value['screen'] !== 'boolean' || typeof value['input'] !== 'boolean') {
            throw new Error('Invalid macOS display probe');
        }
        return {
            x: number('x', -65535),
            y: number('y', -65535),
            width: number('width', 0),
            height: number('height', 0),
            screen: value['screen'],
            input: value['input'],
        };
    }

    /** Width and height from the PNG header, read without loading a full-resolution capture. */
    static async #size(file: string): Promise<readonly [number, number]> {
        const handle: FileHandle = await open(file, 'r');
        try {
            const header: Buffer = Buffer.alloc(24);
            const result: Awaited<ReturnType<FileHandle['read']>> = await handle.read(
                header,
                0,
                24,
                0,
            );
            if (result.bytesRead !== 24 || header.toString('ascii', 12, 16) !== 'IHDR') {
                throw new Error('Screen capture is not a PNG image');
            }
            return [
                HostWorkspaceValidation.count(header.readUInt32BE(16), 1, 65535),
                HostWorkspaceValidation.count(header.readUInt32BE(20), 1, 65535),
            ];
        } finally {
            await handle.close();
        }
    }

    static async #read(file: string): Promise<Buffer> {
        const handle: FileHandle = await open(file, 'r');
        try {
            const size: number = (await handle.stat()).size;
            if (size < 1 || size > HostDesktopLimits.imageBytes) {
                throw new Error('Screen capture exceeds its bound');
            }
            const bytes: Buffer = Buffer.alloc(size);
            const result: Awaited<ReturnType<FileHandle['read']>> = await handle.read(
                bytes,
                0,
                size,
                0,
            );
            if (result.bytesRead !== size) {
                throw new Error('Screen capture changed while it was read');
            }
            return bytes;
        } finally {
            await handle.close();
        }
    }

    #unavailable(
        reason: HostDesktopUnavailable,
        prerequisites: readonly string[],
    ): HostDesktopInfo {
        return {
            platform: process.platform,
            backend: HostDesktopBackend.Unavailable,
            scope: HostDesktopScope.Desktop,
            prerequisites,
            available: false,
            reason,
            x: 0,
            y: 0,
            width: 0,
            height: 0,
        };
    }
}
