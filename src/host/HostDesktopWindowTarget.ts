// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

/** Opaque native window identities retain pointer/process-generation precision without trusting a title. */
export class HostDesktopWindowTarget {
    /** Native observations and input requests share one exact fixed-width selector shape. */
    public static read(raw: unknown): string {
        if (
            typeof raw !== 'string' ||
            raw.length !== 60 ||
            !/^win32:v1:[0-9a-f]{16}:[0-9a-f]{8}:[0-9a-f]{16}:[0-9a-f]{8}$/u.test(raw) ||
            raw
                .split(':')
                .slice(2)
                .some((part: string): boolean => BigInt('0x' + part) === 0n)
        ) {
            throw new Error('Invalid Windows window target');
        }
        return raw;
    }
}
