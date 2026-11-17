// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

import { ConnectorAuthorizationKind } from 'nerva-connector-protocol/protocol/ConnectorAuthorization.js';
import { ConnectorAuthorizationProof } from '../src/protocol/ConnectorAuthorizationProof.js';
import { ConnectorEffectKind } from '../src/runtime/ConnectorEffectContext.js';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi, type MockInstance } from 'vitest';
import { SigningKey } from '../src/identity/SigningKey.js';
import {
    ConnectorOperationJournal,
    type ConnectorJournalClaim,
} from '../src/runtime/ConnectorOperationJournal.js';
import { ConnectorJournalState } from '../src/runtime/ConnectorJournalState.js';
import { ConnectorPrivateDirectory } from '../src/runtime/ConnectorPrivateDirectory.js';
import type { ConnectorOperationDispatch } from '../src/runtime/ConnectorOperationCodec.js';
import { type ExecutionRequest } from '../src/execution/ExecutionJobs.js';
import { ExecutionLane } from 'nerva-connector-protocol/execution/ExecutionLane.js';
import type { ExecutionOutput } from '../src/execution/ExecutionOutput.js';
import { ExecutionJournalCodec } from '../src/execution/ExecutionJournalCodec.js';
import { ExecutionProof } from '../src/execution/ExecutionProof.js';
import { ExecutionResultCodec } from '../src/execution/ExecutionResultCodec.js';
import { ExecutionFailure, type ExecutionResult } from '../src/execution/ExecutionTypes.js';

/** Each case owns its encrypted journal and device key, without native execution or test storage fallbacks. */
class OutputFixture implements AsyncDisposable {
    public readonly key: SigningKey = SigningKey.generate();
    public readonly enrollment: string = 'conn_' + 'a'.repeat(64);
    public readonly codec: ExecutionJournalCodec = new ExecutionJournalCodec(ExecutionLane.First);
    public readonly request: ExecutionRequest = {
        requestId: 'request',
        policySha256: 'a'.repeat(64),
        programId: 'tool',
        rootId: 'project',
        arguments: [],
    };
    public readonly dispatch: ConnectorOperationDispatch<ExecutionRequest> = {
        jobId: 'job',
        sequence: 1n,
        dispatchId: 'A'.repeat(43),
        requestHash: ExecutionProof.requestHash(this.request),
        authorization: { kind: ConnectorAuthorizationKind.Independent },
        admissionHash: ConnectorAuthorizationProof.execution(
            ExecutionProof.requestHash(this.request),
            ExecutionLane.First,
            { kind: ConnectorAuthorizationKind.Independent },
        ),
        request: this.request,
    };
    private constructor(public readonly directory: string) {}
    public static async create(): Promise<OutputFixture> {
        const fixture: OutputFixture = new OutputFixture(
            await mkdtemp(join(homedir(), '.nerva-output-journal-')),
        );
        try {
            await ConnectorOperationJournal.initialize(
                fixture.directory,
                fixture.enrollment,
                fixture.key,
                fixture.codec,
            );
            return fixture;
        } catch (caught: unknown) {
            await fixture[Symbol.asyncDispose]();
            throw caught;
        }
    }
    public async load(): Promise<
        ConnectorOperationJournal<ExecutionRequest, ExecutionResult, ExecutionOutput>
    > {
        return await ConnectorOperationJournal.load(
            this.directory,
            this.enrollment,
            this.key,
            this.codec,
        );
    }
    public async [Symbol.asyncDispose](): Promise<void> {
        this.key[Symbol.dispose]();
        await rm(this.directory, { force: true, recursive: true });
    }
}

it('reopen retains only the exact original binary prefix and terminal compaction fits the maximum output budget', async (): Promise<void> => {
    await using fixture: OutputFixture = await OutputFixture.create();
    const prefix: ExecutionOutput = {
        stdoutBase64: Buffer.from([0xef, 0xbb, 0xbf, 0, 255]).toString('base64'),
        stderrBase64: 'AP4=',
    };
    {
        await using journal: ConnectorOperationJournal<
            ExecutionRequest,
            ExecutionResult,
            ExecutionOutput
        > = await fixture.load();
        await journal.begin(fixture.dispatch, { kind: ConnectorEffectKind.IndependentExecution });
        await journal.retain(fixture.dispatch, prefix);
        for (const changed of [
            { ...prefix, stdoutBase64: '' },
            { ...prefix, stderrBase64: 'AA==' },
            { ...prefix, stdoutBase64: 'Zg' },
            { ...prefix, stderrBase64: Buffer.alloc(65536).toString('base64') },
        ]) {
            await expect(journal.retain(fixture.dispatch, changed)).rejects.toThrow();
        }
        await expect(
            journal.retain({ ...fixture.dispatch, jobId: 'other' }, prefix),
        ).rejects.toThrow();
        await expect(
            journal.finish(
                fixture.dispatch,
                ExecutionResultCodec.interrupted(ExecutionFailure.Interrupted),
            ),
        ).rejects.toThrow('output changed');
    }
    const encrypted: string = await readFile(join(fixture.directory, 'execution-journal'), 'utf8');
    expect(encrypted).not.toContain(prefix.stdoutBase64);
    await using recovered: ConnectorOperationJournal<
        ExecutionRequest,
        ExecutionResult,
        ExecutionOutput
    > = await fixture.load();
    const claim: ConnectorJournalClaim<ExecutionRequest, ExecutionResult, ExecutionOutput> =
        await recovered.begin(fixture.dispatch, { kind: ConnectorEffectKind.IndependentExecution });
    expect(claim.fresh).toBe(false);
    expect(claim.pending.progress).toEqual(prefix);
    const complete: ExecutionOutput = {
        stdoutBase64: Buffer.concat([
            Buffer.from(prefix.stdoutBase64, 'base64'),
            Buffer.alloc(65529),
        ]).toString('base64'),
        stderrBase64: prefix.stderrBase64,
    };
    await recovered.retain(fixture.dispatch, complete);
    const response: ExecutionResult = {
        ...ExecutionResultCodec.interrupted(ExecutionFailure.Interrupted),
        ...complete,
    };
    await recovered.finish(fixture.dispatch, response);
    expect(
        (
            await recovered.begin(fixture.dispatch, {
                kind: ConnectorEffectKind.IndependentExecution,
            })
        ).pending,
    ).toMatchObject({
        progress: null,
        response,
    });
    expect(
        Buffer.byteLength(await readFile(join(fixture.directory, 'execution-journal'), 'utf8')),
    ).toBeLessThanOrEqual(196608);
    await expect(recovered.retain(fixture.dispatch, complete)).rejects.toThrow();
    await recovered.acknowledge({
        ...fixture.dispatch,
        responseHash: ExecutionProof.responseHash(response),
    });
    expect((await readFile(join(fixture.directory, 'execution-journal'))).byteLength).toBeLessThan(
        2048,
    );
});

it.each([false, true])(
    'an atomic write failure before/after publication (%s) requires recovery and never an empty reset',
    async (published: boolean): Promise<void> => {
        await using fixture: OutputFixture = await OutputFixture.create();
        const previous: ExecutionOutput = { stdoutBase64: 'AA==', stderrBase64: '' };
        const next: ExecutionOutput = { stdoutBase64: 'AP8=', stderrBase64: '' };
        {
            await using journal: ConnectorOperationJournal<
                ExecutionRequest,
                ExecutionResult,
                ExecutionOutput
            > = await fixture.load();
            await journal.begin(fixture.dispatch, {
                kind: ConnectorEffectKind.IndependentExecution,
            });
            await journal.retain(fixture.dispatch, previous);
            const spy: MockInstance<typeof ConnectorPrivateDirectory.prototype.write> = vi.spyOn(
                ConnectorPrivateDirectory.prototype,
                'write',
            );
            spy.mockImplementationOnce(async function (
                this: ConnectorPrivateDirectory,
                ...args: Parameters<typeof ConnectorPrivateDirectory.prototype.write>
            ): Promise<void> {
                spy.mockRestore();
                if (published) {
                    await this.write(...args);
                }
                throw new Error('Lost atomic write observation');
            });
            try {
                await expect(journal.retain(fixture.dispatch, next)).rejects.toThrow();
                expect(journal.failed).toBe(true);
                await expect(
                    journal.begin(fixture.dispatch, {
                        kind: ConnectorEffectKind.IndependentExecution,
                    }),
                ).rejects.toThrow();
            } finally {
                spy.mockRestore();
            }
        }
        await using recovered: ConnectorOperationJournal<
            ExecutionRequest,
            ExecutionResult,
            ExecutionOutput
        > = await fixture.load();
        expect(
            (
                await recovered.begin(fixture.dispatch, {
                    kind: ConnectorEffectKind.IndependentExecution,
                })
            ).pending.progress,
        ).toEqual(published ? next : previous);
    },
);

it('missing progress contracts and simultaneous progress/result copies fail closed', async (): Promise<void> => {
    await using fixture: OutputFixture = await OutputFixture.create();
    const state: ConnectorJournalState<ExecutionRequest, ExecutionResult, ExecutionOutput> =
        new ConnectorJournalState(fixture.codec);
    const raw: Readonly<Record<string, unknown>> = {
        ...fixture.dispatch,
        sequence: '1',
        response: null,
    };
    expect((): void => {
        state.pending(raw);
    }).toThrow();
    expect((): void => {
        state.pending({ ...raw, progress: { stdoutBase64: '', stderrBase64: '' } });
    }).toThrow();
    expect((): void => {
        state.pending({
            ...raw,
            progress: { stdoutBase64: 'AA==', stderrBase64: '' },
            response: ExecutionResultCodec.interrupted(ExecutionFailure.Interrupted),
        });
    }).toThrow();
});
