// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

import type { HostDesktopTextField } from './HostDesktopTypes.js';
import { HostDesktopError } from './HostDesktopError.js';

/** Field replacement is explicit and never silently becomes foreground input when a selector is malformed. */
export class HostDesktopTextFieldOptions {
    /** External MCP arguments and direct driver callers use the same finite field contract. */
    public static read(field: unknown, replace: unknown): HostDesktopTextField | undefined {
        if (field === undefined && replace === undefined) {
            return undefined;
        }
        if (
            typeof field !== 'string' ||
            field.length < 1 ||
            field.length > 256 ||
            field.includes('\0') ||
            replace !== true
        ) {
            throw new HostDesktopError('text', 'keyboard-field-invalid', 0);
        }
        return { field, replace: true };
    }
}
