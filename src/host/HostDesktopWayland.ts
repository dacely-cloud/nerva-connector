// SPDX-FileCopyrightText: 2026 Dacely <business@dacely.com>
// SPDX-License-Identifier: LicenseRef-Proprietary

import { HostDesktopCommand } from './HostDesktopCommand.js';
import { HostDesktopWaylandChannel } from './HostDesktopWaylandChannel.js';
import {
    HostDesktopBackend,
    HostDesktopScope,
    HostDesktopUnavailable,
    type HostDesktopInfo,
    type HostDesktopDriver,
    type HostDesktopPointerRequest,
    type HostDesktopKeyRequest,
} from './HostDesktopTypes.js';
import {
    HostDesktopWaylandOperation,
    HostDesktopWaylandResultKind,
    type HostDesktopWaylandResult,
    type HostDesktopWaylandInfo,
} from './HostDesktopWaylandProtocol.js';
import type { ConnectorHostPointerButton } from 'nerva-connector-protocol/protocol/ConnectorHostArgumentChoices.js';

/** Wayland uses one user-approved portal session for one monitor, never XWayland or privileged input injection. */
export class HostDesktopWayland implements HostDesktopDriver, AsyncDisposable {
    #channel: HostDesktopWaylandChannel | null = null;
    #closed: boolean = false;
    #creation: Promise<HostDesktopWaylandChannel> | null = null;

    public constructor(readonly environment: NodeJS.ProcessEnv) {}

    /** Discovery checks installed prerequisites only; actual authorized operations can open the system consent dialog once. */
    public async info(allowConsent: boolean = false): Promise<HostDesktopInfo> {
        if (this.#closed) {
            return this.#information(false, HostDesktopUnavailable.SessionClosed, [], 0, 0);
        }
        if (!(await HostDesktopCommand.installed('python3', this.environment))) {
            return this.#information(
                false,
                HostDesktopUnavailable.MissingTools,
                ['Python 3 with PyGObject Gio 2.0 and GStreamer 1.0 bindings'],
                0,
                0,
            );
        }
        this.#creation ??= HostDesktopWaylandChannel.create(this.environment);
        const channel: HostDesktopWaylandChannel = await this.#creation;
        if (this.#closed) {
            await channel[Symbol.asyncDispose]();
            throw new Error('Wayland portal session closed during helper creation');
        }
        this.#channel = channel;
        let result: HostDesktopWaylandResult = await this.#channel.request({
            operation: HostDesktopWaylandOperation.Probe,
        });
        if (result.kind !== HostDesktopWaylandResultKind.Info) {
            throw new Error('Wayland discovery result mismatch');
        }
        if (allowConsent && result.reason === HostDesktopUnavailable.ConsentRequired) {
            result = await this.#channel.request({ operation: HostDesktopWaylandOperation.Open });
            if (result.kind !== HostDesktopWaylandResultKind.Info) {
                throw new Error('Wayland consent result mismatch');
            }
        }
        const info: HostDesktopWaylandInfo = result;
        return this.#information(
            info.ready,
            info.reason,
            info.prerequisites,
            info.width,
            info.height,
        );
    }

    /** Return fresh bounded pixels from the pinned stream; resolution changes invalidate its coordinate mapping. */
    public async capture(maximumWidth: number, maximumHeight: number): Promise<Buffer> {
        const result: HostDesktopWaylandResult = await this.#active().request({
            operation: HostDesktopWaylandOperation.Capture,
            maximumWidth,
            maximumHeight,
        });
        if (result.kind !== HostDesktopWaylandResultKind.Capture) {
            throw new Error('Wayland capture result mismatch');
        }
        return result.png;
    }

    /** Physical selected-monitor coordinates are mapped to the portal's logical stream coordinates by the helper. */
    public async pointer(pointer: HostDesktopPointerRequest): Promise<void> {
        this.#sent(
            await this.#active().request({
                operation: HostDesktopWaylandOperation.Pointer,
                pointer,
            }),
        );
    }

    /** Release only an owned ordinary button without moving the current pointer. */
    public async releaseButton(button: ConnectorHostPointerButton): Promise<void> {
        this.#sent(
            await this.#active().request({
                operation: HostDesktopWaylandOperation.ReleaseButton,
                button,
            }),
        );
    }

    /** Named keys are sent through the consented RemoteDesktop keyboard API. */
    public async key(key: HostDesktopKeyRequest): Promise<void> {
        this.#sent(
            await this.#active().request({ operation: HostDesktopWaylandOperation.Key, key }),
        );
    }

    /** Unicode scalar values become explicit keysyms; controls and unpaired surrogates are rejected before effects. */
    public async text(text: string): Promise<void> {
        this.#sent(
            await this.#active().request({ operation: HostDesktopWaylandOperation.Text, text }),
        );
    }

    /** The portal session and its private D-Bus connection close before this retained owner is released. */
    public async [Symbol.asyncDispose](): Promise<void> {
        this.#closed = true;
        const channel: HostDesktopWaylandChannel | null = this.#channel ?? (await this.#creation);
        await channel?.[Symbol.asyncDispose]();
    }

    #active(): HostDesktopWaylandChannel {
        if (this.#closed || this.#channel === null) {
            throw new Error('Wayland portal session unavailable');
        }
        return this.#channel;
    }

    #information(
        available: boolean,
        reason: HostDesktopUnavailable | null,
        prerequisites: readonly string[],
        width: number,
        height: number,
    ): HostDesktopInfo {
        return {
            platform: 'linux',
            backend: HostDesktopBackend.WaylandPortal,
            scope: HostDesktopScope.SelectedMonitor,
            prerequisites,
            available,
            reason,
            x: 0,
            y: 0,
            width,
            height,
        };
    }

    #sent(result: HostDesktopWaylandResult): void {
        if (result.kind !== HostDesktopWaylandResultKind.Sent) {
            throw new Error('Wayland input result mismatch');
        }
    }
}
