// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

import { HostDesktopKeyAction } from './HostDesktopTypes.js';

/** Windows key expressions are a closed bounded chord grammar, never a shell or keyboard macro language. */
export class HostDesktopKeyChord {
    /** Canonical modifier names match native ownership checks and never include expression aliases. */
    public static readonly modifiers: readonly string[] = ['Control', 'Alt', 'Shift', 'Meta'];

    /** Only press accepts a compound expression; held actions always name one owned key. */
    public static read(key: string, action: HostDesktopKeyAction): string {
        if (
            typeof key !== 'string' ||
            key.length < 1 ||
            key.length > 64 ||
            /[^A-Za-z0-9+]/u.test(key) ||
            !Object.values(HostDesktopKeyAction).includes(action)
        ) {
            throw new Error('Invalid desktop key or action');
        }
        const parts: readonly string[] = key.split('+');
        const primary: string | undefined = parts.at(-1);
        const modifiers: readonly string[] = parts.slice(0, -1);
        if (
            parts.length > 5 ||
            (parts.length > 1 && action !== HostDesktopKeyAction.Press) ||
            modifiers.some((part: string): boolean => !this.modifiers.includes(part)) ||
            new Set(modifiers).size !== modifiers.length ||
            primary === undefined ||
            (parts.length > 1 && this.modifiers.includes(primary)) ||
            !this.#single(primary)
        ) {
            throw new Error('Invalid desktop key chord');
        }
        return key;
    }

    static #single(key: string): boolean {
        return (
            /^[A-Za-z0-9]$/u.test(key) ||
            /^F([1-9]|1[0-2])$/u.test(key) ||
            [
                ...this.modifiers,
                'Enter',
                'Tab',
                'Escape',
                'Backspace',
                'Delete',
                'Insert',
                'Home',
                'End',
                'PageUp',
                'PageDown',
                'Up',
                'Down',
                'Left',
                'Right',
                'Space',
            ].includes(key)
        );
    }
}
