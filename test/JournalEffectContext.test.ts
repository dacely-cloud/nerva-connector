// SPDX-FileCopyrightText: 2026 Dacely <business@dacely.com>
// SPDX-License-Identifier: LicenseRef-Proprietary

import type { ConnectorJournalSnapshot } from '../src/runtime/ConnectorJournalState.js';
import type { ConnectorFileResponse } from 'nerva-connector-protocol/protocol/ConnectorFiles.js';
import type { ExecutionRequest } from 'nerva-connector-protocol/execution/ExecutionJobs.js';
import type { ConnectorEffectContext } from '../src/runtime/ConnectorEffectContext.js';
import { expect, it } from 'vitest';
import {
    ConnectorJournalState,
    ConnectorJournalSchema,
} from '../src/runtime/ConnectorJournalState.js';
import { ConnectorFileJournalCodec } from '../src/runtime/ConnectorFileJournalCodec.js';
import { ConnectorJournalMigrationCodec } from '../src/runtime/ConnectorJournalMigrationCodec.js';
import { ConnectorEffectKind } from '../src/runtime/ConnectorEffectContext.js';
import { ConnectorEffectContextCodec } from '../src/runtime/ConnectorEffectContextCodec.js';
import { ConnectorFileAction } from 'nerva-connector-protocol/protocol/ConnectorFileTypes.js';
import type { ConnectorFileOperation } from 'nerva-connector-protocol/protocol/ConnectorFileJobs.js';
import { ExecutionJournalCodec } from '../src/execution/ExecutionJournalCodec.js';
import { ExecutionLane } from 'nerva-connector-protocol/execution/ExecutionLane.js';
import { JournalEffectFixture } from './support/JournalEffectFixture.js';

const request: ConnectorFileOperation = {
    action: ConnectorFileAction.Stat,
    requestId: 'stat',
    policySha256: 'a'.repeat(64),
    rootId: 'project',
    path: '.',
};

it('normal format requires the exact current schema and explicit context; migration never treats malformed current or extra old metadata as an old record', (): void => {
    const codec: ConnectorFileJournalCodec = new ConnectorFileJournalCodec();
    const current: ConnectorJournalState<ConnectorFileOperation, ConnectorFileResponse> =
        new ConnectorJournalState(codec);
    const base: ConnectorJournalSnapshot<ConnectorFileOperation, ConnectorFileResponse> =
        current.empty('b'.repeat(64));
    expect(base.schema).toBe(ConnectorJournalSchema.AuthorizedEffectContext);
    expect(() =>
        current.read({
            journalId: base.journalId,
            acknowledgedSequence: '0',
            receipt: null,
            pending: null,
        }),
    ).toThrow('migration');
    expect((): ConnectorJournalSnapshot<ConnectorFileOperation, ConnectorFileResponse> =>
        current.read({ ...base, schema: 'something-else' }),
    ).toThrow('migration');
    const migrating: ConnectorJournalMigrationCodec<ConnectorFileOperation, ConnectorFileResponse> =
        new ConnectorJournalMigrationCodec(codec);
    expect((): ConnectorJournalSnapshot<ConnectorFileOperation, ConnectorFileResponse> =>
        migrating.read({ ...base, schema: 'something-else' }, 'c'.repeat(64)),
    ).toThrow('migration');
    expect(() =>
        migrating.read(
            {
                journalId: base.journalId,
                acknowledgedSequence: '0',
                receipt: null,
                pending: {
                    jobId: 'job',
                    sequence: '1',
                    dispatchId: 'A'.repeat(43),
                    requestHash: codec.requestHash(request),
                    request,
                    response: null,
                    progress: null,
                    effectContext: {
                        kind: ConnectorEffectKind.HistoricalUnproven,
                        sourceSha256: 'd'.repeat(64),
                    },
                },
            },
            'c'.repeat(64),
        ),
    ).toThrow();
});

it('concrete file context validates exact policy and root correlation, while command lanes cannot adopt file capture authority', (): void => {
    const files: ConnectorFileJournalCodec = new ConnectorFileJournalCodec();
    const raw: unknown = JSON.parse(
        ConnectorEffectContextCodec.encode(JournalEffectFixture.file(request)),
    );
    expect(files.effectContext(raw, request)).toEqual(JournalEffectFixture.file(request));
    expect((): ConnectorEffectContext =>
        files.effectContext(raw, { ...request, rootId: 'different' }),
    ).toThrow();
    expect((): ConnectorEffectContext =>
        files.effectContext(raw, { ...request, policySha256: 'b'.repeat(64) }),
    ).toThrow();
    expect(() =>
        files.effectContext({ kind: ConnectorEffectKind.IndependentExecution }, request),
    ).toThrow();
    const execution: ExecutionJournalCodec = new ExecutionJournalCodec(ExecutionLane.First);
    const command: ExecutionRequest = execution.request({
        requestId: 'command',
        policySha256: 'a'.repeat(64),
        rootId: 'project',
        programId: 'tool',
        arguments: [],
    });
    expect((): ConnectorEffectContext => execution.effectContext(raw, command)).toThrow();
    expect(
        execution.effectContext({ kind: ConnectorEffectKind.IndependentExecution }, command),
    ).toEqual({ kind: ConnectorEffectKind.IndependentExecution });
    expect(
        execution.effectContext(
            { kind: ConnectorEffectKind.HistoricalUnproven, sourceSha256: 'c'.repeat(64) },
            command,
        ),
    ).toEqual({ kind: ConnectorEffectKind.HistoricalUnproven, sourceSha256: 'c'.repeat(64) });
});
