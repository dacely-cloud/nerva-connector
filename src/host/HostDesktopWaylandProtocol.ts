// SPDX-FileCopyrightText: 2026 Dacely <business@dacely.com>
// SPDX-License-Identifier: LicenseRef-Proprietary

import { Boundary } from 'nerva-connector-protocol/protocol/Boundary.js';
import {
    HostDesktopLimits,
    HostDesktopUnavailable,
    type HostDesktopPointerRequest,
    type HostDesktopKeyRequest,
} from './HostDesktopTypes.js';
import type { ConnectorHostPointerButton } from 'nerva-connector-protocol/protocol/ConnectorHostArgumentChoices.js';

/** Fixed helper operations never interpret caller data as Python, shell or D-Bus source. */
export const HostDesktopWaylandOperation = {
    Probe: 'probe',
    Open: 'open',
    Capture: 'capture',
    Pointer: 'pointer',
    Key: 'key',
    Text: 'text',
    ReleaseButton: 'release-button',
    Close: 'close',
} as const;
/** Runtime operation values select one bounded private request shape. */
export type HostDesktopWaylandOperation =
    (typeof HostDesktopWaylandOperation)[keyof typeof HostDesktopWaylandOperation];
/** A request carries only operation data through the retained private stdin pipe. */
export interface HostDesktopWaylandCommand {
    readonly operation: HostDesktopWaylandOperation;
    readonly maximumWidth?: number;
    readonly maximumHeight?: number;
    readonly pointer?: HostDesktopPointerRequest;
    readonly key?: HostDesktopKeyRequest;
    readonly text?: string;
    readonly button?: ConnectorHostPointerButton;
}
/** Helper failures distinguish declined local consent from unavailable platform prerequisites. */
export const HostDesktopWaylandFailure = {
    Denied: 'denied',
    Canceled: 'canceled',
    Unavailable: 'unavailable',
    Invalid: 'invalid',
    Failed: 'failed',
} as const;
/** Runtime failure codes contain no native diagnostics or sensitive command payloads. */
export type HostDesktopWaylandFailure =
    (typeof HostDesktopWaylandFailure)[keyof typeof HostDesktopWaylandFailure];
/** Wire result variants cannot confuse an input acknowledgment with captured pixels. */
export const HostDesktopWaylandResultKind = {
    Info: 'info',
    Capture: 'capture',
    Sent: 'sent',
} as const;
/** Availability describes only the exact current portal owner and granted stream. */
export interface HostDesktopWaylandInfo {
    readonly kind: typeof HostDesktopWaylandResultKind.Info;
    readonly ready: boolean;
    readonly reason: HostDesktopUnavailable | null;
    readonly prerequisites: readonly string[];
    readonly width: number;
    readonly height: number;
}
/** The source dimensions retain physical-pixel coordinates independently from PNG scaling. */
export interface HostDesktopWaylandCapture {
    readonly kind: typeof HostDesktopWaylandResultKind.Capture;
    readonly png: Buffer;
    readonly sourceWidth: number;
    readonly sourceHeight: number;
}
/** A successful reply acknowledges only the exact private operation. */
export interface HostDesktopWaylandSent {
    readonly kind: typeof HostDesktopWaylandResultKind.Sent;
}
/** Every successful helper value is validated at its JSON boundary. */
export type HostDesktopWaylandResult =
    HostDesktopWaylandInfo | HostDesktopWaylandCapture | HostDesktopWaylandSent;
/** One correlated envelope settles a retained request without exposing the helper's runtime exceptions. */
export interface HostDesktopWaylandResponse {
    readonly id: bigint;
    readonly result: HostDesktopWaylandResult | null;
    readonly error: HostDesktopWaylandFailure | null;
}
/** Boundaries preserve canonical IDs, binary sizes and the declared availability state. */
export class HostDesktopWaylandProtocol {
    /** Decode one finite newline-delimited response from the fixed helper. */
    public static response(raw: unknown): HostDesktopWaylandResponse {
        const value: Readonly<Record<string, unknown>> = Boundary.record(raw, [
            'id',
            'result',
            'error',
        ]);
        const id: bigint = Boundary.integer(value['id']);
        if (value['error'] !== null) {
            const error: HostDesktopWaylandFailure | undefined = Object.values(
                HostDesktopWaylandFailure,
            ).find((entry: HostDesktopWaylandFailure): boolean => entry === value['error']);
            if (error === undefined || value['result'] !== null) {
                throw new Error('Invalid Wayland helper failure');
            }
            return { id, error, result: null };
        }
        const result: Readonly<Record<string, unknown>> = Boundary.record(value['result'], [
            'kind',
            'ready',
            'reason',
            'prerequisites',
            'width',
            'height',
            'png',
            'sourceWidth',
            'sourceHeight',
        ]);
        if (result['kind'] === HostDesktopWaylandResultKind.Info) {
            Boundary.record(result, [
                'kind',
                'ready',
                'reason',
                'prerequisites',
                'width',
                'height',
            ]);
            const ready: boolean = Boundary.boolean(result['ready']);
            const reason: HostDesktopUnavailable | undefined =
                result['reason'] === null
                    ? undefined
                    : Object.values(HostDesktopUnavailable).find(
                          (entry: HostDesktopUnavailable): boolean => entry === result['reason'],
                      );
            const prerequisites: readonly string[] = Boundary.array(
                result['prerequisites'],
                16,
            ).map((entry: unknown): string => {
                if (
                    typeof entry !== 'string' ||
                    entry.length < 1 ||
                    entry.length > 160 ||
                    /[\p{Cc}\p{Cf}]/u.test(entry)
                ) {
                    throw new Error('Invalid Wayland prerequisites');
                }
                return entry;
            });
            const width: number = Boundary.count(result['width'], 65535);
            const height: number = Boundary.count(result['height'], 65535);
            if (
                ready
                    ? reason !== undefined ||
                      result['reason'] !== null ||
                      width < 1 ||
                      height < 1 ||
                      prerequisites.length !== 0 ||
                      width * height > HostDesktopLimits.sourcePixels
                    : reason === undefined || width !== 0 || height !== 0
            ) {
                throw new Error('Invalid Wayland availability');
            }
            return {
                id,
                error: null,
                result: {
                    kind: HostDesktopWaylandResultKind.Info,
                    ready,
                    reason: reason ?? null,
                    prerequisites,
                    width,
                    height,
                },
            };
        }
        if (result['kind'] === HostDesktopWaylandResultKind.Capture) {
            Boundary.record(result, ['kind', 'png', 'sourceWidth', 'sourceHeight']);
            if (
                typeof result['png'] !== 'string' ||
                result['png'].length > Math.ceil(HostDesktopLimits.imageBytes / 3) * 4
            ) {
                throw new Error('Wayland PNG exceeds its bound');
            }
            const png: Buffer = Buffer.from(result['png'], 'base64');
            const sourceWidth: number = Boundary.count(result['sourceWidth'], 65535);
            const sourceHeight: number = Boundary.count(result['sourceHeight'], 65535);
            if (
                png.length < 24 ||
                png.length > HostDesktopLimits.imageBytes ||
                png.toString('base64') !== result['png'] ||
                sourceWidth < 1 ||
                sourceHeight < 1 ||
                sourceWidth * sourceHeight > HostDesktopLimits.sourcePixels
            ) {
                throw new Error('Invalid Wayland captured frame');
            }
            return {
                id,
                error: null,
                result: {
                    kind: HostDesktopWaylandResultKind.Capture,
                    png,
                    sourceWidth,
                    sourceHeight,
                },
            };
        }
        if (result['kind'] !== HostDesktopWaylandResultKind.Sent) {
            throw new Error('Invalid Wayland helper result');
        }
        Boundary.record(result, ['kind']);
        return { id, error: null, result: { kind: HostDesktopWaylandResultKind.Sent } };
    }
}
