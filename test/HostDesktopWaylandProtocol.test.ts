// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

import { expect, it } from 'vitest';
import {
    HostDesktopWaylandProtocol,
    HostDesktopWaylandResultKind,
    type HostDesktopWaylandResponse,
} from '../src/host/HostDesktopWaylandProtocol.js';
import { HostDesktopLimits } from '../src/host/HostDesktopTypes.js';

/** Replies are parsed JSON boundary data, including intentionally malformed fixtures. */
interface Reply {
    readonly id: string;
    readonly error: string | null;
    readonly result: Readonly<
        Record<string, string | number | boolean | null | readonly string[]>
    > | null;
}

/** The portal probe must never assert that missing consent is a missing Wayland implementation. */
const pending: Reply = {
    id: '9007199254740993',
    error: null,
    result: {
        kind: 'info',
        ready: false,
        reason: 'consent-required',
        prerequisites: [],
        width: 0,
        height: 0,
    },
};

it('keeps exact correlation IDs and distinguishes supported pending consent from ready geometry', (): void => {
    expect(HostDesktopWaylandProtocol.response(pending)).toMatchObject({
        id: 9007199254740993n,
        error: null,
        result: { kind: 'info', ready: false, reason: 'consent-required', width: 0, height: 0 },
    });
    expect(
        HostDesktopWaylandProtocol.response({
            ...pending,
            result: {
                kind: 'info',
                ready: true,
                reason: null,
                prerequisites: [],
                width: 4096,
                height: 4096,
            },
        }),
    ).toMatchObject({ result: { ready: true, width: 4096, height: 4096 } });
});

it.each(['-1', '01', '1.5', '1e3', '9223372036854775808', '1234567890123456789012345'])(
    'rejects a lossy, noncanonical or out-of-range correlation ID %j',
    (id: string): void => {
        expect((): HostDesktopWaylandResponse =>
            HostDesktopWaylandProtocol.response({ ...pending, id }),
        ).toThrow();
    },
);

it.each([
    {
        kind: 'info',
        ready: true,
        reason: 'consent-required',
        prerequisites: [],
        width: 1920,
        height: 1080,
    },
    {
        kind: 'info',
        ready: true,
        reason: null,
        prerequisites: ['missing PipeWire'],
        width: 1920,
        height: 1080,
    },
    { kind: 'info', ready: true, reason: null, prerequisites: [], width: 0, height: 1080 },
    { kind: 'info', ready: true, reason: null, prerequisites: [], width: 65535, height: 65535 },
    { kind: 'info', ready: false, reason: null, prerequisites: [], width: 0, height: 0 },
    { kind: 'info', ready: false, reason: 'invented', prerequisites: [], width: 0, height: 0 },
    {
        kind: 'info',
        ready: false,
        reason: 'session-closed',
        prerequisites: [],
        width: 1920,
        height: 1080,
    },
    {
        kind: 'info',
        ready: false,
        reason: 'missing-tools',
        prerequisites: ['a'.repeat(161)],
        width: 0,
        height: 0,
    },
    {
        kind: 'info',
        ready: false,
        reason: 'missing-tools',
        prerequisites: ['fake\nchooser'],
        width: 0,
        height: 0,
    },
    {
        kind: 'info',
        ready: false,
        reason: 'missing-tools',
        prerequisites: ['fake\u202echooser'],
        width: 0,
        height: 0,
    },
    {
        kind: 'info',
        ready: false,
        reason: 'missing-tools',
        prerequisites: Array.from({ length: 17 }, (): string => 'missing tool'),
        width: 0,
        height: 0,
    },
])(
    'refuses contradictory capability metadata and oversized or control-bearing prerequisites',
    (result: Reply['result']): void => {
        expect((): HostDesktopWaylandResponse =>
            HostDesktopWaylandProtocol.response({ ...pending, result }),
        ).toThrow();
    },
);

it('a prerequisite list remains explicit data while denial is distinct from availability and cannot carry success data', (): void => {
    expect(
        HostDesktopWaylandProtocol.response({
            ...pending,
            result: {
                kind: 'info',
                ready: false,
                reason: 'missing-tools',
                prerequisites: ['GStreamer GI', 'pipewiresrc'],
                width: 0,
                height: 0,
            },
        }),
    ).toMatchObject({ result: { prerequisites: ['GStreamer GI', 'pipewiresrc'] } });
    expect(HostDesktopWaylandProtocol.response({ id: '1', error: 'denied', result: null })).toEqual(
        { id: 1n, error: 'denied', result: null },
    );
    for (const raw of [
        { ...pending, error: 'denied' },
        { id: '1', error: 'run-arbitrary-helper', result: null },
        { id: '1', error: null, result: { kind: 'sent', png: 'private' } },
        { id: '1', error: null, result: { kind: 'unknown' } },
        { ...pending, command: 'untrusted' },
    ]) {
        expect((): HostDesktopWaylandResponse =>
            HostDesktopWaylandProtocol.response(raw),
        ).toThrow();
    }
});

it('captures retain canonical PNG bytes and physical source size without numeric coercion', (): void => {
    const png: Buffer = Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==',
        'base64',
    );
    const value: HostDesktopWaylandResponse = HostDesktopWaylandProtocol.response({
        id: '1',
        error: null,
        result: {
            kind: 'capture',
            png: png.toString('base64'),
            sourceWidth: 1920,
            sourceHeight: 1080,
        },
    });
    if (value.result?.kind !== HostDesktopWaylandResultKind.Capture) {
        throw new Error('Expected bounded capture bytes');
    }
    expect(value.result.png).toEqual(png);
    expect(value.result.sourceWidth).toBe(1920);
    for (const result of [
        { kind: 'capture', png: 'aGk=', sourceWidth: 1, sourceHeight: 1 },
        { kind: 'capture', png: png.toString('base64') + '\n', sourceWidth: 1, sourceHeight: 1 },
        { kind: 'capture', png: png.toString('base64'), sourceWidth: '1920', sourceHeight: 1080 },
        { kind: 'capture', png: png.toString('base64'), sourceWidth: 65535, sourceHeight: 65535 },
    ]) {
        expect((): HostDesktopWaylandResponse =>
            HostDesktopWaylandProtocol.response({ id: '1', error: null, result }),
        ).toThrow();
    }
});

it('checks encoded capture bounds before decoding an oversized helper response', (): void => {
    const encoded: string = 'A'.repeat(Math.ceil(HostDesktopLimits.imageBytes / 3) * 4 + 4);
    expect((): HostDesktopWaylandResponse =>
        HostDesktopWaylandProtocol.response({
            id: '1',
            error: null,
            result: { kind: 'capture', png: encoded, sourceWidth: 1, sourceHeight: 1 },
        }),
    ).toThrow('bound');
});
