// SPDX-FileCopyrightText: 2026 Dacely <business@dacely.com>
// SPDX-License-Identifier: LicenseRef-Proprietary

import { randomBytes } from 'node:crypto';
import { HostReadRevision } from './HostReadRevision.js';

/** Separate native handle families cannot be attached by guessing a same-named process identifier. */
export const HostReadObservationKind = { Process: 'process', Terminal: 'terminal' } as const;
/** The runtime mapping defines the only supported native observation families. */
export type HostReadObservationKind =
    (typeof HostReadObservationKind)[keyof typeof HostReadObservationKind];

/** Cached metadata identifies one actual native workspace lifetime, never the latest device connection. */
export interface HostReadObservationState {
    readonly runtimeId: string;
    readonly processId: string;
    readonly kind: HostReadObservationKind;
    readonly revision: bigint;
}

/** Trusted local handles are metadata only; signed delivery must still authorize the account, private owner, grant, lease and original receipt. */
export interface HostReadObservationSource {
    /** Local cached identity is correlation only and conveys no fresh operation authority. */
    state(): HostReadObservationState;
    /** Local metadata waits run outside the effect lane; callers must freshly authorize any remote delivery. */
    wait(
        afterRevision: bigint,
        signal: AbortSignal,
        maximumMs?: number,
    ): Promise<HostReadObservationState>;
}

/** One workspace bounds all read-side waiters and pins the actual native runtime independently from connection renewals. */
export class HostReadObservation implements AsyncDisposable {
    readonly #runtimeId: string = randomBytes(32).toString('base64url');
    readonly #stop: AbortController = new AbortController();
    readonly #pending: Set<Promise<undefined>> = new Set();

    /** The actual workspace owner publishes this nonce in its signed companion capability before native sources are admitted. */
    public get runtimeId(): string {
        this.#stop.signal.throwIfAborted();
        return this.#runtimeId;
    }

    /** Capture is called only after the workspace has authorized and found the exact retained native owner. */
    public capture(
        processId: string,
        kind: HostReadObservationKind,
        revision: HostReadRevision,
    ): HostReadObservationSource {
        if (
            !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/u.test(processId) ||
            !Object.values(HostReadObservationKind).includes(kind)
        ) {
            throw new Error('Invalid native read observation identity');
        }
        this.#state(processId, kind, revision);
        return Object.freeze({
            state: (): HostReadObservationState => this.#state(processId, kind, revision),
            wait: (
                afterRevision: bigint,
                signal: AbortSignal,
                maximumMs: number = HostReadRevision.maximumWaitMs,
            ): Promise<HostReadObservationState> =>
                this.#wait(processId, kind, revision, afterRevision, signal, maximumMs),
        });
    }

    /** Shutdown revokes every captured metadata handle and joins waiter disposal without touching native ownership. */
    public async [Symbol.asyncDispose](): Promise<void> {
        this.#stop.abort(new Error('Native read observation owner is unavailable'));
        await Promise.all(this.#pending);
    }

    #state(
        processId: string,
        kind: HostReadObservationKind,
        revision: HostReadRevision,
    ): HostReadObservationState {
        this.#stop.signal.throwIfAborted();
        return { runtimeId: this.#runtimeId, processId, kind, revision: revision.current };
    }

    async #wait(
        processId: string,
        kind: HostReadObservationKind,
        revision: HostReadRevision,
        afterRevision: bigint,
        signal: AbortSignal,
        maximumMs: number,
    ): Promise<HostReadObservationState> {
        signal.throwIfAborted();
        this.#stop.signal.throwIfAborted();
        if (
            !Number.isSafeInteger(maximumMs) ||
            maximumMs < 1 ||
            maximumMs > HostReadRevision.maximumWaitMs
        ) {
            throw new Error('Invalid native read observation deadline');
        }
        if (this.#pending.size >= HostReadRevision.maximumWaiters) {
            throw new Error('Native workspace observation waiter limit reached');
        }
        const finished: PromiseWithResolvers<undefined> = Promise.withResolvers<undefined>();
        this.#pending.add(finished.promise);
        const active: AbortSignal = AbortSignal.any([signal, this.#stop.signal]);
        try {
            await revision.wait(afterRevision, active, maximumMs);
            active.throwIfAborted();
            return this.#state(processId, kind, revision);
        } finally {
            this.#pending.delete(finished.promise);
            finished.resolve(undefined);
        }
    }
}
