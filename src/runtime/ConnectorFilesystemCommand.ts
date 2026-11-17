// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

import { ConnectorFilesystem } from './ConnectorFilesystem.js';
import type { ConnectorFileResponse } from 'nerva-connector-protocol/protocol/ConnectorFiles.js';

/** Local finite RPC entry point exercises the same policy owner intended for later authenticated dispatch. */
export class ConnectorFilesystemCommand {
    /** Operator-owned policy is loaded before bounded stdin is interpreted; shutdown joins owned children. */
    public static async run(path: string, signal: AbortSignal): Promise<void> {
        await using service: ConnectorFilesystem = await ConnectorFilesystem.load(path, []);
        const input: PromiseWithResolvers<string> = Promise.withResolvers<string>();
        const chunks: Buffer[] = [];
        let size: number = 0;
        const abort: () => void = (): void => {
            input.reject(new Error('Local connector file request cancelled'));
            process.stdin.destroy();
        };
        signal.addEventListener('abort', abort, { once: true });
        process.stdin.on('data', (raw: unknown): void => {
            if (!Buffer.isBuffer(raw) || (size += raw.byteLength) > 8192) {
                input.reject(new Error('Local connector file input exceeds policy'));
                process.stdin.destroy();
                return;
            }
            chunks.push(raw);
        });
        process.stdin.once('end', (): void => {
            try {
                input.resolve(
                    new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, size)),
                );
            } catch {
                input.reject(new Error('Invalid connector file encoding'));
            }
        });
        process.stdin.once('error', (): void =>
            input.reject(new Error('Local connector input unavailable')),
        );
        if (signal.aborted) {
            abort();
        }
        try {
            const response: ConnectorFileResponse = await service.dispatch(await input.promise);
            process.stdout.write(
                JSON.stringify(response, (_key: string, value: unknown): unknown =>
                    typeof value === 'bigint' ? value.toString() : value,
                ) + '\n',
            );
        } finally {
            signal.removeEventListener('abort', abort);
        }
    }
}
