// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

import { setTimeout as delay } from 'node:timers/promises';
import { expect, it, vi, type MockInstance } from 'vitest';
import type { ExecutionNativePipeHandle } from '../src/execution/ExecutionNativePipeHandle.js';
import { ExecutionInteractiveOwnershipFixture as Fixture } from './support/ExecutionInteractiveOwnershipFixture.js';
import { ExecutionInputWorkCapture } from 'nerva-connector-protocol/execution/ExecutionInputWorkCapture.js';
import { ExecutionInputPermitCodec } from 'nerva-connector-protocol/execution/ExecutionInputPermitCodec.js';
import { ExecutionInputAcknowledgmentCodec } from 'nerva-connector-protocol/execution/ExecutionInputAcknowledgmentCodec.js';
import { ExecutionInputReceiptCodec } from 'nerva-connector-protocol/execution/ExecutionInputReceiptCodec.js';
import {
    ExecutionInputKind,
    ExecutionInputDisposition,
    type ExecutionInputPermit,
    type ExecutionInputReceipt,
    type ExecutionInputAcknowledgment,
} from 'nerva-connector-protocol/execution/ExecutionInput.js';
import {
    ExecutionInputJournalControlKind,
    type ExecutionInputJournalRetainedControl,
    type ExecutionInputJournalControl,
} from '../src/execution/ExecutionInputJournalTypes.js';
import type { ExecutionInteractiveDeliveryReply } from '../src/execution/ExecutionInteractiveOwnershipTypes.js';
import { ExecutionInteractiveRetirementPending } from '../src/execution/ExecutionInteractiveRetirementPending.js';
import { ExecutionTermination, type ExecutionResult } from '../src/execution/ExecutionTypes.js';
import { ExecutionInteractiveProof } from 'nerva-connector-protocol/execution/ExecutionInteractiveProof.js';
import { SignaturePurpose } from 'nerva-connector-protocol/identity/IdentityFormat.js';
import type {
    ExecutionCompletion,
    ExecutionAcknowledgment,
} from '../src/execution/ExecutionJobs.js';
import {
    ExecutionInputDelivery,
    type ExecutionInteractiveDeliveryClient,
} from '../src/execution/ExecutionInputDelivery.js';
import type { ExecutionDeliveryLink } from '../src/execution/ExecutionDeliveryLink.js';
import {
    ConnectorFrameKind,
    type ConnectorClientFrame,
} from '../src/protocol/ConnectorTransport.js';
import { ConnectorClientSession } from '../src/runtime/ConnectorClientSession.js';
import type {
    ExecutionNativePipeApplied,
    ExecutionNativePipeCommand,
} from '../src/execution/ExecutionNativePipeProtocol.js';
import { ConnectorEffectKind } from '../src/runtime/ConnectorEffectContext.js';
import { ExecutionPipeProbe } from './support/ExecutionPipeFixture.js';
import { ExecutionInputTerminalResolutionCodec } from 'nerva-connector-protocol/execution/ExecutionInputTerminalResolutionCodec.js';
import type {
    ExecutionInputTerminalResolution,
    ExecutionInputTerminalResolutionBody,
} from 'nerva-connector-protocol/execution/ExecutionInputTerminalResolution.js';
import type { ExecutionInputAcknowledgmentBody } from 'nerva-connector-protocol/execution/ExecutionInput.js';
import { ExecutionInputJournalControls } from '../src/execution/ExecutionInputJournalControls.js';

const helper: string | undefined = process.env['NERVA_CONNECTOR_EXEC_HELPER'];
function candidate(): string {
    if (helper === undefined) {
        throw new Error('Explicit unused native candidate required');
    }
    return helper;
}
function work(
    permit: ExecutionInputPermit | null,
    ack: ExecutionInputAcknowledgment | null = null,
    receipt: ExecutionInputReceipt | null = null,
): ExecutionInputWorkCapture {
    if (ack !== null && receipt === null) {
        throw new Error('Exact retained receipt required for ACK fixture');
    }
    return ExecutionInputWorkCapture.read(
        JSON.parse(
            '{"permit":' +
                (permit === null ? 'null' : ExecutionInputPermitCodec.encode(permit)) +
                ',"resolution":null,"acknowledgment":' +
                (ack === null || receipt === null
                    ? 'null'
                    : ExecutionInputAcknowledgmentCodec.encode(ack, receipt)) +
                '}',
        ),
    );
}
function pending(fixture: Fixture): ExecutionInputJournalControl {
    const value: ExecutionInputJournalRetainedControl | null =
        fixture.owner.journal.snapshot().pending;
    if (value === null || value.kind !== ExecutionInputJournalControlKind.Permit) {
        throw new Error('Durable pending input required');
    }
    return value;
}
function receipt(
    reply: ExecutionInteractiveDeliveryReply,
    control: ExecutionInputJournalControl,
): ExecutionInputReceipt {
    if (reply.completion === null) {
        throw new Error('Durable receipt capture required');
    }
    return reply.completion.receipt({
        input: control.permit.input,
        inputHash: control.permit.inputHash,
        prior: control.prior,
    });
}

it.skipIf(helper === undefined)(
    'actual native Ready and two encrypted journals keep initial0 explicit, preserve binary effects once and drain terminal input ACK after the immutable deadline',
    async (): Promise<void> => {
        await using fixture: Fixture = await Fixture.create(candidate(), 'a\0b');
        const send: MockInstance<ExecutionNativePipeHandle['send']> = vi.spyOn(
            fixture.binding.pipe,
            'send',
        );
        const admission: ReturnType<typeof fixture.owner.journal.snapshot>['admission'] =
            fixture.owner.journal.snapshot().admission;
        expect(fixture.owner.ready(fixture.signed.session)).toEqual(admission.ready);
        expect(fixture.main.pending?.effectContext).toMatchObject({
            kind: ConnectorEffectKind.CapturedInteractiveExecution,
            incarnation: admission.ready.incarnation,
        });
        expect(fixture.owner.journal.snapshot().cursor.initialAccepted).toBe(false);
        expect(send).not.toHaveBeenCalled();
        const zero: ExecutionInputPermit = fixture.signed.input(admission);
        const zeroReply: ExecutionInteractiveDeliveryReply = await fixture.owner.input(
            work(zero),
            fixture.signed.session,
        );
        const zeroControl: ExecutionInputJournalControl = pending(fixture);
        const zeroReceipt: ExecutionInputReceipt = receipt(zeroReply, zeroControl);
        expect(zeroReceipt.disposition).toBe(ExecutionInputDisposition.Applied);
        expect(send).toHaveBeenCalledTimes(1);
        expect(
            (
                await fixture.owner.input(work(zero), fixture.signed.session)
            ).completion?.receiptJson(),
        ).toBe(zeroReply.completion?.receiptJson());
        expect(send).toHaveBeenCalledTimes(1);
        const zeroAck: ExecutionInputAcknowledgment = fixture.signed.acknowledgment(
            zeroControl,
            zeroReceipt,
        );
        const bytes: Buffer = Buffer.from([0, 255, 10, 128]);
        const next: ExecutionInputPermit = fixture.signed.input(
            admission,
            bytes,
            1n,
            fixture.owner.journal.snapshot().cursor,
        );
        const nextReply: ExecutionInteractiveDeliveryReply = await fixture.owner.input(
            work(next, zeroAck, zeroReceipt),
            fixture.signed.session,
        );
        const nextControl: ExecutionInputJournalControl = pending(fixture);
        const nextReceipt: ExecutionInputReceipt = receipt(nextReply, nextControl);
        const nextAck: ExecutionInputAcknowledgment = fixture.signed.acknowledgment(
            nextControl,
            nextReceipt,
        );
        const { signature: _signature, ...inputBody }: ExecutionInputPermit = fixture.signed.input(
            admission,
            Buffer.from('fixture'),
            2n,
            nextReceipt.cursor,
        );
        const endInput: typeof inputBody.input = {
            ...inputBody.input,
            control: { kind: ExecutionInputKind.End, offset: nextReceipt.cursor.acceptedOffset },
        };
        const endBody: typeof inputBody = {
            ...inputBody,
            input: endInput,
            inputHash: ExecutionInteractiveProof.inputHash(endInput),
        };
        const end: ExecutionInputPermit = {
            ...endBody,
            signature: fixture.signed.peer.authority.sign(
                SignaturePurpose.OperationExecutionInputPermit,
                ExecutionInteractiveProof.permit(endBody, admission.ready),
            ),
        };
        const endReply: ExecutionInteractiveDeliveryReply = await fixture.owner.input(
            work(end, nextAck, nextReceipt),
            fixture.signed.session,
        );
        const endControl: ExecutionInputJournalControl = pending(fixture);
        const endReceipt: ExecutionInputReceipt = receipt(endReply, endControl);
        const result: ExecutionResult = await fixture.task;
        expect(result).toMatchObject({ termination: ExecutionTermination.Exited, exitCode: 0 });
        expect(Buffer.from(result.stdoutBase64, 'base64')).toEqual(
            Buffer.concat([Buffer.from('a\0b'), bytes]),
        );
        const completion: ExecutionCompletion = fixture.completion(result);
        const mainAck: ExecutionAcknowledgment = fixture.signed.terminalAck(completion);
        await expect(
            fixture.owner.retire(completion, mainAck, fixture.signed.session),
        ).rejects.toBeInstanceOf(ExecutionInteractiveRetirementPending);
        expect(fixture.main.pending?.response).toEqual(result);
        const remaining: bigint = admission.launch.executionDeadlineMs - BigInt(Date.now()) + 20n;
        if (remaining > 0n) {
            await delay(Number(remaining));
        }
        const before: number = send.mock.calls.length;
        const drained: ExecutionInteractiveDeliveryReply = await fixture.owner.input(
            ExecutionInputWorkCapture.empty(),
            fixture.signed.session,
        );
        expect(drained.completion?.receiptJson()).toBe(endReply.completion?.receiptJson());
        const endAck: ExecutionInputAcknowledgment = fixture.signed.acknowledgment(
            endControl,
            endReceipt,
        );
        await fixture.owner.input(work(null, endAck, endReceipt), fixture.signed.session);
        expect(send.mock.calls.length).toBe(before);
        await fixture.owner.retire(completion, mainAck, fixture.signed.session);
        await fixture.main.acknowledge(mainAck);
        expect(fixture.main.pending).toBe(null);
        expect(fixture.owner.journal.snapshot().terminal?.responseHash).toBe(
            completion.responseHash,
        );
        expect(
            ExecutionInputReceiptCodec.encode(endReceipt, {
                input: endControl.permit.input,
                inputHash: endControl.permit.inputHash,
                prior: endControl.prior,
            }),
        ).toBe(endReply.completion?.receiptJson());
    },
);

it.skipIf(helper === undefined)(
    'ReadyStored releases no initial bytes and a replaced observer drains the first durable receipt without replaying the accepted native input',
    async (): Promise<void> => {
        await using fixture: Fixture = await Fixture.create(candidate(), 'observer\0input');
        const admission: ReturnType<typeof fixture.owner.journal.snapshot>['admission'] =
            fixture.owner.journal.snapshot().admission;
        const client: ExecutionInteractiveDeliveryClient = {
            get failed(): boolean {
                return fixture.owner.failed;
            },
            interactiveReady: (session: ConnectorClientSession): typeof admission.ready | null =>
                fixture.owner.ready(session),
            input: (
                value: ExecutionInputWorkCapture,
                session: ConnectorClientSession,
            ): Promise<ExecutionInteractiveDeliveryReply> => fixture.owner.input(value, session),
        };
        await using delivery: ExecutionInputDelivery = new ExecutionInputDelivery(
            client,
            (): void => {},
        );
        const first: ConnectorClientFrame[] = [];
        const second: ConnectorClientFrame[] = [];
        let closed: number = 0;
        const link: ExecutionDeliveryLink = {
            session: fixture.signed.session,
            leaseId: fixture.signed.lease.leaseId,
            send: (frame: ConnectorClientFrame): void => {
                first.push(frame);
            },
            close: (): void => {
                closed++;
            },
        };
        const entered: PromiseWithResolvers<undefined> = Promise.withResolvers<undefined>();
        const release: PromiseWithResolvers<undefined> = Promise.withResolvers<undefined>();
        const original: ExecutionNativePipeHandle['send'] = fixture.binding.pipe.send.bind(
            fixture.binding.pipe,
        );
        const send: MockInstance<ExecutionNativePipeHandle['send']> = vi
            .spyOn(fixture.binding.pipe, 'send')
            .mockImplementation(
                async (
                    command: ExecutionNativePipeCommand,
                ): Promise<ExecutionNativePipeApplied> => {
                    const applied: ExecutionNativePipeApplied = await original.call(
                        fixture.binding.pipe,
                        command,
                    );
                    entered.resolve(undefined);
                    await release.promise;
                    return applied;
                },
            );
        delivery.activate(link);
        expect(first).toEqual([
            {
                kind: ConnectorFrameKind.ExecutionInteractiveReady,
                submission: { leaseId: link.leaseId, ready: admission.ready },
            },
        ]);
        delivery.receive(
            {
                kind: ConnectorFrameKind.ExecutionInteractiveReadyStored,
                submission: { leaseId: link.leaseId, ready: admission.ready },
            },
            link,
        );
        expect(send).not.toHaveBeenCalled();
        const zero: ExecutionInputPermit = fixture.signed.input(admission);
        delivery.receive(
            {
                kind: ConnectorFrameKind.ExecutionInputWork,
                original: fixture.signed.original(admission.ready),
                work: work(zero),
            },
            link,
        );
        await entered.promise;
        const current: ConnectorClientSession = new ConnectorClientSession(
            fixture.signed.peer.identity,
        );
        const now: bigint = BigInt(Date.now());
        const challenge: ReturnType<typeof fixture.signed.peer.challenge> =
            fixture.signed.peer.challenge(current.begin(now));
        const lease: ReturnType<ConnectorClientSession['confirm']> = current.confirm(
            fixture.signed.peer.confirmation(challenge, current.prove(challenge, now)),
            now,
        );
        const replacement: ExecutionDeliveryLink = {
            session: current,
            leaseId: lease.leaseId,
            send: (frame: ConnectorClientFrame): void => {
                second.push(frame);
            },
            close: (): void => {
                closed++;
            },
        };
        try {
            delivery.detach(link);
            fixture.signed.session[Symbol.dispose]();
            delivery.activate(replacement);
            delivery.receive(
                {
                    kind: ConnectorFrameKind.ExecutionInteractiveReadyStored,
                    submission: { leaseId: replacement.leaseId, ready: admission.ready },
                },
                replacement,
            );
            delivery.receive(
                {
                    kind: ConnectorFrameKind.ExecutionInputWork,
                    original: fixture.signed.original(admission.ready),
                    work: ExecutionInputWorkCapture.empty(),
                },
                replacement,
            );
            release.resolve(undefined);
            await vi.waitFor((): void =>
                expect(
                    second.some(
                        (frame: ConnectorClientFrame): boolean =>
                            frame.kind === ConnectorFrameKind.ExecutionInputReceipt,
                    ),
                ).toBe(true),
            );
            expect(first).toHaveLength(1);
            expect(send).toHaveBeenCalledTimes(1);
            expect(closed).toBe(0);
            const durable: ExecutionInputJournalControl = pending(fixture);
            expect(durable.receipt?.disposition).toBe(ExecutionInputDisposition.Applied);
            const delivered: ConnectorClientFrame | undefined = second.find(
                (frame: ConnectorClientFrame): boolean =>
                    frame.kind === ConnectorFrameKind.ExecutionInputReceipt,
            );
            if (
                delivered?.kind !== ConnectorFrameKind.ExecutionInputReceipt ||
                durable.receipt === null
            ) {
                throw new Error('Exact durable receipt delivery required');
            }
            expect(delivered.completion.receiptJson()).toBe(
                ExecutionInputReceiptCodec.encode(durable.receipt, {
                    input: durable.permit.input,
                    inputHash: durable.permit.inputHash,
                    prior: durable.prior,
                }),
            );
            delivery.receive(
                {
                    kind: ConnectorFrameKind.ExecutionInputWork,
                    original: fixture.signed.original(admission.ready),
                    work: ExecutionInputWorkCapture.empty(),
                },
                replacement,
            );
            await vi.waitFor((): void =>
                expect(fixture.owner.journal.snapshot().pending?.receipt).toEqual(durable.receipt),
            );
            expect(
                second.filter(
                    (frame: ConnectorClientFrame): boolean =>
                        frame.kind === ConnectorFrameKind.ExecutionInputReceipt,
                ),
            ).toHaveLength(1);
            expect(send).toHaveBeenCalledTimes(1);
        } finally {
            release.resolve(undefined);
            current[Symbol.dispose]();
            fixture.stop.abort();
            await fixture.joined;
        }
    },
);

it.skipIf(helper === undefined)(
    'unseen admitted initial input resolves only as durable lower-bound uncertainty after actual native completion and deadline, with zero native sends',
    async (): Promise<void> => {
        await using fixture: Fixture = await Fixture.create(
            candidate(),
            'never\0written',
            ExecutionPipeProbe.Hold,
            1000,
        );
        const send: MockInstance<ExecutionNativePipeHandle['send']> = vi.spyOn(
            fixture.binding.pipe,
            'send',
        );
        const admission: ReturnType<typeof fixture.owner.journal.snapshot>['admission'] =
            fixture.owner.journal.snapshot().admission;
        const admitted: ExecutionInputPermit = fixture.signed.input(admission);
        const prior: ReturnType<typeof fixture.owner.journal.snapshot>['cursor'] =
            fixture.owner.journal.snapshot().cursor;
        fixture.owner.stopInput();
        fixture.stop.abort();
        const result: ExecutionResult = await fixture.task;
        const responseHash: string = fixture.completion(result).responseHash;
        const remaining: bigint = admission.launch.executionDeadlineMs - BigInt(Date.now()) + 20n;
        if (remaining > 0n) {
            await delay(Number(remaining));
        }
        const nowMs: bigint = BigInt(Date.now());
        const body: ExecutionInputTerminalResolutionBody = {
            input: admitted.input,
            inputHash: admitted.inputHash,
            prior,
            leaseId: fixture.signed.lease.leaseId,
            writerGeneration: 1n,
            executionDeadlineMs: admission.launch.executionDeadlineMs,
            responseHash,
            issuedAtMs: nowMs,
            deliveryExpiresAtMs: nowMs + 2000n,
        };
        const resolution: ExecutionInputTerminalResolution = {
            ...body,
            signature: fixture.signed.peer.authority.sign(
                SignaturePurpose.OperationExecutionInputTerminalResolution,
                ExecutionInteractiveProof.resolution(body, admission.ready),
            ),
        };
        const observed: ExecutionInputWorkCapture = ExecutionInputWorkCapture.read(
            JSON.parse(
                '{"permit":null,"acknowledgment":null,"resolution":' +
                    ExecutionInputTerminalResolutionCodec.encode(resolution) +
                    '}',
            ),
        );
        const reply: ExecutionInteractiveDeliveryReply = await fixture.owner.input(
            observed,
            fixture.signed.session,
        );
        const control: ExecutionInputJournalRetainedControl | null =
            fixture.owner.journal.snapshot().pending;
        if (
            control?.kind !== ExecutionInputJournalControlKind.TerminalResolution ||
            reply.completion === null ||
            control.receipt === null
        ) {
            throw new Error('Durable no-effect resolution required');
        }
        const context: ReturnType<typeof ExecutionInputJournalControls.context> =
            ExecutionInputJournalControls.context(control);
        const first: ExecutionInputReceipt = reply.completion.receipt(context);
        expect(first).toMatchObject({
            disposition: ExecutionInputDisposition.Indeterminate,
            cursor: {
                acceptedOffset: 0n,
                processedSequence: null,
                initialAccepted: false,
                blocked: true,
            },
        });
        expect(send).not.toHaveBeenCalled();
        expect(
            (await fixture.owner.input(observed, fixture.signed.session)).completion?.receiptJson(),
        ).toBe(reply.completion.receiptJson());
        expect(send).not.toHaveBeenCalled();
        await expect(
            fixture.owner.journal.stage(admitted, fixture.signed.session, nowMs),
        ).rejects.toThrow();
        expect((): ExecutionInputPermit =>
            ExecutionInputPermitCodec.decode(
                ExecutionInputTerminalResolutionCodec.encode(resolution),
            ),
        ).toThrow();
        const wrong: ExecutionInputTerminalResolutionBody = {
            ...body,
            responseHash: 'f'.repeat(64),
        };
        const wrongResolution: ExecutionInputTerminalResolution = {
            ...wrong,
            signature: fixture.signed.peer.authority.sign(
                SignaturePurpose.OperationExecutionInputTerminalResolution,
                ExecutionInteractiveProof.resolution(wrong, admission.ready),
            ),
        };
        const invalid: ExecutionInputWorkCapture = ExecutionInputWorkCapture.read(
            JSON.parse(
                '{"permit":null,"acknowledgment":null,"resolution":' +
                    ExecutionInputTerminalResolutionCodec.encode(wrongResolution) +
                    '}',
            ),
        );
        await expect(fixture.owner.input(invalid, fixture.signed.session)).rejects.toThrow(
            'resolution',
        );
        const {
            signature: _signature,
            disposition: _disposition,
            cursor: _cursor,
            ...identity
        }: ExecutionInputReceipt = first;
        const ackBody: ExecutionInputAcknowledgmentBody = {
            ...identity,
            receiptSha256: ExecutionInteractiveProof.receiptSha256(first, context),
            leaseId: fixture.signed.lease.leaseId,
            writerGeneration: 1n,
        };
        const ack: ExecutionInputAcknowledgment = {
            ...ackBody,
            signature: fixture.signed.peer.authority.sign(
                SignaturePurpose.OperationExecutionInputAcknowledgment,
                ExecutionInteractiveProof.acknowledgment(ackBody, first, context),
            ),
        };
        await fixture.owner.input(work(null, ack, first), fixture.signed.session);
        const completion: ExecutionCompletion = fixture.completion(result);
        const mainAck: ExecutionAcknowledgment = fixture.signed.terminalAck(completion);
        await fixture.owner.retire(completion, mainAck, fixture.signed.session);
        await fixture.main.acknowledge(mainAck);
        expect(fixture.main.pending).toBe(null);
        expect(send).not.toHaveBeenCalled();
    },
);
