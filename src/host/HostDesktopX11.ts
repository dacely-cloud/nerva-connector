// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

import { HostDesktopCommand } from './HostDesktopCommand.js';
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

/** Installed X11 utilities provide ordinary desktop interaction without accessing another display session. */
export class HostDesktopX11 implements HostDesktopDriver {
    public constructor(public readonly environment: NodeJS.ProcessEnv) {}

    /** Probe the actual X11 connection and fixed installed dependencies; Wayland alone is explicit unsupported state. */
    public async info(): Promise<HostDesktopInfo> {
        if (process.platform !== 'linux') {
            return this.#unavailable(HostDesktopUnavailable.Unsupported);
        }
        if (this.environment['WAYLAND_DISPLAY']) {
            return this.#unavailable(HostDesktopUnavailable.Unsupported);
        }
        if (!this.environment['DISPLAY']) {
            return this.#unavailable(HostDesktopUnavailable.NoDisplay);
        }
        if (
            !(await HostDesktopCommand.installed('xdotool', this.environment)) ||
            !(await HostDesktopCommand.installed('import', this.environment))
        ) {
            return this.#unavailable(HostDesktopUnavailable.MissingTools);
        }
        try {
            const output: string = (
                await HostDesktopCommand.run(
                    'xdotool',
                    ['getdisplaygeometry'],
                    this.environment,
                    4096,
                )
            )
                .toString('utf8')
                .trim();
            const matches: RegExpMatchArray | null = /^(\d{1,5}) (\d{1,5})$/u.exec(output);
            if (matches === null) {
                throw new Error('Invalid X11 desktop geometry');
            }
            return {
                platform: process.platform,
                backend: HostDesktopBackend.X11,
                scope: HostDesktopScope.Desktop,
                prerequisites: [],
                available: true,
                reason: null,
                x: 0,
                y: 0,
                width: HostWorkspaceValidation.count(Number(matches[1]), 1, 65535),
                height: HostWorkspaceValidation.count(Number(matches[2]), 1, 65535),
            };
        } catch {
            return this.#unavailable(HostDesktopUnavailable.Unavailable);
        }
    }

    /** Disable ImageMagick disk/map caches; PNG bytes remain bounded in the caller's pipe. */
    public async capture(maximumWidth: number, maximumHeight: number): Promise<Buffer> {
        return await HostDesktopCommand.run(
            'import',
            [
                '-limit',
                'memory',
                '256MiB',
                '-limit',
                'map',
                '0',
                '-limit',
                'disk',
                '0',
                '-window',
                'root',
                '-resize',
                maximumWidth.toString() + 'x' + maximumHeight.toString() + '>',
                'png:-',
            ],
            this.environment,
            HostDesktopLimits.imageBytes,
        );
    }

    /** Coordinates remain physical full-desktop pixels and button actions use argument vectors. */
    public async pointer(request: HostDesktopPointerRequest): Promise<void> {
        const arguments_: string[] = [
            'mousemove',
            '--sync',
            request.x.toString(),
            request.y.toString(),
        ];
        if (request.action !== HostDesktopPointerAction.Move) {
            arguments_.push(
                request.action === HostDesktopPointerAction.Click
                    ? 'click'
                    : request.action === HostDesktopPointerAction.Down
                      ? 'mousedown'
                      : 'mouseup',
                this.#button(request.button),
            );
        }
        await HostDesktopCommand.run('xdotool', arguments_, this.environment, 4096);
    }

    /** Cleanup releases a button at the actual pointer position. */
    public async releaseButton(button: HostDesktopButton): Promise<void> {
        await HostDesktopCommand.run(
            'xdotool',
            ['mouseup', this.#button(button)],
            this.environment,
            4096,
        );
    }

    /** Canonical key names map to X11 names without permitting arbitrary key-expression syntax. */
    public async key(request: HostDesktopKeyRequest): Promise<void> {
        const keys: Readonly<Record<string, string>> = {
            Control: 'ctrl',
            Alt: 'alt',
            Shift: 'shift',
            Meta: 'Super_L',
            Enter: 'Return',
            Escape: 'Escape',
            Backspace: 'BackSpace',
            PageUp: 'Prior',
            PageDown: 'Next',
            Space: 'space',
        };
        await HostDesktopCommand.run(
            'xdotool',
            [
                request.action === HostDesktopKeyAction.Press
                    ? 'key'
                    : request.action === HostDesktopKeyAction.Down
                      ? 'keydown'
                      : 'keyup',
                keys[request.key] ?? request.key,
            ],
            this.environment,
            4096,
        );
    }

    /** Unicode text is supplied as stdin data, preserving spaces and punctuation without shell interpretation. */
    public async text(text: string): Promise<void> {
        await HostDesktopCommand.run(
            'xdotool',
            ['type', '--clearmodifiers', '--delay', '0', '--file', '-'],
            this.environment,
            4096,
            text,
        );
    }

    #button(button: HostDesktopButton | null): string {
        return button === HostDesktopButton.Left
            ? '1'
            : button === HostDesktopButton.Middle
              ? '2'
              : '3';
    }

    #unavailable(reason: HostDesktopUnavailable): HostDesktopInfo {
        return {
            platform: process.platform,
            backend: HostDesktopBackend.Unavailable,
            scope: HostDesktopScope.Desktop,
            prerequisites: [],
            available: false,
            reason,
            x: 0,
            y: 0,
            width: 0,
            height: 0,
        };
    }
}
