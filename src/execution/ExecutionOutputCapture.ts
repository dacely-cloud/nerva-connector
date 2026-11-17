// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

import type { ExecutionOutput, ExecutionOutputSink } from './ExecutionOutput.js';
import { ExecutionOutputRetentionError } from './ExecutionOutputRetentionError.js';

/** One coalesced prefix write at a time bounds disk work while native deadlines remain independent of storage latency. */
export class ExecutionOutputCapture {
    #timer: NodeJS.Timeout | null = null;
    #task: Promise<void> | null = null;
    #dirty: boolean = false;
    #closed: boolean = false;
    #failed: boolean = false;

    /** Sample reads only accepted application bytes after native readiness; failure immediately stops the exact native command. */
    public constructor(
        public readonly sink: ExecutionOutputSink | null,
        public readonly sample: () => ExecutionOutput,
        public readonly stop: () => void,
    ) {}

    /** Multiple pipe chunks share one write every 250ms; neither chunk count nor storage backlog accumulates. */
    public changed(): void {
        if (this.sink === null || this.#closed || this.#failed) {
            return;
        }
        this.#dirty = true;
        if (this.#timer === null && this.#task === null) {
            this.#timer = setTimeout((): void => {
                this.#timer = null;
                this.#start();
            }, 250);
        }
    }

    /** Child close joins every retained prefix and flushes the final tail before returning a terminal result. */
    public async finish(): Promise<void> {
        this.#closed = true;
        if (this.#timer !== null) {
            clearTimeout(this.#timer);
            this.#timer = null;
        }
        await this.#task;
        if (this.#dirty && !this.#failed) {
            this.#start();
            await this.#task;
        }
        if (this.#failed) {
            throw new ExecutionOutputRetentionError();
        }
    }

    #start(): void {
        this.#dirty = false;
        const finished: PromiseWithResolvers<undefined> = Promise.withResolvers<undefined>();
        this.#task = finished.promise;
        void this.#retain(finished);
    }
    async #retain(finished: PromiseWithResolvers<undefined>): Promise<void> {
        try {
            const output: ExecutionOutput = this.sample();
            if (output.stdoutBase64 !== '' || output.stderrBase64 !== '') {
                await this.sink?.retain(output);
            }
        } catch {
            this.#failed = true;
            this.stop();
        } finally {
            this.#task = null;
            finished.resolve(undefined);
            if (this.#dirty && !this.#closed && !this.#failed) {
                this.changed();
            }
        }
    }
}
