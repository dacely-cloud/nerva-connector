// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

/** Local read hints are finite metadata; they neither consume byte cursors nor prove EOF or process-tree state. */
export class HostReadRevision implements Disposable {
    /** The subscription budget is independent from process input, effect admission and output ring capacity. */
    public static readonly maximumWaiters: number = 32;
    /** A native waiter cannot retain a caller or listener indefinitely without a fresh observation. */
    public static readonly maximumWaitMs: number = 25000;
    readonly #waiters: Set<PromiseWithResolvers<bigint>> = new Set();
    readonly #listeners: Set<() => void> = new Set();
    #revision: bigint = 0n;
    #closed: boolean = false;

    /** Whether the owner released this revision; no later change will be reported. */
    public get closed(): boolean {
        return this.#closed;
    }

    /**
     * Calls `listener` after every advance and once on release, for the owning workspace only.
     *
     * @remarks
     * Separate from the bounded external waiters, so the owner's own bookkeeping never takes a slot a native read
     * observer could use. A listener that throws is ignored.
     *
     * @returns Stops the notifications
     */
    public subscribe(listener: () => void): () => void {
        if (this.#closed) {
            queueMicrotask(listener);
            return (): void => undefined;
        }
        this.#listeners.add(listener);
        return (): void => {
            this.#listeners.delete(listener);
        };
    }

    /** Only this actual retained owner supplies a revision; closed ownership is unavailable rather than an invented terminal state. */
    public get current(): bigint {
        this.#active();
        return this.#revision;
    }

    /** Actual local changes advance once; overflow disables observation without disrupting native I/O or inventing a wrapped counter. */
    public advance(): void {
        if (this.#closed) {
            return;
        }
        if (this.#revision === 9223372036854775807n) {
            this[Symbol.dispose]();
            return;
        }
        this.#revision += 1n;
        for (const waiter of this.#waiters) {
            waiter.resolve(this.#revision);
        }
        this.#waiters.clear();
        this.#notify();
    }

    /** Capture the revision before the separately authorized byte read, then wait at that exact revision to avoid lost wakes. */
    public async wait(
        afterRevision: bigint,
        signal: AbortSignal,
        maximumMs: number = HostReadRevision.maximumWaitMs,
    ): Promise<bigint> {
        signal.throwIfAborted();
        this.#active();
        if (
            typeof afterRevision !== 'bigint' ||
            afterRevision < 0n ||
            afterRevision > this.#revision ||
            !Number.isSafeInteger(maximumMs) ||
            maximumMs < 1 ||
            maximumMs > HostReadRevision.maximumWaitMs
        ) {
            throw new Error('Invalid native read observation revision or deadline');
        }
        if (afterRevision < this.#revision) {
            return this.#revision;
        }
        if (this.#waiters.size >= HostReadRevision.maximumWaiters) {
            throw new Error('Native read observation waiter limit reached');
        }
        const result: PromiseWithResolvers<bigint> = Promise.withResolvers<bigint>();
        const abort: () => void = (): void => result.reject(signal.reason);
        const timer: NodeJS.Timeout = setTimeout((): void => {
            if (this.#closed) {
                result.reject(new Error('Native read observation is unavailable'));
            } else {
                result.resolve(this.#revision);
            }
        }, maximumMs);
        this.#waiters.add(result);
        signal.addEventListener('abort', abort, { once: true });
        try {
            return await result.promise;
        } finally {
            clearTimeout(timer);
            signal.removeEventListener('abort', abort);
            this.#waiters.delete(result);
        }
    }

    /** Release rejects and detaches every waiter; it makes no claim that output or a native tree was fully observed. */
    public [Symbol.dispose](): void {
        if (this.#closed) {
            return;
        }
        this.#closed = true;
        for (const waiter of this.#waiters) {
            waiter.reject(new Error('Native read observation is unavailable'));
        }
        this.#waiters.clear();
        this.#notify();
        this.#listeners.clear();
    }

    #notify(): void {
        for (const listener of [...this.#listeners]) {
            try {
                listener();
            } catch {
                /** Owner bookkeeping never interrupts native I/O or other listeners. */
                continue;
            }
        }
    }

    #active(): void {
        if (this.#closed) {
            throw new Error('Native read observation is unavailable');
        }
    }
}
