// SPDX-FileCopyrightText: 2026 Dacely <business@dacely.com>
// SPDX-License-Identifier: LicenseRef-Proprietary

import { createHash, randomBytes } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { ExecutionBootstrapInputKind } from '../src/execution/ExecutionBootstrapInput.js';
import { ExecutionAppArmorMode } from '../src/execution/ExecutionAppArmorProfile.js';
import { ExecutionNativePipeHandle } from '../src/execution/ExecutionNativePipeHandle.js';
import {
    ExecutionWorkspaceAccess,
    ExecutionTermination,
    ExecutionFailure,
    type ExecutionResult,
} from 'nerva-connector-protocol/execution/ExecutionTypes.js';
import { type ExecutionBootstrap } from '../src/execution/ExecutionBootstrap.js';
import { ExecutionFixture } from './support/ExecutionFixture.js';
import {
    ExecutionPipeFixture,
    ExecutionPipeProbe,
    type ExecutionPipeInvocation,
} from './support/ExecutionPipeFixture.js';
import {
    ExecutionNativePipeCommandKind,
    type ExecutionNativePipeData,
    type ExecutionNativePipeEnd,
} from '../src/execution/ExecutionNativePipeProtocol.js';

/** These local FFI controls claim no backend/device signature; the actual confined kernel bytes are observed below. */
function data(
    invocation: ExecutionPipeInvocation,
    sequence: bigint,
    offset: bigint,
    bytes: Buffer,
): ExecutionNativePipeData {
    return {
        kind: ExecutionNativePipeCommandKind.Data,
        incarnation: invocation.incarnation,
        inputSequence: sequence,
        offset,
        deliveryExpiresAtMs: invocation.executionDeadlineMs,
        inputHash: randomBytes(32).toString('hex'),
        dataHash: createHash('sha256').update(bytes).digest('hex'),
        byteLength: BigInt(bytes.byteLength),
        dataBase64: bytes.toString('base64'),
    };
}

function end(
    invocation: ExecutionPipeInvocation,
    sequence: bigint,
    offset: bigint,
): ExecutionNativePipeEnd {
    return {
        kind: ExecutionNativePipeCommandKind.End,
        incarnation: invocation.incarnation,
        inputSequence: sequence,
        offset,
        deliveryExpiresAtMs: invocation.executionDeadlineMs,
        inputHash: randomBytes(32).toString('hex'),
    };
}

function candidate(): string {
    if (helper === undefined) {
        throw new Error('Explicit unused native Pipe candidate required');
    }
    return helper;
}

const helper: string | undefined = process.env['NERVA_CONNECTOR_EXEC_HELPER'];

it.skipIf(helper === undefined)(
    'a real confined immediate native exec supplies kernel-proven Pipe Ready on its separate descriptor',
    async (): Promise<void> => {
        if (helper === undefined) {
            throw new Error('Explicit unused native Pipe candidate required');
        }
        await using fixture: ExecutionFixture = await ExecutionFixture.create(helper);
        const base: ExecutionBootstrap = await fixture.configuration(
            'read-only',
            ExecutionWorkspaceAccess.ReadOnly,
            ExecutionAppArmorMode.Pipe,
        );
        const incarnation: string = randomBytes(32).toString('hex');
        const pipe: ExecutionNativePipeHandle = new ExecutionNativePipeHandle(
            incarnation,
            '',
            {
                maximumInputBytes: 65536n,
                maximumControls: 256,
            },
            BigInt(Date.now()) + 60000n,
        );
        const configuration: ExecutionBootstrap = {
            ...base,
            input: {
                kind: ExecutionBootstrapInputKind.Pipe,
                executionDeadlineMs: pipe.executionDeadlineMs,
                cwd: '.',
                environment: [],
                stdin: '',
                incarnation,
                maximumInputBytes: 65536n,
                maximumControls: 256,
                guardianProfile: base.apparmorProfile.replace(
                    'nerva-connector-exec-',
                    'nerva-connector-guard-',
                ),
            },
        };
        const task: Promise<ExecutionResult> = fixture.sandbox.execute(
            randomBytes(32).toString('hex'),
            configuration,
            fixture.limits,
            3000,
            AbortSignal.timeout(5000),
            await fixture.admission(),
            null,
            pipe,
        );
        const joined: Promise<PromiseSettledResult<ExecutionResult>[]> = Promise.allSettled([task]);
        try {
            const result: ExecutionResult = await task;
            expect(result, Buffer.from(result.stderrBase64, 'base64').toString()).toMatchObject({
                termination: ExecutionTermination.Exited,
                exitCode: 0,
                setupFailure: null,
            });
            await expect(pipe.ready).resolves.toMatchObject({ incarnation, initialInputBytes: 0 });
            expect(pipe.cursor()).toMatchObject({
                processedSequence: null,
                initialAccepted: false,
                acceptedOffset: 0n,
            });
        } finally {
            await joined;
        }
    },
);

it.skipIf(helper === undefined)(
    'real binary input, backpressure, exact duplicate receipts and ordered EOF preserve confinement without leaking control descriptors',
    async (): Promise<void> => {
        await using fixture: ExecutionPipeFixture = await ExecutionPipeFixture.create(candidate());
        const initial: string = 'before\0after\n';
        const invocation: ExecutionPipeInvocation = await fixture.launch(
            ExecutionPipeProbe.Slow,
            initial,
        );
        const expected: Buffer[] = [Buffer.from(initial)];
        try {
            await invocation.pipe.ready;
            expect(invocation.pipe.cursor()).toMatchObject({
                initialAccepted: false,
                acceptedOffset: 0n,
            });
            const zero: ExecutionNativePipeData = data(invocation, 0n, 0n, Buffer.from(initial));
            const receipt: Awaited<ReturnType<ExecutionNativePipeHandle['send']>> =
                await invocation.pipe.send(zero);
            expect(await invocation.pipe.send(zero)).toEqual(receipt);
            let offset: bigint = BigInt(Buffer.byteLength(initial));
            const bytes: Buffer = Buffer.alloc(4096, 0xff);
            bytes[1] = 0;
            const one: ExecutionNativePipeData = data(invocation, 1n, offset, bytes);
            const pending: Promise<Awaited<ReturnType<ExecutionNativePipeHandle['send']>>> =
                invocation.pipe.send(one);
            await expect(
                invocation.pipe.send(data(invocation, 2n, offset + 4096n, Buffer.from('overtake'))),
            ).rejects.toThrow('in flight');
            await pending;
            expected.push(bytes);
            offset += 4096n;
            for (let sequence: bigint = 2n; sequence <= 6n; sequence++) {
                const part: Buffer = Buffer.alloc(4096, Number(sequence));
                await invocation.pipe.send(data(invocation, sequence, offset, part));
                expected.push(part);
                offset += 4096n;
            }
            const eof: ExecutionNativePipeEnd = end(invocation, 7n, offset);
            await invocation.pipe.send(eof);
            const result: ExecutionResult = await invocation.task;
            expect(result).toMatchObject({
                termination: ExecutionTermination.Exited,
                exitCode: 0,
                setupFailure: null,
            });
            expect(Buffer.from(result.stdoutBase64, 'base64')).toEqual(Buffer.concat(expected));
            expect(Buffer.from(result.stderrBase64, 'base64').toString()).toBe('real EOF\n');
            expect(invocation.pipe.cursor()).toMatchObject({
                processedSequence: 7n,
                acceptedOffset: offset,
                initialAccepted: true,
                ended: true,
            });
            await expect(
                invocation.pipe.send(data(invocation, 8n, offset, Buffer.from('late'))),
            ).rejects.toThrow();
            expect(
                (await readdir(fixture.native.delegation)).filter((name: string): boolean =>
                    name.startsWith('exec-'),
                ),
            ).toEqual([]);
        } finally {
            await invocation.joined;
        }
    },
);

it.skipIf(helper === undefined)(
    'the actual Pipe writer accepts exactly its 65536-byte total while rejecting another range before native effects',
    async (): Promise<void> => {
        await using fixture: ExecutionPipeFixture = await ExecutionPipeFixture.create(candidate());
        const invocation: ExecutionPipeInvocation = await fixture.launch(
            ExecutionPipeProbe.Discard,
        );
        try {
            await invocation.pipe.ready;
            await invocation.pipe.send(data(invocation, 0n, 0n, Buffer.alloc(0)));
            expect(invocation.pipe.cursor()).toMatchObject({
                initialAccepted: true,
                acceptedOffset: 0n,
                processedSequence: 0n,
            });
            for (let index: bigint = 0n; index < 16n; index++) {
                await invocation.pipe.send(
                    data(invocation, index + 1n, index * 4096n, Buffer.alloc(4096, Number(index))),
                );
            }
            await expect(
                invocation.pipe.send(data(invocation, 17n, 65536n, Buffer.from('extra'))),
            ).rejects.toThrow();
            await invocation.pipe.send(end(invocation, 17n, 65536n));
            const result: ExecutionResult = await invocation.task;
            expect(result).toMatchObject({ exitCode: 0, termination: ExecutionTermination.Exited });
            expect(Buffer.from(result.stdoutBase64, 'base64').toString()).toBe('65536\n');
        } finally {
            await invocation.joined;
        }
    },
);

it.skipIf(helper === undefined)(
    'Pipe input does not expand a readonly workspace grant',
    async (): Promise<void> => {
        await using fixture: ExecutionPipeFixture = await ExecutionPipeFixture.create(candidate());
        const invocation: ExecutionPipeInvocation = await fixture.launch(
            ExecutionPipeProbe.Write,
            '',
            ExecutionWorkspaceAccess.ReadOnly,
        );
        try {
            await invocation.pipe.ready;
            await invocation.pipe.send(data(invocation, 0n, 0n, Buffer.alloc(0)));
            await invocation.pipe.send(end(invocation, 1n, 0n));
            const result: ExecutionResult = await invocation.task;
            expect(result).toMatchObject({ exitCode: 0, termination: ExecutionTermination.Exited });
            expect(Buffer.from(result.stdoutBase64, 'base64').toString()).toBe('write denied\n');
            await expect(
                readFile(join(fixture.native.workspace, 'nested/pipe-effect')),
            ).rejects.toMatchObject({ code: 'ENOENT' });
        } finally {
            await invocation.joined;
        }
    },
);

it.skipIf(helper === undefined)(
    'explicit caller cancellation and a native deadline join Pipe children without inventing input acceptance',
    async (): Promise<void> => {
        await using fixture: ExecutionPipeFixture = await ExecutionPipeFixture.create(candidate());
        const stop: AbortController = new AbortController();
        const cancelled: ExecutionPipeInvocation = await fixture.launch(
            ExecutionPipeProbe.Hold,
            '',
            ExecutionWorkspaceAccess.ReadWrite,
            3000,
            stop.signal,
        );
        try {
            await cancelled.pipe.ready;
            stop.abort();
            expect(await cancelled.task).toMatchObject({
                termination: ExecutionTermination.Indeterminate,
                failure: ExecutionFailure.Cancelled,
                exitCode: null,
            });
            expect(cancelled.pipe.cursor()).toMatchObject({
                processedSequence: null,
                acceptedOffset: 0n,
                initialAccepted: false,
            });
        } finally {
            stop.abort();
            await cancelled.joined;
        }
        const timed: ExecutionPipeInvocation = await fixture.launch(
            ExecutionPipeProbe.Hold,
            '',
            ExecutionWorkspaceAccess.ReadWrite,
            200,
        );
        try {
            const timedResult: ExecutionResult = await timed.task;
            expect(
                timedResult,
                Buffer.from(timedResult.stderrBase64, 'base64').toString(),
            ).toMatchObject({
                termination: ExecutionTermination.Indeterminate,
                failure: ExecutionFailure.Timeout,
                exitCode: null,
            });
            expect(
                (await readdir(fixture.native.delegation)).filter((name: string): boolean =>
                    name.startsWith('exec-'),
                ),
            ).toEqual([]);
        } finally {
            await timed.joined;
        }
    },
);

it.skipIf(helper === undefined)(
    'a Pipe payload cannot leave its descendant alive after the actual native parent exits',
    async (): Promise<void> => {
        await using fixture: ExecutionPipeFixture = await ExecutionPipeFixture.create(candidate());
        const invocation: ExecutionPipeInvocation = await fixture.launch(
            ExecutionPipeProbe.Descendant,
        );
        try {
            const result: ExecutionResult = await invocation.task;
            expect(result, Buffer.from(result.stderrBase64, 'base64').toString()).toMatchObject({
                termination: ExecutionTermination.Exited,
                exitCode: 0,
            });
            await invocation.pipe.ready;
            expect(Buffer.from(result.stdoutBase64, 'base64').toString()).toBe(
                'descendant started\n',
            );
            expect(
                (await readdir(fixture.native.delegation)).filter((name: string): boolean =>
                    name.startsWith('exec-'),
                ),
            ).toEqual([]);
        } finally {
            await invocation.joined;
        }
    },
);

it.skipIf(helper === undefined)(
    'an application that closes stdin cannot produce a false native input acknowledgment',
    async (): Promise<void> => {
        await using fixture: ExecutionPipeFixture = await ExecutionPipeFixture.create(candidate());
        const invocation: ExecutionPipeInvocation = await fixture.launch(
            ExecutionPipeProbe.ClosedInput,
            'must-not-claim-consumed',
        );
        try {
            await invocation.pipe.ready;
            await vi.waitFor(
                async (): Promise<void> => {
                    expect(
                        await readFile(
                            join(fixture.native.workspace, 'nested/input-is-closed'),
                            'utf8',
                        ),
                    ).toBe('closed');
                },
                { timeout: 1000, interval: 10 },
            );
            await expect(
                invocation.pipe.send(
                    data(invocation, 0n, 0n, Buffer.from('must-not-claim-consumed')),
                ),
            ).rejects.toThrow('unconfirmed');
            expect(await invocation.task).toMatchObject({
                termination: ExecutionTermination.Indeterminate,
                exitCode: null,
            });
            expect(invocation.pipe.cursor()).toMatchObject({
                processedSequence: null,
                initialAccepted: false,
                acceptedOffset: 0n,
            });
            expect(
                (await readdir(fixture.native.delegation)).filter((name: string): boolean =>
                    name.startsWith('exec-'),
                ),
            ).toEqual([]);
        } finally {
            await invocation.joined;
        }
    },
);

it.skipIf(helper === undefined)(
    'cancellation before native admission rejects readiness and leaves no running Pipe owner',
    async (): Promise<void> => {
        await using fixture: ExecutionPipeFixture = await ExecutionPipeFixture.create(candidate());
        const invocation: ExecutionPipeInvocation = await fixture.launch(
            ExecutionPipeProbe.Hold,
            '',
            ExecutionWorkspaceAccess.ReadWrite,
            3000,
            AbortSignal.abort(),
        );
        await expect(invocation.task).rejects.toThrow();
        await expect(invocation.pipe.ready).rejects.toThrow('unconfirmed');
        expect(
            (await readdir(fixture.native.delegation)).filter((name: string): boolean =>
                name.startsWith('exec-'),
            ),
        ).toEqual([]);
        expect(invocation.pipe.cursor()).toMatchObject({
            processedSequence: null,
            acceptedOffset: 0n,
            initialAccepted: false,
        });
    },
);

it.skipIf(helper === undefined)(
    'captured tighter byte and control grants cannot silently expand to the native hard ceilings',
    async (): Promise<void> => {
        await using fixture: ExecutionPipeFixture = await ExecutionPipeFixture.create(candidate());
        const bounded: ExecutionPipeInvocation = await fixture.launch(
            ExecutionPipeProbe.Echo,
            'abc',
            ExecutionWorkspaceAccess.ReadWrite,
            3000,
            AbortSignal.timeout(5000),
            { maximumInputBytes: 3n, maximumControls: 2 },
        );
        try {
            await bounded.pipe.ready;
            await bounded.pipe.send(data(bounded, 0n, 0n, Buffer.from('abc')));
            await expect(
                bounded.pipe.send(data(bounded, 1n, 3n, Buffer.from('d'))),
            ).rejects.toThrow();
            await bounded.pipe.send(end(bounded, 1n, 3n));
            const result: ExecutionResult = await bounded.task;
            expect(result).toMatchObject({ exitCode: 0, termination: ExecutionTermination.Exited });
            expect(Buffer.from(result.stdoutBase64, 'base64').toString()).toBe('abc');
        } finally {
            await bounded.joined;
        }
        const stop: AbortController = new AbortController();
        const controls: ExecutionPipeInvocation = await fixture.launch(
            ExecutionPipeProbe.Hold,
            '',
            ExecutionWorkspaceAccess.ReadWrite,
            3000,
            stop.signal,
            { maximumInputBytes: 0n, maximumControls: 1 },
        );
        try {
            await controls.pipe.ready;
            await controls.pipe.send(data(controls, 0n, 0n, Buffer.alloc(0)));
            await expect(controls.pipe.send(end(controls, 1n, 0n))).rejects.toThrow();
            stop.abort();
            expect(await controls.task).toMatchObject({
                failure: ExecutionFailure.Cancelled,
                exitCode: null,
            });
        } finally {
            stop.abort();
            await controls.joined;
        }
    },
);
