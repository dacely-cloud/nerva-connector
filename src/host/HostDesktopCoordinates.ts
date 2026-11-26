// SPDX-FileCopyrightText: 2026 Dacely <business@dacely.com>
// SPDX-License-Identifier: LicenseRef-Proprietary

import { Boundary } from 'nerva-connector-protocol/protocol/Boundary.js';
import { HostWorkspaceValidation } from './HostWorkspaceValidation.js';
import { HostDesktopError } from './HostDesktopError.js';
import {
    HostDesktopLimits,
    type HostDesktopInfo,
    type HostDesktopPointerRequest,
    type HostDesktopViewport,
} from './HostDesktopTypes.js';

/** Image-based actions are converted exactly once before reaching any native input driver. */
export class HostDesktopCoordinates {
    /** External screenshot geometry is a closed shape; origins may be negative on multi-monitor desktops. */
    public static read(raw: unknown): HostDesktopViewport {
        let value: Readonly<Record<string, unknown>>;
        try {
            value = Boundary.record(raw, [
                'width',
                'height',
                'sourceX',
                'sourceY',
                'sourceWidth',
                'sourceHeight',
            ]);
        } catch {
            throw new HostDesktopError('pointer', 'screenshot-geometry-invalid', null);
        }
        return {
            width: this.#integer(value['width'], 1, HostDesktopLimits.dimension),
            height: this.#integer(value['height'], 1, HostDesktopLimits.dimension),
            sourceX: this.#integer(value['sourceX'], -65535, 65535),
            sourceY: this.#integer(value['sourceY'], -65535, 65535),
            sourceWidth: this.#integer(value['sourceWidth'], 1, 65535),
            sourceHeight: this.#integer(value['sourceHeight'], 1, 65535),
        };
    }

    /** Pixel centers map to physical coordinates only while the screenshot's source still matches the current approved scope. */
    public static physical(
        request: HostDesktopPointerRequest,
        desktop: HostDesktopInfo,
        image: HostDesktopViewport | null,
    ): HostDesktopPointerRequest {
        if (image === null) {
            return request;
        }
        HostWorkspaceValidation.count(image.width, 1, HostDesktopLimits.dimension);
        HostWorkspaceValidation.count(image.height, 1, HostDesktopLimits.dimension);
        if (
            image.sourceX !== desktop.x ||
            image.sourceY !== desktop.y ||
            image.sourceWidth !== desktop.width ||
            image.sourceHeight !== desktop.height
        ) {
            throw new HostDesktopError('pointer', 'screenshot-geometry-changed', null);
        }
        if (
            !Number.isSafeInteger(request.x) ||
            !Number.isSafeInteger(request.y) ||
            request.x < 0 ||
            request.y < 0 ||
            request.x >= image.width ||
            request.y >= image.height
        ) {
            throw new HostDesktopError('pointer', 'pointer-outside-image', null);
        }
        return {
            ...request,
            x: desktop.x + Math.floor(((request.x + 0.5) * desktop.width) / image.width),
            y: desktop.y + Math.floor(((request.y + 0.5) * desktop.height) / image.height),
        };
    }

    static #integer(raw: unknown, minimum: number, maximum: number): number {
        if (
            typeof raw !== 'number' ||
            !Number.isSafeInteger(raw) ||
            raw < minimum ||
            raw > maximum
        ) {
            throw new HostDesktopError('pointer', 'screenshot-geometry-invalid', null);
        }
        return raw;
    }
}
