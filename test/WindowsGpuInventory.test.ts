// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

import { afterAll, expect, it } from 'vitest';
import { WindowsGpuInventory } from '../src/system/WindowsGpuInventory.js';
import {
    GpuVendor,
    type GpuSpecification,
} from 'nerva-connector-protocol/system/SystemSpecification.js';
import { WindowsStateOwner } from '../src/windows/WindowsStateOwner.js';

const devices: readonly GpuSpecification[] = [
    GpuVendor.Nvidia,
    GpuVendor.Amd,
    GpuVendor.Intel,
    GpuVendor.Other,
].map((vendor: GpuVendor, index: number): GpuSpecification => ({
    id: 'DXGI-FFFFFFFF-' + index.toString(16).padStart(8, '0'),
    vendor,
    model: vendor + ' adapter',
    totalVramBytes: index === 2 ? '0' : '34359738368',
    availableVramBytes: null,
}));

afterAll(async (): Promise<void> => {
    await WindowsStateOwner.close();
});

it('Windows inventory keeps every vendor and dedicated bytes without inventing free VRAM or shared capacity', (): void => {
    const parsed: readonly GpuSpecification[] = WindowsGpuInventory.parse(JSON.stringify(devices));
    expect(parsed).toEqual(devices);
    expect(parsed[2]?.totalVramBytes).toBe('0');
    expect(
        parsed.every((device: GpuSpecification): boolean => device.availableVramBytes === null),
    ).toBe(true);
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(parsed.every(Object.isFrozen)).toBe(true);
    expect(WindowsGpuInventory.parse('[]')).toEqual([]);
});

it('native output rejects unknown vendors, duplicate identities, unsafe quantities and oversized collections', (): void => {
    const gpu: GpuSpecification | undefined = devices[0];
    if (gpu === undefined) {
        throw new Error('GPU fixture required');
    }
    for (const invalid of [
        null,
        [gpu, gpu],
        Array.from({ length: 33 }, (): GpuSpecification => gpu),
        [{ ...gpu, vendor: 'unrecognized' }],
        [{ ...gpu, id: '../../physical/device' }],
        [{ ...gpu, totalVramBytes: 34359738368 }],
        [{ ...gpu, totalVramBytes: '034359738368' }],
        [{ ...gpu, availableVramBytes: '34359738369' }],
        [{ ...gpu, model: 'GPU\nscript' }],
        [{ ...gpu, sharedSystemMemory: '68719476736' }],
    ]) {
        expect((): readonly GpuSpecification[] =>
            WindowsGpuInventory.parse(JSON.stringify(invalid)),
        ).toThrow();
    }
    expect((): readonly GpuSpecification[] => WindowsGpuInventory.parse(' '.repeat(32769))).toThrow(
        'byte limit',
    );
});

it('free NVIDIA VRAM is added only for an unambiguous matching name and capacity', (): void => {
    const device: GpuSpecification | undefined = devices[0];
    if (device === undefined) {
        throw new Error('NVIDIA fixture required');
    }
    const sample: GpuSpecification = {
        ...device,
        id: 'GPU-12345678-1234-1234-1234-123456789abc',
        availableVramBytes: '1073741824',
    };
    expect(WindowsGpuInventory.enrich(devices, [sample])[0]?.availableVramBytes).toBe('1073741824');
    expect(WindowsGpuInventory.enrich(devices, [sample])[1]).toEqual(devices[1]);
    for (const samples of [
        [sample, sample],
        [{ ...sample, model: 'Different GPU' }],
        [{ ...sample, totalVramBytes: '8589934592' }],
    ]) {
        expect(WindowsGpuInventory.enrich(devices, samples)).toEqual(devices);
    }
    const duplicate: readonly GpuSpecification[] = [
        device,
        { ...device, id: 'DXGI-FFFFFFFF-00000008' },
    ];
    expect(WindowsGpuInventory.enrich(duplicate, [sample])).toEqual(duplicate);
});

it.skipIf(process.platform !== 'win32')(
    'the real pinned Windows helper enumerates DXGI adapters without a shell',
    async (): Promise<void> => {
        const result: readonly GpuSpecification[] = await WindowsGpuInventory.read(
            AbortSignal.timeout(5000),
        );
        expect(result.length).toBeLessThanOrEqual(32);
        expect(new Set(result.map((device: GpuSpecification): string => device.id)).size).toBe(
            result.length,
        );
    },
);
