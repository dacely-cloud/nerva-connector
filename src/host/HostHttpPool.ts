// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

import { randomUUID } from 'node:crypto';
import { Resolver } from 'node:dns/promises';
import { isIP } from 'node:net';
import type {
    HostHttpHead,
    HostHttpRead,
    HostHttpRequest,
    HostHttpTrust,
} from './HostHttpTypes.js';
import { HostHttpTransfer } from './HostHttpTransfer.js';
import { HostHttpValidation } from './HostHttpValidation.js';

/** A workspace owns at most eight actual HTTP connections and eight cancelable local DNS resolutions. */
export class HostHttpPool implements AsyncDisposable {
    readonly #transfers: Map<string, HostHttpTransfer> = new Map();
    readonly #resolvers: Set<Resolver> = new Set();
    readonly #pending: Set<Promise<void>> = new Set();
    readonly #expiry: Map<string, NodeJS.Timeout> = new Map();
    readonly #cleanupFailures: Map<string, Error> = new Map();
    #closed: boolean = false;

    /** Application-owned extra TLS trust never appears in a remote request or replaces hostname verification. */
    public constructor(public readonly trust?: HostHttpTrust) {}

    /** Uses the actual host's DNS servers; cancellation joins both address-family queries. */
    public async resolve(hostname: string, signal: AbortSignal): Promise<readonly string[]> {
        HostHttpValidation.hostname(hostname);
        return await this.#run(async (): Promise<readonly string[]> => {
            signal.throwIfAborted();
            if (isIP(hostname) !== 0) {
                return [hostname];
            }
            if (this.#resolvers.size >= 8) {
                throw new Error('Native DNS capacity reached');
            }
            const resolver: Resolver = new Resolver({ timeout: 3000, tries: 2 });
            this.#resolvers.add(resolver);
            const cancel: () => void = (): void => resolver.cancel();
            const timer: NodeJS.Timeout = setTimeout(cancel, 10000);
            signal.addEventListener('abort', cancel, { once: true });
            try {
                const results: readonly PromiseSettledResult<string[]>[] = await Promise.allSettled(
                    [resolver.resolve4(hostname), resolver.resolve6(hostname)],
                );
                signal.throwIfAborted();
                if (this.#closed) {
                    throw new Error('Native DNS owner closed');
                }
                const addresses: Set<string> = new Set();
                for (const result of results) {
                    if (result.status === 'fulfilled') {
                        for (const address of result.value) {
                            if (
                                isIP(address) === 0 ||
                                address.includes('%') ||
                                addresses.size >= 64
                            ) {
                                throw new Error('Invalid or excessive native DNS addresses');
                            }
                            addresses.add(address);
                        }
                    }
                }
                if (addresses.size === 0) {
                    throw new Error('Native DNS resolution failed');
                }
                return [...addresses];
            } finally {
                clearTimeout(timer);
                signal.removeEventListener('abort', cancel);
                resolver.cancel();
                this.#resolvers.delete(resolver);
            }
        });
    }

    /** Ownership is registered before opening the connection; no uncertain transfer is restarted. */
    public async open(input: HostHttpRequest, signal: AbortSignal): Promise<HostHttpHead> {
        HostHttpValidation.request(input);
        return await this.#run(async (): Promise<HostHttpHead> => {
            if (this.#transfers.size >= 8) {
                throw new Error('Native HTTP capacity reached; close retained transfers');
            }
            const request: HostHttpRequest = Object.freeze({
                ...input,
                headers: Object.freeze({ ...input.headers }),
            });
            const transfer: HostHttpTransfer = new HostHttpTransfer(randomUUID(), request);
            this.#transfers.set(transfer.id, transfer);
            this.#expiry.set(
                transfer.id,
                setTimeout((): void => {
                    const pending: Promise<void> = this.#expire(transfer.id);
                    this.#pending.add(pending);
                    void this.#reap(pending);
                }, input.timeoutMs),
            );
            try {
                return await transfer.start(signal, this.trust);
            } catch (caught: unknown) {
                if (this.#transfers.get(transfer.id) === transfer) {
                    await this.close(transfer.id);
                }
                throw caught;
            }
        });
    }

    /** Caller offsets cannot read another lifetime or turn a failed body into an empty successful response. */
    public read(transferId: string, offset: bigint, maximum: number): HostHttpRead {
        this.#assertOpen();
        const transfer: HostHttpTransfer | undefined = this.#transfers.get(transferId);
        if (transfer === undefined) {
            throw new Error('Native HTTP transfer is unavailable');
        }
        return transfer.read(offset, maximum);
    }

    /** A successful close means the exact request and socket have physically closed. */
    public async close(transferId: string): Promise<void> {
        const transfer: HostHttpTransfer | undefined = this.#transfers.get(transferId);
        if (transfer === undefined) {
            throw new Error('Native HTTP transfer is unavailable');
        }
        await transfer.close();
        const expiry: NodeJS.Timeout | undefined = this.#expiry.get(transferId);
        if (expiry !== undefined) {
            clearTimeout(expiry);
            this.#expiry.delete(transferId);
        }
        this.#transfers.delete(transferId);
        this.#cleanupFailures.delete(transferId);
    }

    /** Workspace teardown cancels DNS and every original HTTP owner before joining them. */
    public async [Symbol.asyncDispose](): Promise<void> {
        this.#closed = true;
        for (const expiry of this.#expiry.values()) {
            clearTimeout(expiry);
        }
        for (const resolver of this.#resolvers) {
            resolver.cancel();
        }
        const results: readonly PromiseSettledResult<void>[] = await Promise.allSettled(
            [...this.#transfers.keys()].map((id: string): Promise<void> => this.close(id)),
        );
        await Promise.allSettled(this.#pending);
        const failures: Error[] = [
            ...this.#cleanupFailures.values(),
            ...results
                .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
                .map((result: PromiseRejectedResult): Error => {
                    const reason: unknown = result.reason;
                    return reason instanceof Error
                        ? reason
                        : new Error('Native HTTP cleanup failed', { cause: reason });
                }),
        ];
        if (failures.length !== 0) {
            throw new AggregateError(failures, 'Native HTTP shutdown remains unconfirmed');
        }
    }

    async #expire(id: string): Promise<void> {
        if (!this.#transfers.has(id)) {
            return;
        }
        try {
            await this.close(id);
        } catch (caught: unknown) {
            this.#cleanupFailures.set(
                id,
                caught instanceof Error
                    ? caught
                    : new Error('Native HTTP expiry cleanup is unconfirmed', { cause: caught }),
            );
        }
    }

    async #reap(pending: Promise<void>): Promise<void> {
        try {
            await pending;
        } finally {
            this.#pending.delete(pending);
        }
    }

    async #run<T>(action: () => Promise<T>): Promise<T> {
        this.#assertOpen();
        const settled: PromiseWithResolvers<undefined> = Promise.withResolvers<undefined>();
        this.#pending.add(settled.promise);
        try {
            return await action();
        } finally {
            settled.resolve(undefined);
            this.#pending.delete(settled.promise);
        }
    }

    #assertOpen(): void {
        if (this.#closed) {
            throw new Error('Native HTTP workspace is closed');
        }
    }
}
