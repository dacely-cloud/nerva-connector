// SPDX-FileCopyrightText: 2026 Dacely <business@dacely.com>
// SPDX-License-Identifier: LicenseRef-Proprietary

import { HostWorkspaceValidation } from './HostWorkspaceValidation.js';
import { HostDesktopCapture } from './HostDesktopCapture.js';
import { HostDesktopCoordinates } from './HostDesktopCoordinates.js';
import { HostDesktopX11 } from './HostDesktopX11.js';
import { HostDesktopWayland } from './HostDesktopWayland.js';
import { HostDesktopWindows } from './HostDesktopWindows.js';
import { ConnectorHostKeyChord } from 'nerva-connector-protocol/protocol/ConnectorHostKeyChord.js';
import { HostDesktopError } from './HostDesktopError.js';
import type { HostApplicationResult, HostDesktopFrame } from './HostApplication.js';
import { HostOperationError } from './HostOperationError.js';
import { ConnectorHostErrorCode } from 'nerva-connector-protocol/protocol/ConnectorHost.js';
import { HostDesktopMac } from './HostDesktopMac.js';
import {
    HostDesktopLimits,
    type HostDesktopInfo,
    type HostDesktopScreenshot,
    type HostDesktopPointerRequest,
    type HostDesktopKeyRequest,
    type HostDesktopOptions,
    type HostDesktopDriver,
    type HostDesktopViewport,
    type HostDesktopTextField,
} from './HostDesktopTypes.js';
import {
    ConnectorHostKeyAction,
    ConnectorHostPointerAction,
    ConnectorHostPointerButton,
    ConnectorHostWriteMode,
} from 'nerva-connector-protocol/protocol/ConnectorHostArgumentChoices.js';

/** One desktop session owns held inputs and uses the connector user's actual interactive display. */
export class HostDesktop implements AsyncDisposable {
    readonly #driver: HostDesktopDriver;
    readonly #keys: Set<string> = new Set();
    readonly #buttons: Set<ConnectorHostPointerButton> = new Set();
    #closed: boolean = false;
    #disposal: Promise<void> | null = null;
    #pending: Promise<undefined> | null = null;

    public constructor(options: HostDesktopOptions) {
        const supplied: Readonly<Record<string, string>> = options.environment ?? {};
        if (
            Object.keys(supplied).length > 6 ||
            Object.entries(supplied).some(
                ([key, value]: [string, string]): boolean =>
                    ![
                        'DISPLAY',
                        'XAUTHORITY',
                        'WAYLAND_DISPLAY',
                        'XDG_RUNTIME_DIR',
                        'DBUS_SESSION_BUS_ADDRESS',
                        'PATH',
                    ].includes(key) ||
                    typeof value !== 'string' ||
                    value.includes('\0') ||
                    value.length > 32767,
            )
        ) {
            throw new Error('Invalid local desktop session environment');
        }
        const environment: NodeJS.ProcessEnv = { ...process.env, ...supplied };
        this.#driver =
            process.platform === 'win32'
                ? new HostDesktopWindows(options.windowsLauncher, environment)
                : process.platform === 'darwin'
                  ? new HostDesktopMac(environment)
                  : process.platform === 'linux' && (environment['WAYLAND_DISPLAY'] ?? '') !== ''
                    ? new HostDesktopWayland(environment)
                    : new HostDesktopX11(environment);
    }

    /** OS type alone never establishes that an interactive desktop is available. */
    public async info(): Promise<HostDesktopInfo> {
        return await this.#operate(async (): Promise<HostDesktopInfo> => {
            return await this.#driver.info();
        });
    }

    /** Launch exactly one installed Windows application without shell scripts, then capture the screen once. */
    public async openApplication(
        name: string,
        url?: string,
        workspaceFile?: string,
    ): Promise<HostApplicationResult> {
        return await this.#operate(async (): Promise<HostApplicationResult> => {
            this.#active();
            if (!(this.#driver instanceof HostDesktopWindows)) {
                throw new HostOperationError(
                    ConnectorHostErrorCode.Unsupported,
                    'Native application opening requires Windows',
                    true,
                );
            }
            return await this.#driver.openApplication(name, url, workspaceFile);
        });
    }

    /** Inline images are observations and retain no temporary files on the customer computer. */
    public async snapshot(): Promise<HostDesktopFrame> {
        return await this.#operate(async (): Promise<HostDesktopFrame> => {
            this.#active();
            if (!(this.#driver instanceof HostDesktopWindows)) {
                throw new HostOperationError(
                    ConnectorHostErrorCode.Unsupported,
                    'Inline desktop capture requires Windows',
                    true,
                );
            }
            return await this.#driver.snapshot();
        });
    }

    /** Capture retains one intentional PNG artifact for bounded file retrieval. */
    public async screenshot(
        path: string,
        mode: ConnectorHostWriteMode,
        maximumWidth: number,
        maximumHeight: number,
    ): Promise<HostDesktopScreenshot> {
        return await this.#operate(async (): Promise<HostDesktopScreenshot> => {
            this.#active();
            HostWorkspaceValidation.count(maximumWidth, 1, HostDesktopLimits.dimension);
            HostWorkspaceValidation.count(maximumHeight, 1, HostDesktopLimits.dimension);
            if (mode !== ConnectorHostWriteMode.Create && mode !== ConnectorHostWriteMode.Replace) {
                throw new Error('Desktop screenshots require create or replace mode');
            }
            const desktop: HostDesktopInfo = await this.#available();
            if (desktop.width * desktop.height > HostDesktopLimits.sourcePixels) {
                throw new Error('Desktop capture exceeds bounded source pixels');
            }
            const bytes: Buffer = await this.#driver.capture(maximumWidth, maximumHeight);
            return await HostDesktopCapture.save(
                path,
                mode,
                bytes,
                desktop,
                maximumWidth,
                maximumHeight,
            );
        });
    }

    /** Pointer ownership supports drags and cleanup of partially completed button effects. */
    public async pointer(
        input: HostDesktopPointerRequest,
        image: HostDesktopViewport | null = null,
    ): Promise<void> {
        return await this.#operate(async (): Promise<void> => {
            this.#active();
            const desktop: HostDesktopInfo = await this.#available();
            const request: HostDesktopPointerRequest = HostDesktopCoordinates.physical(
                input,
                desktop,
                image,
            );
            HostWorkspaceValidation.count(request.x, desktop.x, desktop.x + desktop.width - 1);
            HostWorkspaceValidation.count(request.y, desktop.y, desktop.y + desktop.height - 1);
            if (
                !Object.values(ConnectorHostPointerAction).includes(request.action) ||
                (request.action === ConnectorHostPointerAction.Move
                    ? request.button !== null
                    : request.button === null ||
                      !Object.values(ConnectorHostPointerButton).includes(request.button))
            ) {
                throw new Error('Invalid desktop pointer action');
            }
            if (
                (request.action === ConnectorHostPointerAction.Down ||
                    request.action === ConnectorHostPointerAction.Click) &&
                request.button !== null
            ) {
                this.#buttons.add(request.button);
            }
            await this.#driver.pointer(request);
            if (
                (request.action === ConnectorHostPointerAction.Click ||
                    request.action === ConnectorHostPointerAction.Up) &&
                request.button !== null
            ) {
                this.#buttons.delete(request.button);
            }
        });
    }

    /** Named keys avoid key-expression injection; press and hold effects are owned until release is confirmed. */
    public async key(request: HostDesktopKeyRequest): Promise<void> {
        return await this.#operate(async (): Promise<void> => {
            this.#active();
            await this.#available();
            const windows: boolean = this.#driver instanceof HostDesktopWindows;
            if (request.target !== undefined && !windows) {
                throw new HostOperationError(
                    ConnectorHostErrorCode.Unsupported,
                    'Window targets require Windows desktop input',
                    true,
                );
            }
            let key: string;
            try {
                key = windows
                    ? ConnectorHostKeyChord.read(request.key, request.action)
                    : this.#key(request.key);
            } catch (error: unknown) {
                if (windows) {
                    throw new HostDesktopError('key', 'key-chord', 0);
                }
                throw error;
            }
            if (!Object.values(ConnectorHostKeyAction).includes(request.action)) {
                throw new Error('Invalid desktop key action');
            }
            const owned: boolean = this.#keys.has(key);
            if (
                request.action === ConnectorHostKeyAction.Down ||
                (!windows && request.action === ConnectorHostKeyAction.Press)
            ) {
                this.#keys.add(key);
            }
            try {
                await this.#driver.key({ ...request, key });
            } catch (error: unknown) {
                if (!owned && error instanceof HostDesktopError && error.definitive) {
                    this.#keys.delete(key);
                }
                throw error;
            }
            if (
                request.action === ConnectorHostKeyAction.Press ||
                request.action === ConnectorHostKeyAction.Up
            ) {
                this.#keys.delete(key);
            }
        });
    }

    /** Unicode text is data and never interpreted as shell or key syntax. */
    public async text(text: string, target?: string, field?: HostDesktopTextField): Promise<void> {
        return await this.#operate(async (): Promise<void> => {
            this.#active();
            await this.#available();
            if (
                (target !== undefined || field !== undefined) &&
                !(this.#driver instanceof HostDesktopWindows)
            ) {
                throw new HostOperationError(
                    ConnectorHostErrorCode.Unsupported,
                    'Window targets require Windows desktop input',
                    true,
                );
            }
            if (
                typeof text !== 'string' ||
                text.includes('\0') ||
                Buffer.byteLength(text) > 16384
            ) {
                throw new Error('Desktop text exceeds limit');
            }
            await this.#driver.text(text, target, field);
        });
    }

    /** Held keys/buttons are released on session cleanup even after remote authorization is revoked. */
    public async [Symbol.asyncDispose](): Promise<void> {
        this.#disposal ??= this.#dispose();
        await this.#disposal;
    }

    async #dispose(): Promise<void> {
        this.#closed = true;
        const persistentClose: (() => Promise<void>) | undefined = this.#driver[
            Symbol.asyncDispose
        ]?.bind(this.#driver);
        if (persistentClose !== undefined) {
            try {
                await persistentClose();
            } finally {
                await this.#pending;
                this.#keys.clear();
                this.#buttons.clear();
            }
            return;
        }
        await this.#pending;
        const effects: Promise<void>[] = [
            ...Array.from(this.#keys, (key: string): Promise<void> =>
                this.#driver.key({ key, action: ConnectorHostKeyAction.Up }),
            ),
            ...Array.from(this.#buttons, (button: ConnectorHostPointerButton): Promise<void> =>
                this.#driver.releaseButton(button),
            ),
        ];
        const outcomes: readonly PromiseSettledResult<void>[] = await Promise.allSettled(effects);
        this.#keys.clear();
        this.#buttons.clear();
        if (
            outcomes.some(
                (outcome: PromiseSettledResult<void>): boolean => outcome.status === 'rejected',
            )
        ) {
            throw new Error('Desktop held-input release could not be confirmed');
        }
    }

    async #available(): Promise<HostDesktopInfo> {
        const info: HostDesktopInfo = await this.#driver.info(true);
        if (!info.available) {
            throw new Error('Interactive desktop unavailable: ' + (info.reason ?? 'unavailable'));
        }
        return info;
    }

    #key(key: string): string {
        if (!ConnectorHostKeyChord.single(key)) {
            throw new Error('Unsupported desktop key');
        }
        return key;
    }

    async #operate<T>(operation: () => Promise<T>): Promise<T> {
        this.#active();
        if (this.#pending !== null) {
            throw new Error('Desktop operation already active');
        }
        const pending: PromiseWithResolvers<undefined> = Promise.withResolvers<undefined>();
        this.#pending = pending.promise;
        try {
            return await operation();
        } finally {
            pending.resolve(undefined);
            this.#pending = null;
        }
    }

    #active(): void {
        if (this.#closed) {
            throw new Error('Desktop session closed');
        }
    }
}
