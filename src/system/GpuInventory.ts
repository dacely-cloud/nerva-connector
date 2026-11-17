// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

import {
    GpuVendor,
    type GpuSpecification,
} from 'nerva-connector-protocol/system/SystemSpecification.js';

/** Parses only the fixed NVIDIA UUID/name/total/free query with bounded records and exact byte quantities. */
export class GpuInventory {
    public static parseNvidia(csv: string): readonly GpuSpecification[] {
        if (Buffer.byteLength(csv) > 16384) {
            throw new Error('GPU inventory exceeds its byte limit');
        }
        const rows: readonly string[] = csv.trim() === '' ? [] : csv.trim().split('\n');
        if (rows.length > 32) {
            throw new Error('GPU inventory exceeds its device limit');
        }
        const devices: readonly GpuSpecification[] = rows.map((row: string): GpuSpecification => {
            const fields: readonly string[] = row
                .split(',')
                .map((field: string): string => field.trim());
            const id: string | undefined = fields[0];
            const model: string | undefined = fields[1];
            if (
                fields.length !== 4 ||
                id === undefined ||
                !/^GPU-[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12}$/u.test(
                    id,
                ) ||
                model === undefined ||
                model.length < 1 ||
                model.length > 256 ||
                Array.from(model).some((character: string): boolean => character.charCodeAt(0) < 32)
            ) {
                throw new Error('Invalid GPU inventory record');
            }
            const total: string | null = this.#memory(fields[2]);
            const available: string | null = this.#memory(fields[3]);
            if (total !== null && available !== null && BigInt(available) > BigInt(total)) {
                throw new Error('GPU available memory exceeds its capacity');
            }
            return Object.freeze({
                id,
                vendor: GpuVendor.Nvidia,
                model,
                totalVramBytes: total,
                availableVramBytes: available,
            });
        });
        if (
            new Set(devices.map((device: GpuSpecification): string => device.id.toLowerCase()))
                .size !== devices.length
        ) {
            throw new Error('Duplicate GPU inventory identity');
        }
        return Object.freeze(devices);
    }

    static #memory(value: string | undefined): string | null {
        if (value === '[N/A]' || value === 'N/A') {
            return null;
        }
        if (value === undefined || !/^(0|[1-9][0-9]{0,9})$/u.test(value)) {
            throw new Error('Invalid GPU memory quantity');
        }
        return (BigInt(value) * 1048576n).toString();
    }
}
