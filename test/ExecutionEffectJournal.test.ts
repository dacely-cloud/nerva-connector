// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

import { expect, it } from 'vitest';
import {
    ConnectorEffectKind,
    type ConnectorCapturedExecutionEffect,
} from '../src/runtime/ConnectorEffectContext.js';
import type { ConnectorOperationDispatch } from '../src/runtime/ConnectorOperationCodec.js';
import { ConnectorOperationJournal } from '../src/runtime/ConnectorOperationJournal.js';
import { ConnectorEffectContextCodec } from '../src/runtime/ConnectorEffectContextCodec.js';
import { type ExecutionRequest } from '../src/execution/ExecutionJobs.js';
import { ExecutionLane } from 'nerva-connector-protocol/execution/ExecutionLane.js';
import { ExecutionCgroupIdentityCodec } from '../src/execution/ExecutionCgroupIdentityCodec.js';
import type { ExecutionCgroupIdentity } from '../src/execution/ExecutionCgroupIdentity.js';
import type { ExecutionOutput } from '../src/execution/ExecutionOutput.js';
import { ExecutionResultCodec } from '../src/execution/ExecutionResultCodec.js';
import {
    ExecutionFailure,
    ExecutionSetupFailure,
    ExecutionTermination,
    type ExecutionResult,
} from '../src/execution/ExecutionTypes.js';
import { ExecutionHistoryFixture } from './support/ExecutionHistoryFixture.js';
import { JournalEffectFixture } from './support/JournalEffectFixture.js';

it('Started binds an empty group once before any output; rejected refinements preserve ciphertext and the original request', async (): Promise<void> => {
    await using fixture: ExecutionHistoryFixture = await ExecutionHistoryFixture.create();
    const dispatch: ConnectorOperationDispatch<ExecutionRequest> = fixture.dispatch(
        ExecutionLane.First,
    );
    const context: ConnectorCapturedExecutionEffect = JournalEffectFixture.execution(
        dispatch.request,
    );
    const group: ExecutionCgroupIdentity = { ...context.delegation, handle: '0200000001000000' };
    const prefix: ExecutionOutput = { stdoutBase64: 'AP8=', stderrBase64: 'AQ==' };
    {
        await using journal: ConnectorOperationJournal<
            ExecutionRequest,
            ExecutionResult,
            ExecutionOutput
        > = await fixture.load(ExecutionLane.First);
        await journal.begin(dispatch, context);
        const started: Buffer = await fixture.bytes(ExecutionLane.First);
        await expect(journal.retain(dispatch, prefix)).rejects.toThrow('precedes');
        await expect(
            journal.finish(dispatch, {
                setupFailure: null,
                termination: ExecutionTermination.Exited,
                failure: null,
                exitCode: 0,
                stdoutBase64: '',
                stderrBase64: '',
            }),
        ).rejects.toThrow('precedes');
        await expect(
            journal.finish(dispatch, {
                ...ExecutionResultCodec.interrupted(ExecutionFailure.Sandbox),
                setupFailure: ExecutionSetupFailure.Bootstrap,
            }),
        ).rejects.toThrow('precedes');
        await expect(journal.bindExecutionGroup(dispatch, context.delegation)).rejects.toThrow();
        await expect(
            journal.bindExecutionGroup(dispatch, {
                ...group,
                bootId: '22222222-2222-2222-2222-222222222222',
            }),
        ).rejects.toThrow();
        expect((await fixture.bytes(ExecutionLane.First)).equals(started)).toBe(true);
        const bound: ConnectorCapturedExecutionEffect = await journal.bindExecutionGroup(
            dispatch,
            group,
        );
        expect(bound.group).toEqual(group);
        const committed: Buffer = await fixture.bytes(ExecutionLane.First);
        await expect(journal.bindExecutionGroup(dispatch, group)).rejects.toThrow('rebound');
        expect((await fixture.bytes(ExecutionLane.First)).equals(committed)).toBe(true);
        await journal.retain(dispatch, prefix);
        await journal.finish(dispatch, {
            ...ExecutionResultCodec.interrupted(ExecutionFailure.Interrupted),
            ...prefix,
        });
    }
    await using recovered: ConnectorOperationJournal<
        ExecutionRequest,
        ExecutionResult,
        ExecutionOutput
    > = await fixture.load(ExecutionLane.First);
    expect(recovered.pending).toMatchObject({
        ...dispatch,
        effectContext: { ...context, group },
        response: { ...ExecutionResultCodec.interrupted(ExecutionFailure.Interrupted), ...prefix },
        progress: null,
    });
});

it('a no-program original cannot acquire a group, output or an exited result', async (): Promise<void> => {
    await using fixture: ExecutionHistoryFixture = await ExecutionHistoryFixture.create();
    const dispatch: ConnectorOperationDispatch<ExecutionRequest> = fixture.dispatch(
        ExecutionLane.First,
    );
    await using journal: ConnectorOperationJournal<
        ExecutionRequest,
        ExecutionResult,
        ExecutionOutput
    > = await fixture.load(ExecutionLane.First);
    await journal.begin(dispatch, { kind: ConnectorEffectKind.ExecutionNotStarted });
    await expect(
        journal.bindExecutionGroup(
            dispatch,
            JournalEffectFixture.execution(dispatch.request).delegation,
        ),
    ).rejects.toThrow();
    await expect(
        journal.retain(dispatch, { stdoutBase64: 'AP8=', stderrBase64: '' }),
    ).rejects.toThrow('precedes');
    await expect(
        journal.finish(dispatch, ExecutionResultCodec.interrupted(ExecutionFailure.Sandbox)),
    ).rejects.toThrow('precedes');
    const response: ExecutionResult = ExecutionResultCodec.interrupted(ExecutionFailure.Cancelled);
    await expect(
        journal.finish(dispatch, { ...response, setupFailure: ExecutionSetupFailure.Bootstrap }),
    ).rejects.toThrow('Invalid execution terminal result');
    await journal.finish(dispatch, response);
    expect(journal.pending?.response).toEqual(response);
});

it('private cgroup identities preserve uint64 precision and reject unknown, truncated, unscoped or cross-filesystem material', (): void => {
    const request: ExecutionRequest = {
        requestId: 'unit',
        policySha256: 'a'.repeat(64),
        programId: 'program',
        rootId: 'project',
        arguments: [],
    };
    const context: ConnectorCapturedExecutionEffect = JournalEffectFixture.execution(request);
    const raw: unknown = JSON.parse(ConnectorEffectContextCodec.encode(context.delegation));
    expect(ExecutionCgroupIdentityCodec.read(raw)).toEqual(context.delegation);
    expect(ExecutionCgroupIdentityCodec.read(raw).device).toBe(9007199254740993n);
    const encoded: string = ConnectorEffectContextCodec.encode(context.delegation);
    for (const changed of [
        { ...context.delegation, device: '18446744073709551616' },
        { ...context.delegation, device: '01' },
        { ...context.delegation, device: 1 },
        { ...context.delegation, filesystemId: '0000000000000000' },
        { ...context.delegation, handle: '01' },
        { ...context.delegation, handleType: 1 },
        { ...context.delegation, extra: true },
    ]) {
        const rawChanged: unknown = JSON.parse(
            JSON.stringify(changed, (_key: string, value: unknown): unknown =>
                typeof value === 'bigint' ? value.toString() : value,
            ),
        );
        expect((): ExecutionCgroupIdentity =>
            ExecutionCgroupIdentityCodec.read(rawChanged),
        ).toThrow();
    }
    expect(encoded).toContain('9007199254740993');
});
