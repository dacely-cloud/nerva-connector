// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

import { Boundary } from 'nerva-connector-protocol/protocol/Boundary.js';
import {
    HostApplication,
    type HostApplicationResult,
    type HostDesktopFrame,
} from './HostApplication.js';
import { HostDesktopCommand } from './HostDesktopCommand.js';
import { HostDesktopError } from './HostDesktopError.js';
import { HostDesktopKeyChord } from './HostDesktopKeyChord.js';
import { HostDesktopWindowTarget } from './HostDesktopWindowTarget.js';
import { HostDesktopTextFieldOptions } from './HostDesktopTextFieldOptions.js';
import { HostWorkspaceValidation } from './HostWorkspaceValidation.js';
import {
    HostDesktopBackend,
    HostDesktopScope,
    HostDesktopUnavailable,
    HostDesktopLimits,
    HostDesktopKeyAction,
    type HostDesktopDriver,
    type HostDesktopInfo,
    type HostDesktopPointerRequest,
    type HostDesktopKeyRequest,
    type HostDesktopButton,
    type HostDesktopTextField,
} from './HostDesktopTypes.js';

/** A caller-verified compiled Win32 helper performs bounded desktop operations in the current interactive session. */
export class HostDesktopWindows implements HostDesktopDriver {
    readonly #keys: Map<string, string> = new Map();
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

    /** Native Start menu resolution and one screen capture share the same bounded callback. */
    public async openApplication(
        name: string,
        url?: string,
        workspaceFile?: string,
    ): Promise<HostApplicationResult> {
        let address: string | undefined;
        if (url !== undefined) {
            try {
                address = HostApplication.address(url);
            } catch {
                throw new HostDesktopError('application-open', 'application-browser-url', null);
            }
        }
        const raw: unknown = JSON.parse(
            (
                await this.#run(
                    {
                        operation: 'application-open',
                        name,
                        ...(address === undefined ? {} : { url: address }),
                        ...(workspaceFile === undefined ? {} : { workspaceFile }),
                    },
                    HostDesktopLimits.resultBytes,
                )
            ).toString('utf8'),
        );
        return HostApplication.result(raw);
    }

    /** Read a desktop image directly, without creating an artifact or selecting a workspace. */
    public async snapshot(): Promise<HostDesktopFrame> {
        const raw: unknown = JSON.parse(
            (await this.#run({ operation: 'snapshot' }, HostDesktopLimits.resultBytes)).toString(
                'utf8',
            ),
        );
        return HostApplication.frame(raw);
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
        let key: string;
        try {
            key = HostDesktopKeyChord.read(request.key, request.action);
        } catch {
            throw new HostDesktopError('key', 'key-chord', 0);
        }
        const owned: string | undefined = this.#keys.get(key);
        if (request.action === HostDesktopKeyAction.Up && request.target === undefined) {
            if (owned === undefined) {
                throw new HostDesktopError('key', 'keyboard-owned-input-changed', 0);
            }
            await this.#run({ operation: 'key-release', key }, 4096);
            this.#keys.delete(key);
            return;
        }
        const target: string = this.#target(request.target, 'key');
        if ([...this.#keys.values()].some((heldTarget: string): boolean => heldTarget !== target)) {
            throw new HostDesktopError('key', 'keyboard-owned-input-changed', 0);
        }
        if (
            (request.action === HostDesktopKeyAction.Up && owned !== target) ||
            (request.action === HostDesktopKeyAction.Down && owned !== undefined)
        ) {
            throw new HostDesktopError('key', 'keyboard-owned-input-changed', 0);
        }
        const held: string = [...this.#keys.keys()]
            .filter((entry: string): boolean => HostDesktopKeyChord.modifiers.includes(entry))
            .join(',');
        if (request.action === HostDesktopKeyAction.Down) {
            this.#keys.set(key, target);
        }
        try {
            await this.#run({ operation: 'key', key, action: request.action, target, held }, 4096);
        } catch (error: unknown) {
            if (
                request.action === HostDesktopKeyAction.Down &&
                error instanceof HostDesktopError &&
                error.definitive
            ) {
                this.#keys.delete(key);
            }
            throw error;
        }
        if (request.action === HostDesktopKeyAction.Up) {
            this.#keys.delete(key);
        }
    }

    /** Exact accessibility fields use verified replacement; otherwise Unicode uses guarded foreground input. */
    public async text(text: string, requested?: string, requestedField?: HostDesktopTextField): Promise<void> {
        const target: string = this.#target(requested, 'text');
        const field: HostDesktopTextField | undefined = HostDesktopTextFieldOptions.read(requestedField?.field, requestedField?.replace);
        if (typeof text !== 'string' || text.includes('\0') || Buffer.byteLength(text) > 16384) {
            throw new HostDesktopError('text', 'keyboard-text-invalid', 0);
        }
        if (field === undefined && this.#keys.size > 0) {
            throw new HostDesktopError('text', 'keyboard-key-active', 0);
        }
        await this.#run({ operation: 'text', text, target, ...(field ?? {}) }, 4096);
    }

    #target(raw: string | undefined, operation: string): string {
        if (raw === undefined) {
            throw new HostDesktopError(operation, 'keyboard-target-required', 0);
        }
        try {
            return HostDesktopWindowTarget.read(raw);
        } catch {
            throw new HostDesktopError(operation, 'keyboard-target-invalid', 0);
        }
    }

    async #run(
        request: Readonly<Record<string, string | number | boolean | null>>,
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
