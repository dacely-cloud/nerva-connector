// SPDX-FileCopyrightText: 2026 Dacely <business@dacely.com>
// SPDX-License-Identifier: LicenseRef-Proprietary

/**
 * Request arguments read defensively for the local activity screen; every accessor degrades to an empty value.
 *
 * @remarks
 * The JSON comes from a request that the runtime lane validates on its own. This reader never throws, never
 * changes the request and only exposes typed own fields, so a malformed or unexpected shape becomes an empty
 * description instead of a failure in the lane that reported it.
 */
export class ConnectorActivityArguments {
    /** Arguments that are absent, malformed or not a JSON object. */
    public static readonly empty: ConnectorActivityArguments = new ConnectorActivityArguments(null);
    readonly #record: Readonly<Record<string, unknown>> | null;
    private constructor(record: Readonly<Record<string, unknown>> | null) {
        this.#record = record;
        Object.freeze(this);
    }

    /**
     * Reads one JSON document.
     *
     * @param json - Raw JSON text, which may be invalid or describe any value
     * @returns The object's fields, or {@link ConnectorActivityArguments.empty} for anything else
     *
     * @remarks
     * Invalid JSON is an expected input for a display-only reader: the parse failure is recorded as a `null`
     * document, which yields empty arguments, and the lane that owns the request reports its own validation error.
     */
    public static parse(json: string | null): ConnectorActivityArguments {
        if (json === null) {
            return ConnectorActivityArguments.empty;
        }
        let raw: unknown;
        try {
            raw = JSON.parse(json);
        } catch {
            raw = null;
        }
        return typeof raw === 'object' && raw !== null && !Array.isArray(raw)
            ? new ConnectorActivityArguments(raw as Readonly<Record<string, unknown>>)
            : ConnectorActivityArguments.empty;
    }

    /** The field as text, or an empty string when it is missing or not a string. */
    public text(name: string): string {
        const value: unknown = this.#field(name);
        return typeof value === 'string' ? value : '';
    }

    /**
     * The string items of an array field.
     *
     * @param maximum - Items read before the rest are ignored
     * @returns The string items in order; other items and non-array values are skipped
     */
    public texts(name: string, maximum: number): readonly string[] {
        const value: unknown = this.#field(name);
        if (!Array.isArray(value)) {
            return [];
        }
        const values: readonly unknown[] = value;
        const items: string[] = [];
        const count: number = Math.min(values.length, maximum);
        for (let index: number = 0; index < count; index++) {
            const item: unknown = values[index];
            if (typeof item === 'string') {
                items.push(item);
            }
        }
        return items;
    }

    /** True only for an explicit JSON `true`. */
    public flag(name: string): boolean {
        return this.#field(name) === true;
    }

    /** The field as a boolean, or `null` when it is missing or not a boolean. */
    public boolean(name: string): boolean | null {
        const value: unknown = this.#field(name);
        return typeof value === 'boolean' ? value : null;
    }

    /** The field as a finite number, or `null` when it is missing or not a finite number. */
    public number(name: string): number | null {
        const value: unknown = this.#field(name);
        return typeof value === 'number' && Number.isFinite(value) ? value : null;
    }

    #field(name: string): unknown {
        return this.#record !== null && Object.hasOwn(this.#record, name)
            ? this.#record[name]
            : undefined;
    }
}
