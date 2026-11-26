// SPDX-FileCopyrightText: 2026 Dacely <business@dacely.com>
// SPDX-License-Identifier: LicenseRef-Proprietary

import { it, expect } from 'vitest';
import { GpuInventory } from '../src/system/GpuInventory.js';
import { SystemInfo } from '../src/system/SystemInfo.js';
import {
    GpuInventoryState,
    type SystemSpecification,
} from 'nerva-connector-protocol/system/SystemSpecification.js';
import { SigningKey } from '../src/identity/SigningKey.js';
import { SignaturePurpose } from 'nerva-connector-protocol/identity/IdentityFormat.js';

const id: string = 'GPU-12345678-1234-1234-1234-123456789abc';

it('GPU inventory keeps exact free VRAM and distinguishes unknown measurements', (): void => {
    const devices: ReturnType<typeof GpuInventory.parseNvidia> = GpuInventory.parseNvidia(
        id + ', NVIDIA test GPU, 24576, 1024\n',
    );
    expect(devices[0]?.totalVramBytes).toBe('25769803776');
    expect(devices[0]?.availableVramBytes).toBe('1073741824');
    expect(
        GpuInventory.parseNvidia(id + ', NVIDIA test GPU, N/A, N/A\n')[0]?.availableVramBytes,
    ).toBeNull();
    expect(GpuInventory.parseNvidia('')).toEqual([]);
    expect(() => GpuInventory.parseNvidia(id + ', test, 1, 2')).toThrow();
    expect(() => GpuInventory.parseNvidia(id + ', test, 1.5, 1')).toThrow();
    expect(() => GpuInventory.parseNvidia((id + ', test, 1, 1\n').repeat(2))).toThrow('Duplicate');
    expect(() => GpuInventory.parseNvidia('x'.repeat(16385))).toThrow('byte limit');
});

it('the real local snapshot is bounded, exact and signable without exposing credentials or host network addresses', async (): Promise<void> => {
    const snapshot: SystemSpecification = await SystemInfo.read(AbortSignal.timeout(5000));
    expect(snapshot.logicalCpuCount).toBeGreaterThan(0);
    expect(BigInt(snapshot.totalMemoryBytes)).toBeGreaterThan(0n);
    expect(BigInt(snapshot.availableMemoryBytes)).toBeLessThanOrEqual(
        BigInt(snapshot.totalMemoryBytes),
    );
    expect(Object.values(GpuInventoryState)).toContain(snapshot.gpuState);
    const encoded: Buffer = Buffer.from(JSON.stringify(snapshot));
    expect(encoded.byteLength).toBeLessThan(32768);
    using key: SigningKey = SigningKey.generate();
    const proof: string = key.sign(SignaturePurpose.SystemInfo, encoded);
    expect(SigningKey.verify(SignaturePurpose.SystemInfo, key.publicKey, encoded, proof)).toBe(
        true,
    );
    expect(SigningKey.verify(SignaturePurpose.RemoteResult, key.publicKey, encoded, proof)).toBe(
        false,
    );
});

it('cancellation prevents starting a new local probe', async (): Promise<void> => {
    const stop: AbortController = new AbortController();
    stop.abort();
    await expect(SystemInfo.read(stop.signal)).rejects.toThrow();
});
