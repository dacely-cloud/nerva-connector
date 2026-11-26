// SPDX-FileCopyrightText: 2026 Dacely <business@dacely.com>
// SPDX-License-Identifier: LicenseRef-Proprietary

import {
    GpuVendor,
    type GpuSpecification,
    type GpuUsage,
} from 'nerva-connector-protocol/system/SystemSpecification.js';
import { NvidiaSmi } from './NvidiaSmi.js';

/** One NVIDIA driver row; unknown readings stay null instead of becoming zero. */
export interface NvidiaLoad {
    readonly uuid: string;
    readonly name: string;
    readonly usedVramBytes: bigint | null;
    readonly utilizationBasisPoints: number | null;
}

/** Live per-GPU load from the fixed NVIDIA query executable; other vendors report no reading. */
export class GpuLoad {
    static readonly #mebibyte: bigint = 1048576n;

    /**
     * Reads the current load of every reported GPU that a driver can measure.
     *
     * @remarks
     * Only NVIDIA exposes a read-only command-line counter today, so other GPUs are absent from
     * the result. A missing or failing driver tool yields no loads rather than failing the report.
     */
    public static async read(
        gpus: readonly GpuSpecification[],
        signal: AbortSignal,
    ): Promise<readonly GpuUsage[]> {
        if (!gpus.some((gpu: GpuSpecification): boolean => gpu.vendor === GpuVendor.Nvidia)) {
            return [];
        }
        let csv: string | null;
        try {
            csv = await NvidiaSmi.query(['uuid', 'name', 'memory.used', 'utilization.gpu'], signal);
        } catch {
            signal.throwIfAborted();
            return [];
        }
        return csv === null ? [] : this.attach(gpus, this.parse(csv));
    }

    /** Strictly parses the fixed four-column query; malformed rows reject the whole sample. */
    public static parse(csv: string): readonly NvidiaLoad[] {
        if (Buffer.byteLength(csv) > 16384) {
            throw new Error('GPU load exceeds its byte limit');
        }
        const rows: readonly string[] = csv.trim() === '' ? [] : csv.trim().split('\n');
        if (rows.length > 32) {
            throw new Error('GPU load exceeds its device limit');
        }
        return Object.freeze(
            rows.map((row: string): NvidiaLoad => {
                const fields: readonly string[] = row
                    .split(',')
                    .map((field: string): string => field.trim());
                const uuid: string | undefined = fields[0];
                const name: string | undefined = fields[1];
                if (
                    fields.length !== 4 ||
                    uuid === undefined ||
                    !/^GPU-[a-fA-F0-9]{8}(?:-[a-fA-F0-9]{4}){3}-[a-fA-F0-9]{12}$/u.test(uuid) ||
                    name === undefined ||
                    name.length < 1 ||
                    name.length > 256
                ) {
                    throw new Error('Invalid GPU load record');
                }
                const used: string | null = this.#reading(fields[2], 16777216);
                const utilization: string | null = this.#reading(fields[3], 100);
                return Object.freeze({
                    uuid,
                    name,
                    usedVramBytes: used === null ? null : BigInt(used) * this.#mebibyte,
                    utilizationBasisPoints: utilization === null ? null : Number(utilization) * 100,
                });
            }),
        );
    }

    /**
     * Assigns driver rows to reported GPUs without guessing.
     *
     * @remarks
     * Linux reports NVIDIA GPUs by driver UUID, so rows match exactly. Windows reports DXGI ids,
     * so a row is attached only to the one NVIDIA adapter with its model name when exactly one
     * row has that name. Used video memory above the reported capacity is dropped, because the
     * two drivers can disagree about capacity.
     */
    public static attach(
        gpus: readonly GpuSpecification[],
        loads: readonly NvidiaLoad[],
    ): readonly GpuUsage[] {
        const usage: GpuUsage[] = [];
        for (const gpu of gpus) {
            if (gpu.vendor !== GpuVendor.Nvidia) {
                continue;
            }
            const exact: NvidiaLoad | undefined = loads.find(
                (load: NvidiaLoad): boolean => load.uuid === gpu.id,
            );
            const named: readonly NvidiaLoad[] = loads.filter(
                (load: NvidiaLoad): boolean => load.name === gpu.model,
            );
            const unique: boolean =
                gpus.filter(
                    (entry: GpuSpecification): boolean =>
                        entry.vendor === GpuVendor.Nvidia && entry.model === gpu.model,
                ).length === 1;
            const load: NvidiaLoad | undefined =
                exact ?? (unique && named.length === 1 ? named[0] : undefined);
            if (load === undefined) {
                continue;
            }
            const used: bigint | null =
                load.usedVramBytes !== null &&
                gpu.totalVramBytes !== null &&
                load.usedVramBytes > BigInt(gpu.totalVramBytes)
                    ? null
                    : load.usedVramBytes;
            usage.push(
                Object.freeze({
                    id: gpu.id,
                    utilizationBasisPoints: load.utilizationBasisPoints,
                    usedVramBytes: used?.toString() ?? null,
                }),
            );
        }
        return Object.freeze(usage);
    }

    /** Driver placeholders such as `[N/A]` mean no reading; any other non-integer is invalid. */
    static #reading(raw: string | undefined, maximum: number): string | null {
        if (raw === undefined) {
            throw new Error('Invalid GPU load record');
        }
        if (/^\[?(?:N\/A|Not Supported|Unknown Error)\]?$/iu.test(raw)) {
            return null;
        }
        if (!/^(?:0|[1-9][0-9]{0,8})$/u.test(raw) || Number(raw) > maximum) {
            throw new Error('Invalid GPU load record');
        }
        return raw;
    }
}
