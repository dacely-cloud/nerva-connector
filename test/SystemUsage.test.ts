// SPDX-FileCopyrightText: 2026 Dacely <business@dacely.com>
// SPDX-License-Identifier: LicenseRef-Proprietary

import { expect, it } from 'vitest';
import { GpuLoad, type NvidiaLoad } from '../src/system/GpuLoad.js';
import { NetworkCounters } from '../src/system/NetworkCounters.js';
import { SystemInfo } from '../src/system/SystemInfo.js';
import { SystemSpecificationCodec } from 'nerva-connector-protocol/system/SystemSpecificationCodec.js';
import { SystemUsageSampler, type UsageCounters } from '../src/system/SystemUsageSampler.js';
import {
    GpuVendor,
    type GpuSpecification,
    type SystemSpecification,
    type SystemUsage,
} from 'nerva-connector-protocol/system/SystemSpecification.js';

const uuid: string = 'GPU-12345678-1234-1234-1234-123456789abc';

function gpu(id: string, model: string, totalVramBytes: string | null): GpuSpecification {
    return { id, vendor: GpuVendor.Nvidia, model, totalVramBytes, availableVramBytes: null };
}

it('parses NVIDIA load rows and keeps unknown readings unknown', (): void => {
    const loads: readonly NvidiaLoad[] = GpuLoad.parse(
        uuid +
            ', NVIDIA GeForce RTX 5090, 4096, 87\nGPU-22345678-1234-1234-1234-123456789abc, B, [N/A], [Not Supported]\n',
    );
    expect(loads[0]).toEqual({
        uuid,
        name: 'NVIDIA GeForce RTX 5090',
        usedVramBytes: 4294967296n,
        utilizationBasisPoints: 8700,
    });
    expect(loads[1]?.usedVramBytes).toBeNull();
    expect(loads[1]?.utilizationBasisPoints).toBeNull();
    expect((): unknown => GpuLoad.parse(uuid + ', A, 1, 101')).toThrow();
    expect((): unknown => GpuLoad.parse(uuid + ', A, 1.5, 1')).toThrow();
    expect((): unknown => GpuLoad.parse(uuid + ', A, 1')).toThrow();
});

it('attaches a load by driver UUID, or to the one adapter with that model, and never guesses', (): void => {
    const load: NvidiaLoad = {
        uuid,
        name: 'RTX',
        usedVramBytes: 2n,
        utilizationBasisPoints: 100,
    };
    expect(GpuLoad.attach([gpu(uuid, 'RTX', '4')], [load])).toEqual([
        { id: uuid, utilizationBasisPoints: 100, usedVramBytes: '2' },
    ]);
    const dxgi: string = 'DXGI-00000000-00011C11';
    expect(GpuLoad.attach([gpu(dxgi, 'RTX', '4')], [load])[0]?.id).toBe(dxgi);
    expect(
        GpuLoad.attach([gpu(dxgi, 'RTX', '4'), gpu('DXGI-00000000-00011C12', 'RTX', '4')], [load]),
    ).toEqual([]);
    expect(GpuLoad.attach([gpu(dxgi, 'RTX', '1')], [load])[0]?.usedVramBytes).toBeNull();
});

it('reads interface byte totals from Linux and from localized Windows netstat output', (): void => {
    const linux: string =
        'Inter-|   Receive  |  Transmit\n face |bytes packets|bytes\n' +
        '    lo: 999 1 0 0 0 0 0 0 999 1 0 0 0 0 0 0\n' +
        '  eth0: 1000 1 0 0 0 0 0 0 2000 1 0 0 0 0 0 0\n' +
        '  wlan0: 18446744073709551615 1 0 0 0 0 0 0 5 1 0 0 0 0 0 0\n';
    expect(NetworkCounters.parseLinux(linux)).toEqual({
        receivedBytes: 18446744073709552615n,
        transmittedBytes: 2005n,
        wraps32: false,
    });
    const windows: string =
        'Statistiques de l’interface\r\n\r\n                           Reçus            Envoyés\r\n\r\nOctets                    3471917046      1018432767\r\nPaquets unicast           1               2\r\n';
    expect(NetworkCounters.parseWindows(windows)).toEqual({
        receivedBytes: 3471917046n,
        transmittedBytes: 1018432767n,
        wraps32: true,
    });
    expect((): unknown => NetworkCounters.parseWindows('Interface Statistics\r\n')).toThrow();
});

it('turns two counter snapshots into a bounded CPU share and exact byte rates', (): void => {
    const before: UsageCounters = {
        atMs: 1000,
        cpuBusyMs: 100,
        cpuTotalMs: 1000,
        network: { receivedBytes: 4294967000n, transmittedBytes: 500n, wraps32: true },
    };
    const after: UsageCounters = {
        atMs: 3000,
        cpuBusyMs: 600,
        cpuTotalMs: 2000,
        network: { receivedBytes: 704n, transmittedBytes: 100n, wraps32: true },
    };
    const usage: SystemUsage = SystemUsageSampler.between(before, after, []);
    expect(usage.cpuBasisPoints).toBe(5000);
    expect(usage.intervalMs).toBe(2000);
    expect(usage.networkReceiveBytesPerSecond).toBe('500');
    expect(usage.networkTransmitBytesPerSecond).toBe('2147483448');
    const reset: SystemUsage = SystemUsageSampler.between(
        {
            ...before,
            network: { receivedBytes: 4294967000n, transmittedBytes: 500n, wraps32: false },
        },
        { ...after, network: { receivedBytes: 704n, transmittedBytes: 100n, wraps32: false } },
        [],
    );
    expect(reset.networkReceiveBytesPerSecond).toBeNull();
    expect(
        SystemUsageSampler.between({ ...before, network: null }, after, [])
            .networkTransmitBytesPerSecond,
    ).toBeNull();
});

it('a real snapshot carries a usage sample the receiver accepts', async (): Promise<void> => {
    const snapshot: SystemSpecification = await SystemInfo.read(AbortSignal.timeout(8000));
    expect(snapshot.usage).toBeDefined();
    if (snapshot.usage === undefined) {
        return;
    }
    expect(snapshot.usage.intervalMs).toBeGreaterThanOrEqual(100);
    expect(
        SystemSpecificationCodec.usage(
            snapshot.usage,
            BigInt(snapshot.observedAtMs),
            snapshot.gpus,
        ),
    ).toEqual(snapshot.usage);
    expect(SystemSpecificationCodec.read(JSON.parse(JSON.stringify(snapshot)))).toEqual(snapshot);
});
