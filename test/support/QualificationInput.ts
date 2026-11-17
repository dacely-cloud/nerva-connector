// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

import { ExchangeLimits } from 'nerva-connector-protocol/remote/ExchangeFormat.js';

/** Reads one bounded frame from the exact SSH stdin, without an unbounded line buffer or inherited operation context. */
export class QualificationInput {
    public static async read(): Promise<Buffer> {
        process.stdin.pause();
        const buffer: Buffer = Buffer.alloc(ExchangeLimits.frameBytes + 1);
        const pending: PromiseWithResolvers<Buffer> = Promise.withResolvers<Buffer>();
        const signal: AbortSignal = AbortSignal.timeout(10000);
        let offset: number = 0;
        const abort: () => void = (): void =>
            pending.reject(new Error('Qualification input expired'));
        const data: (bytes: Buffer) => void = (bytes: Buffer): void => {
            if (!Buffer.isBuffer(bytes) || bytes.byteLength > buffer.byteLength - offset) {
                pending.reject(new Error('Qualification input exceeds its bound'));
                process.stdin.destroy();
                return;
            }
            const newline: number = bytes.indexOf(10);
            if (newline >= 0 && newline !== bytes.byteLength - 1) {
                pending.reject(new Error('Qualification frames cannot be pipelined'));
                process.stdin.destroy();
                return;
            }
            buffer.set(bytes, offset);
            offset += bytes.byteLength;
            if (newline >= 0) {
                process.stdin.pause();
                pending.resolve(buffer.subarray(0, offset - 1));
            }
        };
        const end: () => void = (): void =>
            pending.reject(new Error('Incomplete qualification frame'));
        const error: (caught: Error) => void = (caught: Error): void => pending.reject(caught);
        signal.addEventListener('abort', abort, { once: true });
        process.stdin.on('data', data).once('end', end).once('error', error);
        process.stdin.resume();
        try {
            return await pending.promise;
        } finally {
            signal.removeEventListener('abort', abort);
            process.stdin.off('data', data).off('end', end).off('error', error);
            process.stdin.pause();
        }
    }
}
