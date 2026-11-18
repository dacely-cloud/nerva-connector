// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

import { Boundary } from 'nerva-connector-protocol/protocol/Boundary.js';
import { HostDesktopWindowTarget } from './HostDesktopWindowTarget.js';
import { HostDesktopLimits, type HostDesktopViewport } from './HostDesktopTypes.js';

/** Resolution never launches an ambiguous or missing application. */
export const HostApplicationStatus = {
    Launched: 'launched',
    NotFound: 'not-found',
    Ambiguous: 'ambiguous',
} as const;
/** Native application resolution states. */
export type HostApplicationStatus =
    (typeof HostApplicationStatus)[keyof typeof HostApplicationStatus];

/** An installed Start menu entry, never an arbitrary executable supplied by a model. */
export interface HostApplicationEntry {
    readonly name: string;
    readonly id: string;
}

/** One bounded image of the actual desktop travels in memory with its native geometry. */
export interface HostDesktopFrame extends HostDesktopViewport {
    readonly mimeType: 'image/jpeg';
    readonly data: string;
    /** Opaque foreground window identity, present only when stable across the capture. */
    readonly windowTarget?: string;
}

/** Shell acceptance, observed window presence and the captured screen remain independent evidence. */
export interface HostApplicationResult {
    readonly status: HostApplicationStatus;
    readonly candidates: readonly HostApplicationEntry[];
    readonly windowObserved: boolean;
    readonly screenshot: HostDesktopFrame | null;
    /** A verified window of the selected executable, when it could be identified. */
    readonly windowTarget?: string;
}

/** Validate untrusted native JSON before returning it through a signed host receipt. */
export class HostApplication {
    /** Narrow browser navigation to one bounded HTTP(S) address before any native launch. */
    public static address(value: string): string {
        if (value.length > 4096 || !/^https?:\/\//iu.test(value)) {
            throw new Error('Invalid browser address');
        }
        for (let index: number = 0; index < value.length; index += 1) {
            const character: string = value.charAt(index);
            if (character <= ' ' || character === '"' || character === '\\') {
                throw new Error('Invalid browser address');
            }
        }
        const address: URL = new URL(value);
        if (
            address.hostname === '' ||
            address.username !== '' ||
            address.password !== '' ||
            address.href.length > 4096
        ) {
            throw new Error('Invalid browser address');
        }
        return address.href;
    }

    /** A missing image stays explicit; launch acceptance alone never proves visual readiness. */
    public static result(raw: unknown): HostApplicationResult {
        const value: Readonly<Record<string, unknown>> = Boundary.record(raw, [
            'status',
            'candidates',
            'windowObserved',
            'screenshot',
            'elapsedMs',
            'windowTarget',
        ]);
        const status: HostApplicationStatus | undefined = Object.values(HostApplicationStatus).find(
            (entry: HostApplicationStatus): boolean => entry === value['status'],
        );
        const candidates: readonly HostApplicationEntry[] = Boundary.array(
            value['candidates'],
            32,
        ).map((rawEntry: unknown): HostApplicationEntry => {
            const entry: Readonly<Record<string, unknown>> = Boundary.record(rawEntry, [
                'name',
                'id',
            ]);
            return { name: this.#text(entry['name'], 512), id: this.#text(entry['id'], 4096) };
        });
        if (
            status === undefined ||
            (status === HostApplicationStatus.Launched
                ? candidates.length !== 1
                : status === HostApplicationStatus.NotFound
                  ? candidates.length !== 0
                  : candidates.length < 2)
        ) {
            throw new Error('Invalid native application resolution');
        }
        const windowObserved: boolean = Boundary.boolean(value['windowObserved']);
        const windowTarget: string | undefined = this.#windowTarget(value['windowTarget']);
        if (
            (status !== HostApplicationStatus.Launched &&
                (windowObserved || value['screenshot'] != null)) ||
            (windowTarget !== undefined && !windowObserved)
        ) {
            throw new Error('Unlaunched application cannot have launch evidence');
        }
        return {
            status,
            candidates,
            windowObserved,
            screenshot: value['screenshot'] == null ? null : this.frame(value['screenshot']),
            ...(windowTarget === undefined ? {} : { windowTarget }),
        };
    }

    /** JPEG bytes are bounded and canonical before model or transport code can use them. */
    public static frame(raw: unknown): HostDesktopFrame {
        const value: Readonly<Record<string, unknown>> = Boundary.record(raw, [
            'mimeType',
            'data',
            'width',
            'height',
            'sourceX',
            'sourceY',
            'sourceWidth',
            'sourceHeight',
            'windowTarget',
        ]);
        const data: string = this.#text(value['data'], HostDesktopLimits.inlineBase64);
        const bytes: Buffer = Buffer.from(data, 'base64');
        if (
            value['mimeType'] !== 'image/jpeg' ||
            bytes.toString('base64') !== data ||
            bytes.length < 4 ||
            bytes.length > HostDesktopLimits.inlineBytes ||
            bytes[0] !== 255 ||
            bytes[1] !== 216 ||
            bytes.at(-2) !== 255 ||
            bytes.at(-1) !== 217
        ) {
            throw new Error('Invalid native desktop image');
        }
        const windowTarget: string | undefined = this.#windowTarget(value['windowTarget']);
        return {
            mimeType: 'image/jpeg',
            data,
            width: this.#positive(value['width'], HostDesktopLimits.dimension),
            height: this.#positive(value['height'], HostDesktopLimits.dimension),
            sourceX: this.#coordinate(value['sourceX']),
            sourceY: this.#coordinate(value['sourceY']),
            sourceWidth: this.#positive(value['sourceWidth'], 65535),
            sourceHeight: this.#positive(value['sourceHeight'], 65535),
            ...(windowTarget === undefined ? {} : { windowTarget }),
        };
    }

    static #windowTarget(value: unknown): string | undefined {
        if (value === undefined || value === null) {
            return undefined;
        }
        return HostDesktopWindowTarget.read(value);
    }

    static #text(raw: unknown, maximum: number): string {
        if (
            typeof raw !== 'string' ||
            raw.length < 1 ||
            raw.length > maximum ||
            /[\0\r\n]/u.test(raw)
        ) {
            throw new Error('Invalid native application text');
        }
        return raw;
    }
    static #positive(raw: unknown, maximum: number): number {
        const value: number = Boundary.count(raw, maximum);
        if (value === 0) {
            throw new Error('Invalid desktop dimension');
        }
        return value;
    }
    static #coordinate(raw: unknown): number {
        if (typeof raw !== 'number' || !Number.isSafeInteger(raw) || Math.abs(raw) > 65535) {
            throw new Error('Invalid desktop origin');
        }
        return raw;
    }
}
