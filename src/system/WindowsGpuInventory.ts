// SPDX-FileCopyrightText: 2026 Dacely <business@dacely.com>
// SPDX-License-Identifier: LicenseRef-Proprietary

import { Boundary } from 'nerva-connector-protocol/protocol/Boundary.js';
import { WindowsStateOwner } from '../windows/WindowsStateOwner.js';
import {
    WindowsStateOperation,
    type WindowsStateResponse,
} from '../windows/WindowsStateProtocol.js';
import { SystemSpecificationCodec } from 'nerva-connector-protocol/system/SystemSpecificationCodec.js';
import type { GpuSpecification } from 'nerva-connector-protocol/system/SystemSpecification.js';
import { GpuVendor } from 'nerva-connector-protocol/system/SystemSpecification.js';
import { GpuInventory } from './GpuInventory.js';
import { NvidiaSmi } from './NvidiaSmi.js';

/** The pinned precompiled helper queries all Windows display vendors through DXGI without scripts. */
export class WindowsGpuInventory {
    /** Cancellation prevents publication; only a finite read-only native operation reaches the local bridge. */
    public static async read(signal: AbortSignal): Promise<readonly GpuSpecification[]> {
        signal.throwIfAborted();
        const response: WindowsStateResponse = await WindowsStateOwner.request(
            WindowsStateOperation.GpuInventory,
        );
        signal.throwIfAborted();
        const bytes: Buffer = WindowsStateOwner.bytes(response, 32768);
        const devices: readonly GpuSpecification[] = this.parse(
            new TextDecoder('utf-8', { fatal: true }).decode(bytes),
        );
        if (
            !devices.some((device: GpuSpecification): boolean => device.vendor === GpuVendor.Nvidia)
        ) {
            return devices;
        }
        const measured: readonly GpuSpecification[] = await this.#nvidia(signal);
        signal.throwIfAborted();
        return this.enrich(devices, measured);
    }

    /** A global NVIDIA free-memory measurement is attached only to one unambiguous matching adapter and capacity. */
    public static enrich(
        devices: readonly GpuSpecification[],
        measured: readonly GpuSpecification[],
    ): readonly GpuSpecification[] {
        return Object.freeze(
            devices.map((device: GpuSpecification): GpuSpecification => {
                if (
                    device.vendor !== GpuVendor.Nvidia ||
                    devices.filter(
                        (entry: GpuSpecification): boolean =>
                            entry.vendor === GpuVendor.Nvidia && entry.model === device.model,
                    ).length !== 1
                ) {
                    return device;
                }
                const matches: readonly GpuSpecification[] = measured.filter(
                    (entry: GpuSpecification): boolean =>
                        entry.vendor === GpuVendor.Nvidia &&
                        entry.model === device.model &&
                        entry.totalVramBytes === device.totalVramBytes,
                );
                const sample: GpuSpecification | undefined =
                    matches.length === 1 ? matches[0] : undefined;
                return sample === undefined
                    ? device
                    : Object.freeze({ ...device, availableVramBytes: sample.availableVramBytes });
            }),
        );
    }

    static async #nvidia(signal: AbortSignal): Promise<readonly GpuSpecification[]> {
        try {
            const csv: string | null = await NvidiaSmi.query(
                ['uuid', 'name', 'memory.total', 'memory.free'],
                signal,
            );
            return csv === null ? [] : GpuInventory.parseNvidia(csv);
        } catch {
            signal.throwIfAborted();
            return [];
        }
    }

    /** Device count, identity uniqueness, canonical counters and exact vendor values are checked again in TypeScript. */
    public static parse(json: string): readonly GpuSpecification[] {
        if (Buffer.byteLength(json) > 32768) {
            throw new Error('GPU inventory exceeds its byte limit');
        }
        const raw: unknown = JSON.parse(json);
        const devices: readonly GpuSpecification[] = Object.freeze(
            Boundary.array(raw, 32).map((entry: unknown): GpuSpecification =>
                SystemSpecificationCodec.gpu(entry),
            ),
        );
        if (
            devices.some(
                (device: GpuSpecification): boolean =>
                    !/^DXGI-[a-f0-9]{8}-[a-f0-9]{8}$/iu.test(device.id),
            ) ||
            new Set(devices.map((device: GpuSpecification): string => device.id.toLowerCase()))
                .size !== devices.length
        ) {
            throw new Error('Invalid Windows GPU inventory identity');
        }
        return devices;
    }
}
