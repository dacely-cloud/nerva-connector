// SPDX-FileCopyrightText: 2026 Dacely <business@dacely.com>
// SPDX-License-Identifier: LicenseRef-Proprietary

import { ConnectorHostErrorCode } from 'nerva-connector-protocol/protocol/ConnectorHost.js';
import { HostOperationError } from './HostOperationError.js';
import type { HostJsonObject, HostJsonValue } from './HostMcpProtocol.js';

/**
 * Checks each supplied tool argument against the JSON type, choices and integer range its catalog schema declares.
 *
 * @remarks
 * This runs before the operation owner is invoked, so every rejection is a definitive `invalid-request` whose local
 * message names the field and the expected shape, never the supplied value. `null` is left to the typed decoders,
 * which treat it as absent for optional launch and pointer fields. String patterns, lengths and nested objects are
 * left to those decoders too; their rejections are equally definitive.
 */
export class HostMcpArgumentShape {
    /**
     * Rejects every supplied field whose value its declared schema does not allow.
     *
     * @param properties - The tool's declared `properties` schemas
     * @param args - The tool's own arguments, already limited to declared field names
     * @throws {HostOperationError} `invalid-request`, definitive, naming the first rejected field
     */
    public static check(properties: HostJsonObject, args: Readonly<Record<string, unknown>>): void {
        for (const [field, value] of Object.entries(args)) {
            const schema: HostJsonValue | undefined = properties[field];
            if (value !== null && this.object(schema)) {
                this.#field(field, schema, value);
            }
        }
    }

    /** Whether a schema value is a JSON object rather than an array, a primitive or absent. */
    public static object(value: HostJsonValue | undefined): value is HostJsonObject {
        return typeof value === 'object' && value !== null && !Array.isArray(value);
    }

    static #field(field: string, schema: HostJsonObject, value: unknown): void {
        const declared: HostJsonValue | undefined = schema['type'];
        const types: readonly string[] =
            typeof declared === 'string'
                ? [declared]
                : Array.isArray(declared)
                  ? declared.filter(
                        (type: HostJsonValue): type is string => typeof type === 'string',
                    )
                  : [];
        if (
            types.length !== 0 &&
            !types.some((type: string): boolean => this.#matches(type, value))
        ) {
            const pattern: HostJsonValue | undefined = schema['pattern'];
            throw this.#rejected(
                field,
                'must be ' +
                    types.map((type: string): string => this.#article(type)).join(' or ') +
                    (typeof pattern === 'string' && types.includes('string')
                        ? ' matching ' + pattern
                        : '') +
                    ', not ' +
                    this.#article(this.#kind(value)),
            );
        }
        const choices: HostJsonValue | undefined = schema['enum'];
        if (
            Array.isArray(choices) &&
            !choices.some((choice: HostJsonValue): boolean => choice === value)
        ) {
            throw this.#rejected(
                field,
                'must be one of ' +
                    choices
                        .map((choice: HostJsonValue): string => JSON.stringify(choice))
                        .join(', '),
            );
        }
        if (typeof value === 'number') {
            const minimum: HostJsonValue | undefined = schema['minimum'];
            const maximum: HostJsonValue | undefined = schema['maximum'];
            if (
                (typeof minimum === 'number' && value < minimum) ||
                (typeof maximum === 'number' && value > maximum)
            ) {
                throw this.#rejected(
                    field,
                    'must be from ' +
                        (typeof minimum === 'number' ? minimum.toString() : 'any') +
                        ' to ' +
                        (typeof maximum === 'number' ? maximum.toString() : 'any'),
                );
            }
        }
    }

    static #matches(type: string, value: unknown): boolean {
        switch (type) {
            case 'string':
                return typeof value === 'string';
            case 'integer':
                return typeof value === 'number' && Number.isSafeInteger(value);
            case 'number':
                return typeof value === 'number' && Number.isFinite(value);
            case 'boolean':
                return typeof value === 'boolean';
            case 'array':
                return Array.isArray(value);
            case 'object':
                return typeof value === 'object' && value !== null && !Array.isArray(value);
            case 'null':
                return value === null;
            default:
                return true;
        }
    }

    static #kind(value: unknown): string {
        if (Array.isArray(value)) {
            return 'array';
        }
        if (typeof value === 'number') {
            return Number.isInteger(value) ? 'integer' : 'number';
        }
        return typeof value;
    }

    static #article(type: string): string {
        return (/^[aeiou]/u.test(type) ? 'an ' : 'a ') + type;
    }

    static #rejected(field: string, expectation: string): HostOperationError {
        return new HostOperationError(
            ConnectorHostErrorCode.InvalidRequest,
            'Host operation field ' + field + ' ' + expectation,
            true,
        );
    }
}
