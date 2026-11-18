// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

import { ConnectorHostErrorCode } from 'nerva-connector-protocol/protocol/ConnectorHost.js';
import { HostOperationError } from './HostOperationError.js';
import { HostEnvironmentLimits, type HostEnvironmentRequest } from './HostEnvironmentTypes.js';

/**
 * Environment inspection requests are validated completely before authorization or filesystem access.
 *
 * @remarks
 * Names are counted in Unicode code points and must be well-formed, so the probed name is exactly
 * the requested name. Duplicates use exact string comparison. Program names are bare file names:
 * no NUL, `/` or `\`, and never `.` or `..`. Variable names contain no NUL or `=`.
 */
export class HostEnvironmentValidation {
    static readonly #programCharacters: RegExp = /[\0/\\]/u;
    static readonly #variableCharacters: RegExp = /[\0=]/u;
    static readonly #programNames: ReadonlySet<string> = new Set(['.', '..']);
    static readonly #variableNames: ReadonlySet<string> = new Set();

    /** Accept decoded tool input or typed callers alike; any rejection is a definitive invalid request. */
    public static request(programs: unknown, variables: unknown): HostEnvironmentRequest {
        try {
            return Object.freeze({
                programs: this.#names(programs, this.#programCharacters, this.#programNames),
                variables: this.#names(variables, this.#variableCharacters, this.#variableNames),
            });
        } catch (cause: unknown) {
            throw new HostOperationError(
                ConnectorHostErrorCode.InvalidRequest,
                'Environment inspection arguments were rejected before inspection',
                true,
                { cause },
            );
        }
    }

    static #names(
        raw: unknown,
        forbidden: RegExp,
        reserved: ReadonlySet<string>,
    ): readonly string[] {
        if (!Array.isArray(raw) || raw.length > HostEnvironmentLimits.names) {
            throw new Error('Invalid environment inspection name list');
        }
        const names: string[] = [];
        const seen: Set<string> = new Set();
        for (const name of raw) {
            if (
                typeof name !== 'string' ||
                name.length === 0 ||
                name.length > HostEnvironmentLimits.nameLength * 2 ||
                !name.isWellFormed() ||
                Array.from(name).length > HostEnvironmentLimits.nameLength ||
                forbidden.test(name) ||
                reserved.has(name) ||
                seen.has(name)
            ) {
                throw new Error('Invalid environment inspection name');
            }
            seen.add(name);
            names.push(name);
        }
        return Object.freeze(names);
    }
}
