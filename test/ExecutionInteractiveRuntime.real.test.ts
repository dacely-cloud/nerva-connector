// SPDX-FileCopyrightText: 2026 Dacely <business@dacely.com>
// SPDX-License-Identifier: LicenseRef-Proprietary

import { readFile, readdir } from 'node:fs/promises';
import { expect, it, vi, type MockInstance } from 'vitest';
import { ExecutionInteractiveRuntimeFixture as Fixture } from './support/ExecutionInteractiveRuntimeFixture.js';
import { ExecutionPipeProbe } from './support/ExecutionPipeFixture.js';
import {
    ExecutionInputKind,
    ExecutionInputDisposition,
    type ExecutionInputReceipt,
    type ExecutionInputPermit,
    type ExecutionInputPermitBody,
    type ExecutionInputAcknowledgment,
} from 'nerva-connector-protocol/execution/ExecutionInput.js';
import {
    ExecutionInputJournalControlKind,
    type ExecutionInputJournalRetainedControl,
    type ExecutionInputJournalControl,
} from '../src/execution/ExecutionInputJournalTypes.js';
import type { ExecutionInteractiveRuntimeReply } from '../src/execution/ExecutionInteractiveRuntimeTypes.js';
import { ExecutionInteractiveRuntime } from '../src/execution/ExecutionInteractiveRuntime.js';
import { ExecutionInteractiveCodec } from 'nerva-connector-protocol/execution/ExecutionInteractiveCodec.js';
import { ExecutionInteractiveProof as Proof } from 'nerva-connector-protocol/execution/ExecutionInteractiveProof.js';
import { ExecutionInputReceiptCodec } from 'nerva-connector-protocol/execution/ExecutionInputReceiptCodec.js';
import { ExecutionInputPermitCodec } from 'nerva-connector-protocol/execution/ExecutionInputPermitCodec.js';
import {
    ExecutionTermination,
    type ExecutionResult,
} from 'nerva-connector-protocol/execution/ExecutionTypes.js';
import { SignaturePurpose } from 'nerva-connector-protocol/identity/IdentityFormat.js';
import { SigningKey } from '../src/identity/SigningKey.js';
import type { ExecutionNativePipeHandle } from '../src/execution/ExecutionNativePipeHandle.js';
import type {
    ExecutionNativePipeApplied,
    ExecutionNativePipeCommand,
} from '../src/execution/ExecutionNativePipeProtocol.js';
import { ConnectorPrivateDirectory } from '../src/runtime/ConnectorPrivateDirectory.js';
import { ExecutionInputJournalOwner } from '../src/execution/ExecutionInputJournalOwner.js';

const helper: string | undefined = process.env['NERVA_CONNECTOR_EXEC_HELPER'];
function candidate(): string {
    if (helper === undefined) {
        throw new Error('Explicit native candidate required');
    }
    return helper;
}
function pending(fixture: Fixture): ExecutionInputJournalControl {
    const control: ExecutionInputJournalRetainedControl | null = fixture.journal.snapshot().pending;
    if (control === null || control.kind !== ExecutionInputJournalControlKind.Permit) {
        throw new Error('Expected exact retained pending input');
    }
    return control;
}
function receipt(value: ExecutionInteractiveRuntimeReply): ExecutionInputReceipt {
    if (value.receipt === null) {
        throw new Error('Expected genuine durable signed receipt');
    }
    return value.receipt;
}

it.skipIf(helper === undefined)(
    'real native Ready, encrypted input admission, NUL/live bytes, ACK-first polls and duplicate EOF never duplicate application input',
    async (): Promise<void> => {
        await using fixture: Fixture = await Fixture.create(
            candidate(),
            ExecutionPipeProbe.Echo,
            'a\0b',
        );
        const send: MockInstance<ExecutionNativePipeHandle['send']> = vi.spyOn(
            fixture.invocation.pipe,
            'send',
        );
        try {
            expect(
                SigningKey.verify(
                    SignaturePurpose.OperationExecutionInteractiveReady,
                    fixture.signed.peer.device.publicKey,
                    Proof.ready(
                        ExecutionInteractiveCodec.unsigned(fixture.runtime.admission.ready),
                    ),
                    fixture.runtime.admission.ready.signature,
                ),
            ).toBe(true);
            expect(fixture.invocation.pipe.cursor()).toMatchObject({
                initialAccepted: false,
                acceptedOffset: 0n,
            });
            expect(send).not.toHaveBeenCalled();
            const zeroPermit: ExecutionInputPermit = fixture.data();
            const zeroReceipt: ExecutionInputReceipt = receipt(
                await fixture.runtime.process(
                    { acknowledgment: null, permit: zeroPermit },
                    fixture.signed.session,
                ),
            );
            const zero: ExecutionInputJournalControl = pending(fixture);
            expect(zeroReceipt).toMatchObject({
                disposition: ExecutionInputDisposition.Applied,
                cursor: { acceptedOffset: 3n },
            });
            expect(
                SigningKey.verify(
                    SignaturePurpose.OperationExecutionInputReceipt,
                    fixture.signed.peer.device.publicKey,
                    Proof.receipt(
                        ExecutionInputReceiptCodec.unsigned(zeroReceipt, {
                            input: zeroPermit.input,
                            inputHash: zeroPermit.inputHash,
                            prior: zero.prior,
                        }),
                        {
                            input: zeroPermit.input,
                            inputHash: zeroPermit.inputHash,
                            prior: zero.prior,
                        },
                    ),
                    zeroReceipt.signature,
                ),
            ).toBe(true);
            expect(
                receipt(
                    await fixture.runtime.process(
                        { acknowledgment: null, permit: zeroPermit },
                        fixture.signed.session,
                    ),
                ),
            ).toEqual(zeroReceipt);
            const zeroAck: ExecutionInputAcknowledgment = fixture.signed.acknowledgment(
                zero,
                zeroReceipt,
            );
            const bytes: Buffer = Buffer.from([0, 255, 10, 42]);
            const onePermit: ExecutionInputPermit = fixture.data(
                bytes,
                1n,
                fixture.journal.snapshot().cursor,
            );
            const oneReceipt: ExecutionInputReceipt = receipt(
                await fixture.runtime.process(
                    { acknowledgment: zeroAck, permit: onePermit },
                    fixture.signed.session,
                ),
            );
            const one: ExecutionInputJournalControl = pending(fixture);
            expect(
                receipt(
                    await fixture.runtime.process(
                        { acknowledgment: zeroAck, permit: onePermit },
                        fixture.signed.session,
                    ),
                ),
            ).toEqual(oneReceipt);
            const oneAck: ExecutionInputAcknowledgment = fixture.signed.acknowledgment(
                one,
                oneReceipt,
            );
            const endPermit: ExecutionInputPermit = fixture.end(
                2n,
                fixture.journal.snapshot().cursor,
            );
            const endReceipt: ExecutionInputReceipt = receipt(
                await fixture.runtime.process(
                    { acknowledgment: oneAck, permit: endPermit },
                    fixture.signed.session,
                ),
            );
            const end: ExecutionInputJournalControl = pending(fixture);
            expect(endReceipt.cursor).toMatchObject({ ended: true, acceptedOffset: 7n });
            const result: ExecutionResult = await fixture.invocation.task;
            expect(result, Buffer.from(result.stderrBase64, 'base64').toString()).toMatchObject({
                termination: ExecutionTermination.Exited,
                exitCode: 0,
            });
            expect(Buffer.from(result.stdoutBase64, 'base64')).toEqual(
                Buffer.concat([Buffer.from('a\0b'), bytes]),
            );
            expect(Buffer.from(result.stderrBase64, 'base64').toString()).toBe('real EOF\n');
            const endAck: ExecutionInputAcknowledgment = fixture.signed.acknowledgment(
                end,
                endReceipt,
            );
            expect(
                receipt(
                    await fixture.runtime.process(
                        { acknowledgment: endAck, permit: endPermit },
                        fixture.signed.session,
                    ),
                ),
            ).toEqual(endReceipt);
            const elevatedBody: ExecutionInputPermitBody = {
                ...ExecutionInputPermitCodec.unsigned(endPermit),
                writerGeneration: 2n,
            };
            const elevated: ExecutionInputPermit = {
                ...elevatedBody,
                signature: fixture.signed.peer.authority.sign(
                    SignaturePurpose.OperationExecutionInputPermit,
                    Proof.permit(elevatedBody, fixture.runtime.admission.ready),
                ),
            };
            expect(
                receipt(
                    await fixture.runtime.process(
                        { acknowledgment: null, permit: elevated },
                        fixture.signed.session,
                    ),
                ),
            ).toEqual(endReceipt);
            await expect(
                fixture.runtime.process(
                    { acknowledgment: null, permit: endPermit },
                    fixture.signed.session,
                ),
            ).rejects.toThrow('Stale');
            const expiredAt: bigint = BigInt(Date.now()) - 1n;
            const expiredBody: ExecutionInputPermitBody = {
                ...elevatedBody,
                issuedAtMs: expiredAt - 1n,
                expiresAtMs: expiredAt,
            };
            const expired: ExecutionInputPermit = {
                ...expiredBody,
                signature: fixture.signed.peer.authority.sign(
                    SignaturePurpose.OperationExecutionInputPermit,
                    Proof.permit(expiredBody, fixture.runtime.admission.ready),
                ),
            };
            await expect(
                fixture.runtime.process(
                    { acknowledgment: null, permit: expired },
                    fixture.signed.session,
                ),
            ).rejects.toThrow('expired');
            const differentInput: typeof endPermit.input = {
                ...endPermit.input,
                inputId: 'different-input',
            };
            const changedBody: ExecutionInputPermitBody = {
                ...elevatedBody,
                input: differentInput,
                inputHash: Proof.inputHash(differentInput),
            };
            const changed: ExecutionInputPermit = {
                ...changedBody,
                signature: fixture.signed.peer.authority.sign(
                    SignaturePurpose.OperationExecutionInputPermit,
                    Proof.permit(changedBody, fixture.runtime.admission.ready),
                ),
            };
            await expect(
                fixture.runtime.process(
                    { acknowledgment: null, permit: changed },
                    fixture.signed.session,
                ),
            ).rejects.toThrow('unavailable');
            expect(send).toHaveBeenCalledTimes(3);
            if (endPermit.input.control.kind !== ExecutionInputKind.End) {
                throw new Error('Exact End control required');
            }
            const altered: ExecutionInputPermit = {
                ...endPermit,
                input: { ...endPermit.input, control: { ...endPermit.input.control, offset: 0n } },
            };
            await expect(
                fixture.runtime.process(
                    { acknowledgment: null, permit: altered },
                    fixture.signed.session,
                ),
            ).rejects.toThrow();
            expect(send).toHaveBeenCalledTimes(3);
            expect((await readFile(fixture.signed.file)).includes(Buffer.from('a\0b'))).toBe(false);
            expect(
                (await readdir(fixture.native.native.delegation)).filter((name: string): boolean =>
                    name.startsWith('exec-'),
                ),
            ).toEqual([]);
        } finally {
            send.mockRestore();
        }
    },
);

it.skipIf(helper === undefined)(
    'a stopped in-flight control preserves uncertainty even after genuine kernel acceptance and retries only its identical saved proof',
    async (): Promise<void> => {
        await using fixture: Fixture = await Fixture.create(
            candidate(),
            ExecutionPipeProbe.Hold,
            'possible',
        );
        const applied: PromiseWithResolvers<ExecutionNativePipeApplied> =
            Promise.withResolvers<ExecutionNativePipeApplied>();
        const release: PromiseWithResolvers<undefined> = Promise.withResolvers<undefined>();
        const actual: ExecutionNativePipeHandle['send'] = fixture.invocation.pipe.send.bind(
            fixture.invocation.pipe,
        );
        const send: MockInstance<ExecutionNativePipeHandle['send']> = vi
            .spyOn(fixture.invocation.pipe, 'send')
            .mockImplementationOnce(
                async (
                    command: ExecutionNativePipeCommand,
                ): Promise<ExecutionNativePipeApplied> => {
                    const result: ExecutionNativePipeApplied = await actual(command);
                    applied.resolve(result);
                    await release.promise;
                    return result;
                },
            );
        const permit: ExecutionInputPermit = fixture.data();
        const work: Promise<ExecutionInteractiveRuntimeReply> = fixture.runtime.process(
            { acknowledgment: null, permit },
            fixture.signed.session,
        );
        const joined: Promise<PromiseSettledResult<ExecutionInteractiveRuntimeReply>[]> =
            Promise.allSettled([work]);
        try {
            expect(await applied.promise).toMatchObject({ acceptedOffset: 8n });
            await expect(
                fixture.runtime.process({ acknowledgment: null, permit }, fixture.signed.session),
            ).rejects.toThrow('in flight');
            fixture.runtime.stopInput();
            release.resolve(undefined);
            const outcome: ExecutionInputReceipt = receipt(await work);
            expect(outcome).toMatchObject({
                disposition: ExecutionInputDisposition.Indeterminate,
                cursor: {
                    acceptedOffset: 0n,
                    processedSequence: null,
                    initialAccepted: false,
                    blocked: true,
                },
            });
            expect(
                receipt(
                    await fixture.runtime.process(
                        { acknowledgment: null, permit },
                        fixture.signed.session,
                    ),
                ),
            ).toEqual(outcome);
            expect(send).toHaveBeenCalledTimes(1);
            fixture.stop.abort();
            await fixture.invocation.joined;
        } finally {
            release.resolve(undefined);
            fixture.stop.abort();
            await joined;
            send.mockRestore();
        }
    },
);

it.skipIf(helper === undefined)(
    'actual native ownership loss yields a durable signed Indeterminate and cannot relaunch or resend input',
    async (): Promise<void> => {
        await using fixture: Fixture = await Fixture.create(
            candidate(),
            ExecutionPipeProbe.Hold,
            'not delivered',
        );
        fixture.stop.abort();
        await fixture.invocation.joined;
        const send: MockInstance<ExecutionNativePipeHandle['send']> = vi.spyOn(
            fixture.invocation.pipe,
            'send',
        );
        try {
            const permit: ExecutionInputPermit = fixture.data();
            const outcome: ExecutionInputReceipt = receipt(
                await fixture.runtime.process(
                    { acknowledgment: null, permit },
                    fixture.signed.session,
                ),
            );
            expect(outcome.disposition).toBe(ExecutionInputDisposition.Indeterminate);
            expect(
                receipt(
                    await fixture.runtime.process(
                        { acknowledgment: null, permit },
                        fixture.signed.session,
                    ),
                ),
            ).toEqual(outcome);
            expect(send).toHaveBeenCalledTimes(1);
            expect(fixture.invocation.pipe.cursor().acceptedOffset).toBe(0n);
        } finally {
            send.mockRestore();
        }
    },
);

it.skipIf(helper === undefined)(
    'a receipt publication fault after real kernel input acceptance never returns an unsaved Applied and recovery never retries the input',
    async (): Promise<void> => {
        await using fixture: Fixture = await Fixture.create(
            candidate(),
            ExecutionPipeProbe.Hold,
            'maybe accepted',
        );
        const write: MockInstance<ConnectorPrivateDirectory['write']> = vi
            .spyOn(ConnectorPrivateDirectory.prototype, 'write')
            .mockImplementationOnce(async function (
                this: ConnectorPrivateDirectory,
                name: string,
                bytes: Buffer,
                maximum: number,
                initialize: boolean,
            ): Promise<void> {
                write.mockRestore();
                await this.write(name, bytes, maximum, initialize);
                vi.spyOn(ConnectorPrivateDirectory.prototype, 'write').mockRejectedValueOnce(
                    new Error('fixture receipt publication failed'),
                );
            });
        const permit: ExecutionInputPermit = fixture.data();
        try {
            await expect(
                fixture.runtime.process({ acknowledgment: null, permit }, fixture.signed.session),
            ).rejects.toThrow('receipt publication failed');
            expect(fixture.invocation.pipe.cursor().acceptedOffset).toBe(14n);
        } finally {
            vi.restoreAllMocks();
        }
        fixture.stop.abort();
        await fixture.invocation.joined;
        await fixture.journal[Symbol.asyncDispose]();
        await using recovered: ExecutionInputJournalOwner = await ExecutionInputJournalOwner.open(
            fixture.signed.directory,
            fixture.signed.peer.identity,
            fixture.signed.scope,
        );
        const state: ReturnType<ExecutionInputJournalOwner['snapshot']> = await recovered.restore(
            fixture.runtime.admission,
        );
        expect(state).toMatchObject({
            ownerLost: true,
            pending: { receipt: { disposition: ExecutionInputDisposition.Indeterminate } },
            cursor: { acceptedOffset: 0n },
        });
        expect(
            (await recovered.stage(permit, fixture.signed.session, BigInt(Date.now()))).receipt,
        ).toEqual(state.pending?.receipt);
    },
);

it.skipIf(helper === undefined)(
    'failure to durably stage an input leaves the real native pipe untouched',
    async (): Promise<void> => {
        await using fixture: Fixture = await Fixture.create(
            candidate(),
            ExecutionPipeProbe.Hold,
            'must not write',
        );
        const before: Buffer = await readFile(fixture.signed.file);
        const send: MockInstance<ExecutionNativePipeHandle['send']> = vi.spyOn(
            fixture.invocation.pipe,
            'send',
        );
        const write: MockInstance<ConnectorPrivateDirectory['write']> = vi
            .spyOn(ConnectorPrivateDirectory.prototype, 'write')
            .mockRejectedValueOnce(new Error('fixture input intent publication failed'));
        try {
            await expect(
                fixture.runtime.process(
                    { acknowledgment: null, permit: fixture.data() },
                    fixture.signed.session,
                ),
            ).rejects.toThrow('intent publication failed');
            expect(send).not.toHaveBeenCalled();
            expect(fixture.invocation.pipe.cursor()).toMatchObject({
                acceptedOffset: 0n,
                initialAccepted: false,
            });
            expect((await readFile(fixture.signed.file)).equals(before)).toBe(true);
        } finally {
            write.mockRestore();
            send.mockRestore();
        }
    },
);

it.skipIf(helper === undefined)(
    'mismatched native incarnation and tighter bootstrap grants refuse adapter creation before initial input',
    async (): Promise<void> => {
        await using fixture: Fixture = await Fixture.create(candidate(), ExecutionPipeProbe.Hold);
        const settings: Parameters<typeof ExecutionInteractiveRuntime.create>[0] = {
            identity: fixture.signed.peer.identity,
            permit: fixture.startPermit,
            rule: fixture.runtime.admission.rule,
            launch: fixture.runtime.admission.launch,
            incarnation: fixture.invocation.incarnation,
            native: fixture.invocation.pipe,
            journal: fixture.journal,
            nowMs: (): bigint => BigInt(Date.now()),
        };
        await expect(
            ExecutionInteractiveRuntime.create({ ...settings, incarnation: 'f'.repeat(64) }),
        ).rejects.toThrow('owner changed');
        await expect(
            ExecutionInteractiveRuntime.create({
                ...settings,
                rule: { ...settings.rule, maximumControls: 2 },
            }),
        ).rejects.toThrow('owner changed');
        expect(fixture.invocation.pipe.cursor()).toMatchObject({
            initialAccepted: false,
            acceptedOffset: 0n,
        });
        const wrong: ExecutionInputPermit = { ...fixture.data(), signature: 'A'.repeat(3312) };
        await expect(
            fixture.runtime.process(
                {
                    acknowledgment: null,
                    permit: ExecutionInputPermitCodec.decode(
                        ExecutionInputPermitCodec.encode(wrong),
                    ),
                },
                fixture.signed.session,
            ),
        ).rejects.toThrow();
        expect(fixture.invocation.pipe.cursor().acceptedOffset).toBe(0n);
    },
);
