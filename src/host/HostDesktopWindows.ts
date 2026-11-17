// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

import { Boundary } from 'nerva-connector-protocol/protocol/Boundary.js';
import { HostDesktopCommand } from './HostDesktopCommand.js';
import { HostWorkspaceValidation } from './HostWorkspaceValidation.js';
import {
    HostDesktopBackend,
    HostDesktopScope,
    HostDesktopUnavailable,
    HostDesktopLimits,
    type HostDesktopDriver,
    type HostDesktopInfo,
    type HostDesktopPointerRequest,
    type HostDesktopKeyRequest,
    type HostDesktopButton,
} from './HostDesktopTypes.js';

/** A caller-verified compiled Win32 helper performs bounded desktop operations in the current interactive session. */
export class HostDesktopWindows implements HostDesktopDriver {
    public constructor(
        public readonly executable: string | undefined,
        public readonly environment: NodeJS.ProcessEnv,
    ) {}

    /** Native observation rejects service/locked/unavailable desktops instead of inventing GUI availability. */
    public async info(): Promise<HostDesktopInfo> {
        if (this.executable === undefined) {
            return {
                platform: process.platform,
                backend: HostDesktopBackend.Unavailable,
                scope: HostDesktopScope.Desktop,
                prerequisites: [],
                available: false,
                reason: HostDesktopUnavailable.Unavailable,
                x: 0,
                y: 0,
                width: 0,
                height: 0,
            };
        }
        const raw: unknown = JSON.parse(
            (await this.#run({ operation: 'info' }, 4096)).toString('utf8'),
        );
        const value: Readonly<Record<string, unknown>> = Boundary.record(raw, [
            'available',
            'x',
            'y',
            'width',
            'height',
        ]);
        if (value['available'] !== true) {
            return {
                platform: process.platform,
                backend: HostDesktopBackend.Unavailable,
                scope: HostDesktopScope.Desktop,
                prerequisites: [],
                available: false,
                reason: HostDesktopUnavailable.Unavailable,
                x: 0,
                y: 0,
                width: 0,
                height: 0,
            };
        }
        return {
            platform: process.platform,
            backend: HostDesktopBackend.Windows,
            scope: HostDesktopScope.Desktop,
            prerequisites: [],
            available: true,
            reason: null,
            x: this.#coordinate(value['x']),
            y: this.#coordinate(value['y']),
            width: HostWorkspaceValidation.count(Boundary.count(value['width'], 65535), 1, 65535),
            height: HostWorkspaceValidation.count(Boundary.count(value['height'], 65535), 1, 65535),
        };
    }

    /** PNG output is decoded from the verified native helper without using temporary files. */
    public async capture(maximumWidth: number, maximumHeight: number): Promise<Buffer> {
        return await this.#run(
            { operation: 'screenshot', maximumWidth, maximumHeight },
            HostDesktopLimits.imageBytes,
        );
    }

    /** Win32 input uses explicit physical coordinates and named button actions. */
    public async pointer(request: HostDesktopPointerRequest): Promise<void> {
        await this.#run({ operation: 'pointer', ...request }, 4096);
    }

    /** Cleanup releases owned buttons without changing pointer position. */
    public async releaseButton(button: HostDesktopButton): Promise<void> {
        await this.#run({ operation: 'button-up', button }, 4096);
    }

    /** Named keys are translated to native virtual keys by the fixed helper. */
    public async key(request: HostDesktopKeyRequest): Promise<void> {
        await this.#run({ operation: 'key', ...request }, 4096);
    }

    /** UTF-16 input uses SendInput Unicode events, independent of keyboard layout. */
    public async text(text: string): Promise<void> {
        await this.#run({ operation: 'text', text }, 4096);
    }

    async #run(
        request: Readonly<Record<string, string | number | null>>,
        maximum: number,
    ): Promise<Buffer> {
        if (this.executable === undefined) {
            throw new Error('Verified Windows desktop helper unavailable');
        }
        return await HostDesktopCommand.run(
            this.executable,
            ['--desktop'],
            this.environment,
            maximum,
            JSON.stringify(request),
        );
    }

    #coordinate(value: unknown): number {
        if (typeof value !== 'number' || !Number.isSafeInteger(value) || Math.abs(value) > 65535) {
            throw new Error('Invalid desktop origin');
        }
        return value;
    }
}
