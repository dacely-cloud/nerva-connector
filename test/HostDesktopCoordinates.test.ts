// SPDX-FileCopyrightText: 2026 Dacely <business@dacely.com>
// SPDX-License-Identifier: LicenseRef-Proprietary

import { expect, it } from 'vitest';
import { ConnectorHostTool } from 'nerva-connector-protocol/protocol/ConnectorHost.js';
import { ConnectorHostArgumentContracts } from 'nerva-connector-protocol/protocol/ConnectorHostArgumentContract.js';
import {
    ConnectorHostArgumentValidation,
    type ConnectorHostArgumentCheck,
} from 'nerva-connector-protocol/protocol/ConnectorHostArgumentValidation.js';
import { HostDesktopCoordinates } from '../src/host/HostDesktopCoordinates.js';
import {
    type HostDesktopInfo,
    type HostDesktopPointerRequest,
    type HostDesktopViewport,
} from '../src/host/HostDesktopTypes.js';
import {
    ConnectorHostPointerAction,
    ConnectorHostPointerButton,
} from 'nerva-connector-protocol/protocol/ConnectorHostArgumentChoices.js';

const desktop: HostDesktopInfo = {
    platform: 'win32',
    backend: 'win32',
    scope: 'desktop',
    prerequisites: [],
    available: true,
    reason: null,
    x: -1920,
    y: -200,
    width: 3840,
    height: 2160,
};
const image: HostDesktopViewport = {
    width: 1920,
    height: 1080,
    sourceX: -1920,
    sourceY: -200,
    sourceWidth: 3840,
    sourceHeight: 2160,
};
const request: HostDesktopPointerRequest = {
    x: 1000,
    y: 500,
    action: ConnectorHostPointerAction.Click,
    button: ConnectorHostPointerButton.Left,
};

it('maps screenshot pixels to the real multi-monitor desktop without changing the request or physical-coordinate calls', (): void => {
    expect(HostDesktopCoordinates.physical(request, desktop, image)).toEqual({
        ...request,
        x: 81,
        y: 801,
    });
    expect(request.x).toBe(1000);
    expect(HostDesktopCoordinates.physical(request, desktop, null)).toBe(request);
    expect(
        HostDesktopCoordinates.physical({ ...request, x: 1919, y: 1079 }, desktop, image),
    ).toMatchObject({ x: 1919, y: 1959 });
});

it('rejects stale geometry, out-of-image coordinates and malformed metadata before an input effect', (): void => {
    expect((): HostDesktopPointerRequest =>
        HostDesktopCoordinates.physical(request, { ...desktop, width: 2560 }, image),
    ).toThrow('fresh screenshot');
    for (const x of [-1, 1920, 0.1, Number.NaN]) {
        expect((): HostDesktopPointerRequest =>
            HostDesktopCoordinates.physical({ ...request, x }, desktop, image),
        ).toThrow();
    }
    for (const raw of [
        { ...image, width: 0 },
        { ...image, sourceX: '0' },
        { ...image, hidden: true },
        { ...image, height: Number.POSITIVE_INFINITY },
    ]) {
        const check: ConnectorHostArgumentCheck = ConnectorHostArgumentValidation.check(
            ConnectorHostTool.DesktopPointer,
            { x: 1000, y: 500, action: ConnectorHostPointerAction.Click, image: raw },
            ConnectorHostArgumentContracts.paired,
        );
        expect(check.valid ? null : check.message).toMatch(/^image\b/u);
    }
});
