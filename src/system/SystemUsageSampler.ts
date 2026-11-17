// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

import { cpus, type CpuInfo } from 'node:os';
import { setTimeout as sleep } from 'node:timers/promises';
import type {
    GpuSpecification,
    GpuUsage,
    SystemUsage,
} from 'nerva-connector-protocol/system/SystemSpecification.js';
import { GpuLoad } from './GpuLoad.js';
import { NetworkCounters, type NetworkTotals } from './NetworkCounters.js';

/** Cumulative counters at one moment; rates come from the difference between two of them. */
export interface UsageCounters {
    readonly atMs: number;
    readonly cpuBusyMs: number;
    readonly cpuTotalMs: number;
    readonly network: NetworkTotals | null;
}

/**
 * Measures how busy the computer was since the previous sample.
 *
 * @remarks
 * The first sample, or one after a long gap, measures a short fresh interval so it is never
 * empty. Samples are serialized, so two concurrent reports cannot share or corrupt one baseline.
 */
export class SystemUsageSampler {
    static readonly #firstIntervalMs: number = 500;
    static readonly #maximumIntervalMs: number = 600000;
    static readonly #wrap32: bigint = 4294967296n;
    #previous: UsageCounters | null = null;
    #queue: Promise<unknown> = Promise.resolve();

    /** Samples CPU, network and per-GPU load together for one report. */
    public sample(gpus: readonly GpuSpecification[], signal: AbortSignal): Promise<SystemUsage> {
        const next: Promise<SystemUsage> = this.#queue.then((): Promise<SystemUsage> =>
            this.#sample(gpus, signal),
        );
        this.#queue = next.catch((): void => {});
        return next;
    }

    /** Builds the usage between two counter snapshots, or null rates where a counter regressed. */
    public static between(
        previous: UsageCounters,
        current: UsageCounters,
        gpus: readonly GpuUsage[],
    ): SystemUsage {
        const interval: number = Math.max(1, current.atMs - previous.atMs);
        const total: number = current.cpuTotalMs - previous.cpuTotalMs;
        const busy: number = current.cpuBusyMs - previous.cpuBusyMs;
        const cpu: number =
            total <= 0 ? 0 : Math.min(10000, Math.max(0, Math.round((busy * 10000) / total)));
        return Object.freeze({
            sampledAtMs: BigInt(current.atMs).toString(),
            intervalMs: Math.min(this.#maximumIntervalMs, interval),
            cpuBasisPoints: cpu,
            networkReceiveBytesPerSecond: this.#rate(
                previous.network?.receivedBytes,
                current.network?.receivedBytes,
                current.network?.wraps32 === true,
                interval,
            ),
            networkTransmitBytesPerSecond: this.#rate(
                previous.network?.transmittedBytes,
                current.network?.transmittedBytes,
                current.network?.wraps32 === true,
                interval,
            ),
            gpus,
        });
    }

    async #sample(gpus: readonly GpuSpecification[], signal: AbortSignal): Promise<SystemUsage> {
        signal.throwIfAborted();
        let previous: UsageCounters | null = this.#previous;
        if (
            previous === null ||
            Date.now() - previous.atMs > SystemUsageSampler.#maximumIntervalMs ||
            Date.now() - previous.atMs < 100
        ) {
            previous = await this.#counters(signal);
            await sleep(SystemUsageSampler.#firstIntervalMs, undefined, { signal });
        }
        const [current, loads]: readonly [UsageCounters, readonly GpuUsage[]] = await Promise.all([
            this.#counters(signal),
            GpuLoad.read(gpus, signal),
        ]);
        this.#previous = current;
        return SystemUsageSampler.between(previous, current, loads);
    }

    async #counters(signal: AbortSignal): Promise<UsageCounters> {
        let network: NetworkTotals | null;
        try {
            network = await NetworkCounters.read(signal);
        } catch {
            signal.throwIfAborted();
            network = null;
        }
        let busy: number = 0;
        let total: number = 0;
        for (const processor of cpus() as readonly CpuInfo[]) {
            const times: CpuInfo['times'] = processor.times;
            const all: number = times.user + times.nice + times.sys + times.idle + times.irq;
            busy += all - times.idle;
            total += all;
        }
        return Object.freeze({ atMs: Date.now(), cpuBusyMs: busy, cpuTotalMs: total, network });
    }

    static #rate(
        before: bigint | undefined,
        after: bigint | undefined,
        wraps32: boolean,
        intervalMs: number,
    ): string | null {
        if (before === undefined || after === undefined) {
            return null;
        }
        const delta: bigint | null =
            after >= before
                ? after - before
                : wraps32 && before < this.#wrap32 && after < this.#wrap32
                  ? after + this.#wrap32 - before
                  : null;
        return delta === null ? null : ((delta * 1000n) / BigInt(intervalMs)).toString();
    }
}
