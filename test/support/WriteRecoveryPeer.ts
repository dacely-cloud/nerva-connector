// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

import { ConnectorOperationJournal } from '../../src/runtime/ConnectorOperationJournal.js';
import { ConnectorClient } from '../../src/runtime/ConnectorClient.js';
import type { ConnectorClientState } from '../../src/runtime/ConnectorClientState.js';
import type { ConnectorOperationDispatch } from '../../src/runtime/ConnectorOperationCodec.js';
import { ConnectorFileJobsCodec } from 'nerva-connector-protocol/protocol/ConnectorFileJobsCodec.js';
import { ConnectorFilesCodec } from 'nerva-connector-protocol/protocol/ConnectorFilesCodec.js';
import type { ConnectorFileResponse } from 'nerva-connector-protocol/protocol/ConnectorFiles.js';

/** This test-only barrier stops after the real native effect, before the durable result commit. Production code has no fault hook. */
ConnectorOperationJournal.prototype.finish = async function <TRequest, TResponse>(
    this: ConnectorOperationJournal<TRequest, TResponse>,
    permit: ConnectorOperationDispatch<TRequest>,
    response: TResponse,
): Promise<TResponse> {
    const request: ReturnType<typeof ConnectorFileJobsCodec.operation> =
        ConnectorFileJobsCodec.operation(permit.request);
    const raw: unknown = JSON.parse(
        JSON.stringify(response, (_key: string, value: unknown): unknown =>
            typeof value === 'bigint' ? value.toString() : value,
        ),
    );
    const normalized: ConnectorFileResponse = ConnectorFilesCodec.response(raw, request);
    if (ConnectorFilesCodec.isMutation(request.action) && normalized.ok) {
        process.stdout.write(JSON.stringify({ state: 'qualification-write-prepared' }) + '\n');
        return await Promise.withResolvers<TResponse>().promise;
    }
    throw new Error('Write qualification requires a successful native mutation');
};

const args: readonly string[] = process.argv.slice(2);
if (args.length !== 3 || args[0] !== 'run' || args[1] !== '--config' || args[2] === undefined) {
    throw new Error('Explicit write qualification configuration required');
}
const stop: AbortController = new AbortController();
process.once('SIGINT', (): void => stop.abort());
process.once('SIGTERM', (): void => stop.abort());
await using client: ConnectorClient = await ConnectorClient.load(
    args[2],
    (state: ConnectorClientState): void => {
        process.stdout.write(JSON.stringify({ state }) + '\n');
    },
);
await client.run(stop.signal);
