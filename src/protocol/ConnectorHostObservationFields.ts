// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

/** Closed finite data readers reject accessors and hidden fields before observation values are used. */
export class ConnectorHostObservationFields {
    static readonly #encoder: TextEncoder = new TextEncoder();

    /** Browser-safe UTF-8 byte counts preserve the device grammar without Node globals. */
    public static bytes(value: string): number {
        return this.#encoder.encode(value).byteLength;
    }
    /** All declared fields must be own enumerable data; missing, extra or inherited authority is rejected. */
    public static record(
        raw: unknown,
        fields: readonly string[],
    ): Readonly<Record<string, unknown>> {
        if (
            typeof raw !== 'object' ||
            raw === null ||
            Object.getPrototypeOf(raw) !== Object.prototype
        ) {
            throw new Error('Invalid host observation record');
        }
        const keys: readonly PropertyKey[] = Reflect.ownKeys(raw);
        if (
            keys.length !== fields.length ||
            keys.some(
                (key: PropertyKey): boolean => typeof key !== 'string' || !fields.includes(key),
            )
        ) {
            throw new Error('Invalid host observation fields');
        }
        const result: Record<string, unknown> = {};
        for (const key of fields) {
            const descriptor: PropertyDescriptor | undefined = Object.getOwnPropertyDescriptor(
                raw,
                key,
            );
            if (
                descriptor === undefined ||
                descriptor.enumerable !== true ||
                !Object.hasOwn(descriptor, 'value')
            ) {
                throw new Error('host observation accessors are forbidden');
            }
            const value: unknown = descriptor.value;
            Object.defineProperty(result, key, { value, enumerable: true });
        }
        return result;
    }

    /** Only dense bounded arrays with no additional own fields are copied. */
    public static array(raw: unknown, maximum: number): readonly unknown[] {
        if (!Array.isArray(raw) || Object.getPrototypeOf(raw) !== Array.prototype) {
            throw new Error('Invalid host observation collection');
        }
        const descriptor: PropertyDescriptor | undefined = Object.getOwnPropertyDescriptor(
            raw,
            'length',
        );
        if (
            descriptor === undefined ||
            descriptor.enumerable !== false ||
            descriptor.configurable !== false ||
            !Object.hasOwn(descriptor, 'value')
        ) {
            throw new Error('Invalid host observation collection length');
        }
        const value: unknown = descriptor.value;
        const length: number = this.count(value, 0, maximum);
        if (Reflect.ownKeys(raw).length !== length + 1) {
            throw new Error('Invalid host observation collection fields');
        }
        const result: unknown[] = [];
        for (let index: number = 0; index < length; index++) {
            const entry: PropertyDescriptor | undefined = Object.getOwnPropertyDescriptor(
                raw,
                index,
            );
            if (
                entry === undefined ||
                entry.enumerable !== true ||
                !Object.hasOwn(entry, 'value')
            ) {
                throw new Error('Invalid host observation collection entry');
            }
            const item: unknown = entry.value;
            result.push(item);
        }
        return result;
    }

    /** Small controlled byte ceilings, indexes and durations never accept fractions or lossy integers. */
    public static count(raw: unknown, minimum: number, maximum: number): number {
        if (
            typeof raw !== 'number' ||
            !Number.isSafeInteger(raw) ||
            raw < minimum ||
            raw > maximum
        ) {
            throw new Error('Invalid host observation bound');
        }
        return raw;
    }

    /** Finite UTF-8 input data can contain NUL because it is delivered through an owned descriptor. */
    public static data(raw: unknown, maximum: number): string {
        if (typeof raw !== 'string' || !raw.isWellFormed() || this.bytes(raw) > maximum) {
            throw new Error('Invalid host observation UTF-8 data');
        }
        return raw;
    }
}
