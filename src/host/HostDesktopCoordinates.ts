// SPDX-FileCopyrightText: 2026 Dacely <business@dacely.com>
// SPDX-License-Identifier: LicenseRef-Proprietary

import type { ConnectorHostArguments } from 'nerva-connector-protocol/protocol/ConnectorHostArguments.js';
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
    /** Screenshot geometry from `desktop_pointer` arguments that already satisfy their contract. */
    public static read(image: ConnectorHostArguments): HostDesktopViewport {
        return {
            width: image.integer('width'),
            height: image.integer('height'),
            sourceX: image.integer('sourceX'),
            sourceY: image.integer('sourceY'),
            sourceWidth: image.integer('sourceWidth'),
            sourceHeight: image.integer('sourceHeight'),
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
}
