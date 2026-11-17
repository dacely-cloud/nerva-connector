// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

import { arch, cpus, freemem, platform, release, totalmem, type CpuInfo } from 'node:os';
import {
    GpuInventoryState,
    SystemPlatform,
    type GpuSpecification,
    type SystemSpecification,
    type SystemUsage,
} from 'nerva-connector-protocol/system/SystemSpecification.js';
import { GpuInventory } from './GpuInventory.js';
import { WindowsGpuInventory } from './WindowsGpuInventory.js';
import { NvidiaSmi } from './NvidiaSmi.js';
import { SystemUsageSampler } from './SystemUsageSampler.js';
import { SystemSpecificationCodec } from 'nerva-connector-protocol/system/SystemSpecificationCodec.js';

/** Bounded local metadata gathering uses OS APIs and fixed read-only executables, never a shell. */
export class SystemInfo {
    /** One process-wide baseline, because CPU and network counters are process-independent. */
    static readonly #usage: SystemUsageSampler = new SystemUsageSampler();
    /** The caller signs this snapshot before publication; this operation grants no execution or filesystem authority. */
    public static async read(signal: AbortSignal): Promise<SystemSpecification> {
        signal.throwIfAborted();
        const processors: readonly CpuInfo[] = cpus();
        if (processors.length < 1 || processors.length > 4096) {
            throw new Error('Unsupported processor inventory');
        }
        const hostPlatform: NodeJS.Platform = platform();
        let gpuState: GpuInventoryState = GpuInventoryState.Unavailable;
        let gpus: readonly GpuSpecification[] = Object.freeze([]);
        if (hostPlatform === 'linux') {
            try {
                const csv: string | null = await NvidiaSmi.query(
                    ['uuid', 'name', 'memory.total', 'memory.free'],
                    signal,
                );
                if (csv === null) {
                    throw new Error('NVIDIA inventory tool is not installed');
                }
                gpus = GpuInventory.parseNvidia(csv);
                gpuState = GpuInventoryState.Reported;
            } catch {
                signal.throwIfAborted();
            }
        } else if (hostPlatform === 'win32') {
            try {
                gpus = await WindowsGpuInventory.read(signal);
                gpuState = GpuInventoryState.Reported;
            } catch {
                signal.throwIfAborted();
            }
        }
        const usage: SystemUsage | undefined = await this.#sample(gpus, signal);
        signal.throwIfAborted();
        const total: string = this.#memory(totalmem());
        const available: string = this.#memory(freemem());
        if (BigInt(available) > BigInt(total)) {
            throw new Error('Available system memory exceeds capacity');
        }
        const observed: bigint = BigInt(Date.now());
        return Object.freeze({
            observedAtMs: observed.toString(),
            platform:
                hostPlatform === 'linux'
                    ? SystemPlatform.Linux
                    : hostPlatform === 'win32'
                      ? SystemPlatform.Windows
                      : hostPlatform === 'darwin'
                        ? SystemPlatform.MacOs
                        : SystemPlatform.Other,
            architecture: this.#text(arch()),
            osRelease: this.#text(release()),
            cpuModel: this.#text(processors[0]?.model ?? ''),
            logicalCpuCount: processors.length,
            totalMemoryBytes: total,
            availableMemoryBytes: available,
            gpuState,
            gpus,
            ...(usage === undefined || !this.#valid(usage, observed, gpus) ? {} : { usage }),
        });
    }

    /** A usage sample never prevents the specification itself from being reported. */
    static async #sample(
        gpus: readonly GpuSpecification[],
        signal: AbortSignal,
    ): Promise<SystemUsage | undefined> {
        try {
            return await this.#usage.sample(gpus, signal);
        } catch {
            signal.throwIfAborted();
            return undefined;
        }
    }

    /** The same validation the receiver applies, so an out-of-range sample is dropped, not rejected. */
    static #valid(
        usage: SystemUsage,
        observed: bigint,
        gpus: readonly GpuSpecification[],
    ): boolean {
        try {
            SystemSpecificationCodec.usage(usage, observed, gpus);
            return true;
        } catch {
            return false;
        }
    }

    static #memory(bytes: number): string {
        if (!Number.isSafeInteger(bytes) || bytes < 0) {
            throw new Error('System memory cannot be represented exactly');
        }
        return BigInt(bytes).toString();
    }

    static #text(value: string): string {
        if (
            value.length < 1 ||
            value.length > 256 ||
            Array.from(value).some((character: string): boolean => character.charCodeAt(0) < 32)
        ) {
            throw new Error('Invalid system specification text');
        }
        return value;
    }
}
