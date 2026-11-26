// SPDX-FileCopyrightText: 2026 Dacely <business@dacely.com>
// SPDX-License-Identifier: LicenseRef-Proprietary

import { createHash, randomBytes } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { Duplex } from 'node:stream';
import { setTimeout } from 'node:timers/promises';
import { expect, it, vi } from 'vitest';
import { ExecutionAppArmorMode } from '../src/execution/ExecutionAppArmorProfile.js';
import { ExecutionBootstrapInputKind } from '../src/execution/ExecutionBootstrapInput.js';
import { ExecutionNativePipeCodec } from '../src/execution/ExecutionNativePipeCodec.js';
import { ExecutionNativePipeHandle } from '../src/execution/ExecutionNativePipeHandle.js';
import {
    ExecutionNativePipeCommandKind,
    type ExecutionNativePipeApplied,
    type ExecutionNativePipeData,
    type ExecutionNativePipeEnd,
    type ExecutionNativePipeFailure,
} from '../src/execution/ExecutionNativePipeProtocol.js';
import {
    ExecutionFailure,
    ExecutionTermination,
    ExecutionWorkspaceAccess,
    type ExecutionResult,
} from 'nerva-connector-protocol/execution/ExecutionTypes.js';
import { type ExecutionBootstrap } from '../src/execution/ExecutionBootstrap.js';
import { ExecutionPipeDelayedBroker } from './support/ExecutionPipeDelayedBroker.js';
import { ExecutionPipeDescendantFixture } from './support/ExecutionPipeDescendantFixture.js';
import type { ExecutionFixture } from './support/ExecutionFixture.js';
import {
    ExecutionPipeFixture,
    ExecutionPipeProbe,
    type ExecutionPipeInvocation,
} from './support/ExecutionPipeFixture.js';

/** Test-only descriptor interception preserves actual native Ready and receipt bytes. */
class DelayedPipe extends ExecutionNativePipeHandle {
    readonly #broker: PromiseWithResolvers<ExecutionPipeDelayedBroker> =
        Promise.withResolvers<ExecutionPipeDelayedBroker>();

    public get broker(): Promise<ExecutionPipeDelayedBroker> {
        return this.#broker.promise;
    }

    public override attach(
        channel: Duplex,
        fault: (reason: ExecutionNativePipeFailure) => void,
        started: () => void,
    ): void {
        const broker: ExecutionPipeDelayedBroker = new ExecutionPipeDelayedBroker(channel);
        super.attach(broker, fault, started);
        this.#broker.resolve(broker);
    }
}

interface DelayedInvocation extends ExecutionPipeInvocation {
    readonly pipe: DelayedPipe;
    readonly stop: AbortController;
}

interface DeadlineFixture {
    readonly native: ExecutionFixture;
}

const helper: string | undefined = process.env['NERVA_CONNECTOR_EXEC_HELPER'];
const helperSha: string | undefined = process.env['NERVA_CONNECTOR_EXEC_HELPER_SHA256'];
const qualified: boolean = helper !== undefined && helperSha !== undefined;

/** Explicit pins ensure this new expiry ABI is never exercised against the historical helper. */
async function fixture(work: (value: ExecutionPipeFixture) => Promise<void>): Promise<void> {
    if (helper === undefined || helperSha === undefined || !/^[a-f0-9]{64}$/.test(helperSha)) {
        throw new Error('Explicit matching native expiry helper and SHA-256 required');
    }
    expect(
        createHash('sha256')
            .update(await readFile(helper))
            .digest('hex'),
    ).toBe(helperSha);
    try {
        await using value: ExecutionPipeFixture = await ExecutionPipeFixture.create(helper);
        await work(value);
    } finally {
        expect(
            createHash('sha256')
                .update(await readFile(helper))
                .digest('hex'),
        ).toBe(helperSha);
    }
}

/** Only the existing confined probe is launched; no backend/device proof is manufactured. */
async function launch(
    value: DeadlineFixture,
    initial: string,
    durationMs: bigint = 6000n,
): Promise<DelayedInvocation> {
    const base: ExecutionBootstrap = await value.native.configuration(
        ExecutionPipeProbe.Echo,
        ExecutionWorkspaceAccess.ReadWrite,
        ExecutionAppArmorMode.Pipe,
    );
    const admission: Awaited<ReturnType<typeof value.native.admission>> =
        await value.native.admission();
    const executionDeadlineMs: bigint = BigInt(Date.now()) + durationMs;
    const incarnation: string = randomBytes(32).toString('hex');
    const pipe: DelayedPipe = new DelayedPipe(
        incarnation,
        initial,
        { maximumInputBytes: 65536n, maximumControls: 256 },
        executionDeadlineMs,
    );
    const stop: AbortController = new AbortController();
    const configuration: ExecutionBootstrap = {
        ...base,
        input: {
            kind: ExecutionBootstrapInputKind.Pipe,
            cwd: 'nested',
            environment: [{ name: 'APP_MODE', value: 'fixture' }],
            stdin: initial,
            incarnation,
            executionDeadlineMs,
            maximumInputBytes: 65536n,
            maximumControls: 256,
            guardianProfile: base.apparmorProfile.replace(
                'nerva-connector-exec-',
                'nerva-connector-guard-',
            ),
        },
    };
    const task: Promise<ExecutionResult> = value.native.sandbox.execute(
        randomBytes(32).toString('hex'),
        configuration,
        value.native.limits,
        10000,
        AbortSignal.any([stop.signal, AbortSignal.timeout(12000)]),
        admission,
        null,
        pipe,
    );
    const joined: Promise<PromiseSettledResult<ExecutionResult>[]> = Promise.allSettled([task]);
    return { pipe, stop, incarnation, executionDeadlineMs, task, joined };
}

/** Commands here test the local FFI boundary, not account signature authorization. */
function data(
    invocation: ExecutionPipeInvocation,
    sequence: bigint,
    offset: bigint,
    bytes: Buffer,
    expires: bigint,
): ExecutionNativePipeData {
    return {
        kind: ExecutionNativePipeCommandKind.Data,
        incarnation: invocation.incarnation,
        inputSequence: sequence,
        offset,
        inputHash: randomBytes(32).toString('hex'),
        deliveryExpiresAtMs: expires,
        dataHash: createHash('sha256').update(bytes).digest('hex'),
        byteLength: BigInt(bytes.byteLength),
        dataBase64: bytes.toString('base64'),
    };
}

function end(
    invocation: ExecutionPipeInvocation,
    sequence: bigint,
    offset: bigint,
    expires: bigint,
): ExecutionNativePipeEnd {
    return {
        kind: ExecutionNativePipeCommandKind.End,
        incarnation: invocation.incarnation,
        inputSequence: sequence,
        offset,
        inputHash: randomBytes(32).toString('hex'),
        deliveryExpiresAtMs: expires,
    };
}

async function after(expires: bigint): Promise<void> {
    const remaining: bigint = expires - BigInt(Date.now()) + 40n;
    if (remaining > 0n) {
        await setTimeout(Number(remaining));
    }
}

async function cleaned(value: DeadlineFixture): Promise<void> {
    expect(
        (await readdir(value.native.delegation)).filter((name: string): boolean =>
            name.startsWith('exec-'),
        ),
    ).toEqual([]);
}

it.skipIf(!qualified)(
    'native deadline cleanup quiesces an actual stdin-inheriting descendant before closing the application writer',
    async (): Promise<void> => {
        if (helper === undefined || helperSha === undefined) {
            throw new Error('Explicit pinned helper required');
        }
        expect(
            createHash('sha256')
                .update(await readFile(helper))
                .digest('hex'),
        ).toBe(helperSha);
        try {
            await using value: ExecutionPipeDescendantFixture =
                await ExecutionPipeDescendantFixture.create(helper);
            const invocation: DelayedInvocation = await launch(value, '', 1800n);
            try {
                await invocation.pipe.ready;
                await vi.waitFor(
                    async (): Promise<void> => {
                        expect(
                            await readFile(
                                join(value.native.workspace, 'nested/descendant-ready'),
                                'utf8',
                            ),
                        ).toBe('observed');
                    },
                    { timeout: 1000, interval: 10 },
                );
                const broker: ExecutionPipeDelayedBroker = await invocation.pipe.broker;
                const command: ExecutionNativePipeData = data(
                    invocation,
                    0n,
                    0n,
                    Buffer.alloc(0),
                    invocation.executionDeadlineMs,
                );
                await invocation.pipe.send(command);
                const flood: Promise<PromiseSettledResult<undefined>[]> = Promise.allSettled([
                    broker.blockAndFlood(ExecutionNativePipeCodec.capture(command).encoded),
                ]);
                const result: ExecutionResult = await invocation.task;
                expect(result).toMatchObject({
                    termination: ExecutionTermination.Indeterminate,
                    exitCode: null,
                });
                await flood;
                expect(Buffer.from(result.stderrBase64, 'base64').toString()).not.toContain(
                    'DESCENDANT EOF',
                );
                await expect(
                    readFile(join(value.native.workspace, 'nested/descendant-eof'), 'utf8'),
                ).rejects.toMatchObject({ code: 'ENOENT' });
                expect(invocation.pipe.cursor()).toMatchObject({
                    processedSequence: 0n,
                    acceptedOffset: 0n,
                    ended: false,
                });
                await cleaned(value);
            } finally {
                invocation.stop.abort();
                await invocation.joined;
            }
        } finally {
            expect(
                createHash('sha256')
                    .update(await readFile(helper))
                    .digest('hex'),
            ).toBe(helperSha);
        }
    },
    20000,
);

it.skipIf(!qualified)(
    'the sealed original native deadline independently times out an idle payload without accepting initial0',
    async (): Promise<void> => {
        await fixture(async (value: ExecutionPipeFixture): Promise<void> => {
            const invocation: DelayedInvocation = await launch(value, '', 700n);
            try {
                await invocation.pipe.ready;
                const broker: ExecutionPipeDelayedBroker = await invocation.pipe.broker;
                const began: number = performance.now();
                expect(await invocation.task).toMatchObject({
                    termination: ExecutionTermination.Indeterminate,
                    failure: ExecutionFailure.Timeout,
                    exitCode: null,
                });
                expect(performance.now() - began).toBeLessThan(4000);
                expect(broker.writes).toBe(0);
                expect(invocation.pipe.cursor()).toMatchObject({
                    processedSequence: null,
                    acceptedOffset: 0n,
                    initialAccepted: false,
                    ended: false,
                });
                await cleaned(value);
            } finally {
                invocation.stop.abort();
                await invocation.joined;
            }
        });
    },
    20000,
);

it.skipIf(!qualified)(
    'a bounded duplicate flood and blocked native receipts cannot outlive the sealed deadline or retain a payload group',
    async (): Promise<void> => {
        await fixture(async (value: ExecutionPipeFixture): Promise<void> => {
            const invocation: DelayedInvocation = await launch(value, '', 1800n);
            try {
                await invocation.pipe.ready;
                const broker: ExecutionPipeDelayedBroker = await invocation.pipe.broker;
                const command: ExecutionNativePipeData = data(
                    invocation,
                    0n,
                    0n,
                    Buffer.alloc(0),
                    invocation.executionDeadlineMs,
                );
                await invocation.pipe.send(command);
                const flood: Promise<PromiseSettledResult<undefined>[]> = Promise.allSettled([
                    broker.blockAndFlood(ExecutionNativePipeCodec.capture(command).encoded),
                ]);
                const began: number = performance.now();
                await setTimeout(50);
                expect(broker.source.isPaused()).toBe(true);
                expect(broker.source.readableLength).toBeGreaterThan(0);
                const result: ExecutionResult = await invocation.task;
                expect(performance.now() - began).toBeGreaterThan(500);
                expect(performance.now() - began).toBeLessThan(5000);
                expect(result).toMatchObject({
                    termination: ExecutionTermination.Indeterminate,
                    exitCode: null,
                });
                expect(Buffer.from(result.stdoutBase64, 'base64')).toEqual(Buffer.alloc(0));
                expect(Buffer.from(result.stderrBase64, 'base64').toString()).not.toContain(
                    'real EOF',
                );
                expect(invocation.pipe.cursor()).toMatchObject({
                    processedSequence: 0n,
                    initialAccepted: true,
                    acceptedOffset: 0n,
                    ended: false,
                });
                await flood;
                await cleaned(value);
            } finally {
                invocation.stop.abort();
                await invocation.joined;
            }
        });
    },
    20000,
);

for (const initial of ['', 'queued\0binary']) {
    it.skipIf(!qualified)(
        `actual native broker rejects queued expired initial0 (${initial.length} bytes), even beside a renewed wrapper`,
        async (): Promise<void> => {
            await fixture(async (value: ExecutionPipeFixture): Promise<void> => {
                const invocation: DelayedInvocation = await launch(value, initial);
                try {
                    await invocation.pipe.ready;
                    const broker: ExecutionPipeDelayedBroker = await invocation.pipe.broker;
                    broker.arm();
                    const expires: bigint = BigInt(Date.now()) + 150n;
                    const command: ExecutionNativePipeData = data(
                        invocation,
                        0n,
                        0n,
                        Buffer.from(initial),
                        expires,
                    );
                    const pending: Promise<ExecutionNativePipeApplied> =
                        invocation.pipe.send(command);
                    const observed: Promise<PromiseSettledResult<ExecutionNativePipeApplied>[]> =
                        Promise.allSettled([pending]);
                    await broker.held;
                    const renewed: ExecutionNativePipeData = {
                        ...command,
                        deliveryExpiresAtMs: invocation.executionDeadlineMs,
                    };
                    const duplicate: Promise<ExecutionNativePipeApplied> =
                        invocation.pipe.send(renewed);
                    const duplicateObserved: Promise<
                        PromiseSettledResult<ExecutionNativePipeApplied>[]
                    > = Promise.allSettled([duplicate]);
                    expect(broker.writes).toBe(0);
                    await after(expires);
                    broker.release(ExecutionNativePipeCodec.capture(renewed).encoded);
                    expect((await observed)[0]?.status).toBe('rejected');
                    expect((await duplicateObserved)[0]?.status).toBe('rejected');
                    const result: ExecutionResult = await invocation.task;
                    expect(result).toMatchObject({
                        termination: ExecutionTermination.Indeterminate,
                        exitCode: null,
                    });
                    expect(Buffer.from(result.stdoutBase64, 'base64')).toEqual(Buffer.alloc(0));
                    expect(Buffer.from(result.stderrBase64, 'base64').toString()).not.toContain(
                        'real EOF',
                    );
                    expect(invocation.pipe.cursor()).toMatchObject({
                        processedSequence: null,
                        initialAccepted: false,
                        acceptedOffset: 0n,
                        ended: false,
                    });
                    expect(broker.writes).toBe(1);
                    await cleaned(value);
                } finally {
                    invocation.stop.abort();
                    await invocation.joined;
                }
            });
        },
        20000,
    );
}

it.skipIf(!qualified)(
    'expired queued EOF retains the complete prior binary range without accepting EOF or replaying bytes',
    async (): Promise<void> => {
        await fixture(async (value: ExecutionPipeFixture): Promise<void> => {
            const initial: string = 'confirmed\0prefix';
            const invocation: DelayedInvocation = await launch(value, initial);
            try {
                await invocation.pipe.ready;
                await invocation.pipe.send(
                    data(invocation, 0n, 0n, Buffer.from(initial), invocation.executionDeadlineMs),
                );
                const broker: ExecutionPipeDelayedBroker = await invocation.pipe.broker;
                broker.arm();
                const expires: bigint = BigInt(Date.now()) + 150n;
                const command: ExecutionNativePipeEnd = end(
                    invocation,
                    1n,
                    BigInt(Buffer.byteLength(initial)),
                    expires,
                );
                const observed: Promise<PromiseSettledResult<ExecutionNativePipeApplied>[]> =
                    Promise.allSettled([invocation.pipe.send(command)]);
                await broker.held;
                await after(expires);
                broker.release();
                expect((await observed)[0]?.status).toBe('rejected');
                const result: ExecutionResult = await invocation.task;
                expect(result).toMatchObject({
                    termination: ExecutionTermination.Indeterminate,
                    exitCode: null,
                });
                expect(Buffer.from(result.stdoutBase64, 'base64')).toEqual(Buffer.from(initial));
                expect(Buffer.from(result.stderrBase64, 'base64').toString()).not.toContain(
                    'real EOF',
                );
                expect(invocation.pipe.cursor()).toMatchObject({
                    processedSequence: 0n,
                    initialAccepted: true,
                    acceptedOffset: BigInt(Buffer.byteLength(initial)),
                    ended: false,
                });
                await cleaned(value);
            } finally {
                invocation.stop.abort();
                await invocation.joined;
            }
        });
    },
    20000,
);

it.skipIf(!qualified)(
    'an expired completed-fact wrapper returns the exact native receipt without another descriptor write',
    async (): Promise<void> => {
        await fixture(async (value: ExecutionPipeFixture): Promise<void> => {
            const invocation: DelayedInvocation = await launch(value, 'once');
            try {
                await invocation.pipe.ready;
                const broker: ExecutionPipeDelayedBroker = await invocation.pipe.broker;
                const expires: bigint = BigInt(Date.now()) + 250n;
                const command: ExecutionNativePipeData = data(
                    invocation,
                    0n,
                    0n,
                    Buffer.from('once'),
                    expires,
                );
                const receipt: ExecutionNativePipeApplied = await invocation.pipe.send(command);
                await after(expires);
                expect(
                    await invocation.pipe.send({ ...command, deliveryExpiresAtMs: expires - 1n }),
                ).toBe(receipt);
                expect(broker.writes).toBe(1);
                await invocation.pipe.send(end(invocation, 1n, 4n, invocation.executionDeadlineMs));
                const result: ExecutionResult = await invocation.task;
                expect(result).toMatchObject({
                    termination: ExecutionTermination.Exited,
                    exitCode: 0,
                });
                expect(Buffer.from(result.stdoutBase64, 'base64').toString()).toBe('once');
                expect(Buffer.from(result.stderrBase64, 'base64').toString()).toBe('real EOF\n');
                expect(broker.writes).toBe(2);
                await cleaned(value);
            } finally {
                invocation.stop.abort();
                await invocation.joined;
            }
        });
    },
    20000,
);
