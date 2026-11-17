// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

import { Duplex } from 'node:stream';

/** Holds one actual outbound FFI frame; all readiness and acceptance events remain native bytes. */
export class ExecutionPipeDelayedBroker extends Duplex {
    readonly #held: PromiseWithResolvers<undefined> = Promise.withResolvers<undefined>();
    #armed: boolean = false;
    #frame: Buffer | null = null;
    #completion: ((error?: Error | null) => void) | null = null;
    #writes: number = 0;
    #blockedResponses: boolean = false;

    public constructor(public readonly source: Duplex) {
        super({ readableHighWaterMark: 4096, writableHighWaterMark: 8193 });
        source.on('data', (value: unknown): void => {
            if (!Buffer.isBuffer(value) || value.byteLength > 4096) {
                this.destroy(new Error('Test native event buffer exceeded'));
                return;
            }
            if (!this.push(value)) {
                source.pause();
            }
        });
        source.once('end', (): void => {
            this.push(null);
        });
        source.once('close', (): void => {
            this.destroy();
        });
        source.once('error', (error: Error): void => {
            this.destroy(error);
        });
    }

    /** Counts writes to the actual native descriptor, excluding a held Node-side command. */
    public get writes(): number {
        return this.#writes;
    }

    /** One bounded command may be delayed once per owned test broker. */
    public arm(): void {
        if (this.#armed || this.#frame !== null || this.#completion !== null) {
            throw new Error('Test broker already armed');
        }
        this.#armed = true;
    }

    /** Resolves after the real handle supplied the frame, before any native write. */
    public get held(): Promise<void> {
        return this.#held.promise;
    }

    /** At most one additional exact wrapper may accompany the first queued command. */
    public release(extra: string = ''): void {
        const frame: Buffer | null = this.#frame;
        const completion: ((error?: Error | null) => void) | null = this.#completion;
        if (frame === null || completion === null || Buffer.byteLength(extra) > 8193) {
            throw new Error('No bounded test frame held');
        }
        this.#frame = null;
        this.#completion = null;
        this.#writes++;
        this.source.write(Buffer.concat([frame, Buffer.from(extra)]), completion);
    }

    /** A finite duplicate flood blocks real receipts without manufacturing acceptance events. */
    public blockAndFlood(encoded: string): Promise<undefined> {
        const size: number = Buffer.byteLength(encoded);
        if (size === 0 || size > 8193 || this.#frame !== null) {
            throw new Error('Bounded duplicate command required');
        }
        const count: number = Math.floor(1048576 / size);
        const bytes: Buffer = Buffer.from(encoded.repeat(count));
        const done: PromiseWithResolvers<undefined> = Promise.withResolvers<undefined>();
        this.#blockedResponses = true;
        this.source.pause();
        this.#writes++;
        this.source.write(bytes, (error: Error | null | undefined): void => {
            if (error !== null && error !== undefined) {
                done.reject(error);
            } else {
                done.resolve(undefined);
            }
        });
        return done.promise;
    }

    /** Resume bounded native reads only when the actual owner consumes them. */
    public override _read(): void {
        if (!this.#blockedResponses) {
            this.source.resume();
        }
    }

    /** Unknown is validated at this Node stream boundary before any native descriptor write. */
    public override _write(
        value: unknown,
        _encoding: BufferEncoding,
        callback: (error?: Error | null) => void,
    ): void {
        if (!Buffer.isBuffer(value) || value.byteLength > 8193) {
            callback(new Error('Test native command buffer exceeded'));
            return;
        }
        if (this.#armed) {
            this.#armed = false;
            this.#frame = Buffer.from(value);
            this.#completion = callback;
            this.#held.resolve(undefined);
            return;
        }
        this.#writes++;
        this.source.write(value, callback);
    }

    /** Releasing the test proxy always releases the exact borrowed descriptor and held callback. */
    public override _destroy(error: Error | null, callback: (error?: Error | null) => void): void {
        const completion: ((error?: Error | null) => void) | null = this.#completion;
        this.#completion = null;
        this.#frame = null;
        completion?.(error ?? new Error('Test broker closed with a queued command'));
        this.source.destroy();
        callback(error);
    }
}
