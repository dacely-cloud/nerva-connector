// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

import { expect, it, vi, type MockInstance } from 'vitest';
import { ExecutionInteractiveOwnershipFixture as Fixture } from './support/ExecutionInteractiveOwnershipFixture.js';
import { ExecutionInteractiveDeliveryFixture as Port } from './support/ExecutionInteractiveDeliveryFixture.js';
import { ExecutionDelivery } from '../src/execution/ExecutionDelivery.js';
import { type ExecutionDeliveryLink } from '../src/execution/ExecutionDeliveryLink.js';
import { ConnectorClientSession } from '../src/runtime/ConnectorClientSession.js';
import {
    ConnectorFrameKind,
    type ConnectorClientFrame,
} from '../src/protocol/ConnectorTransport.js';
import { ExecutionInputWorkCapture } from 'nerva-connector-protocol/execution/ExecutionInputWorkCapture.js';
import { ExecutionInputPermitCodec } from 'nerva-connector-protocol/execution/ExecutionInputPermitCodec.js';
import { ExecutionInputAcknowledgmentCodec } from 'nerva-connector-protocol/execution/ExecutionInputAcknowledgmentCodec.js';
import type { ExecutionInteractiveOwnership } from '../src/execution/ExecutionInteractiveOwnership.js';
import { ExecutionInputJournalControlKind } from '../src/execution/ExecutionInputJournalTypes.js';
import { ExecutionInputReceiptCapture } from 'nerva-connector-protocol/execution/ExecutionInputReceiptCapture.js';
import type {
    ExecutionInputAcknowledgment,
    ExecutionInputAcknowledgmentBody,
} from 'nerva-connector-protocol/execution/ExecutionInput.js';
import { SignaturePurpose } from 'nerva-connector-protocol/identity/IdentityFormat.js';
import { ExecutionInteractiveProof } from 'nerva-connector-protocol/execution/ExecutionInteractiveProof.js';
import { ExecutionPipeProbe } from './support/ExecutionPipeFixture.js';

const helper: string | undefined = process.env['NERVA_CONNECTOR_EXEC_HELPER'];

it.skipIf(helper === undefined)(
    'main ACK before last input ACK defers compaction, survives genuine lease renewal and emits exactly one current terminal receipt',
    async (): Promise<void> => {
        if (helper === undefined) {
            throw new Error('Explicit unused native helper required');
        }
        await using fixture: Fixture = await Fixture.create(
            helper,
            'accepted-once',
            ExecutionPipeProbe.Hold,
        );
        const port: Port = new Port(fixture);
        await using delivery: ExecutionDelivery<Port> = new ExecutionDelivery(port);
        const frames: ConnectorClientFrame[] = [];
        let closes: number = 0;
        const link: ExecutionDeliveryLink = {
            session: fixture.signed.session,
            leaseId: fixture.signed.lease.leaseId,
            send: (frame: ConnectorClientFrame): void => {
                frames.push(frame);
            },
            close: (): void => {
                closes++;
            },
        };
        const admission: ReturnType<typeof fixture.owner.journal.snapshot>['admission'] =
            fixture.owner.journal.snapshot().admission;
        delivery.activate(link);
        delivery.receive(
            {
                kind: ConnectorFrameKind.ExecutionInteractiveReadyStored,
                submission: { leaseId: link.leaseId, ready: admission.ready },
            },
            link,
        );
        delivery.receive(
            {
                kind: ConnectorFrameKind.ExecutionInputWork,
                original: fixture.signed.original(admission.ready),
                work: ExecutionInputWorkCapture.read(
                    JSON.parse(
                        '{"permit":' +
                            ExecutionInputPermitCodec.encode(fixture.signed.input(admission)) +
                            ',"resolution":null,"acknowledgment":null}',
                    ),
                ),
            },
            link,
        );
        await vi.waitFor((): void => {
            expect(
                frames.some(
                    (frame: ConnectorClientFrame): boolean =>
                        frame.kind === ConnectorFrameKind.ExecutionInputReceipt,
                ),
            ).toBe(true);
        });
        const frame: ConnectorClientFrame | undefined = frames.find(
            (value: ConnectorClientFrame): boolean =>
                value.kind === ConnectorFrameKind.ExecutionInputReceipt,
        );
        if (frame?.kind !== ConnectorFrameKind.ExecutionInputReceipt) {
            throw new Error('Actual durable input receipt required');
        }
        const capture: ExecutionInputReceiptCapture = frame.completion;
        const control: ReturnType<typeof fixture.owner.journal.snapshot>['pending'] =
            fixture.owner.journal.snapshot().pending;
        if (control?.kind !== ExecutionInputJournalControlKind.Permit || control.receipt === null) {
            throw new Error('Actual signed pending control required');
        }
        fixture.stop.abort();
        await fixture.task;
        const retire: MockInstance<ExecutionInteractiveOwnership['retire']> = vi.spyOn(
            fixture.owner,
            'retire',
        );
        delivery.receive(
            {
                kind: ConnectorFrameKind.ExecutionAcknowledgment,
                acknowledgment: fixture.signed.terminalAck(port.completion(link.session)),
            },
            link,
        );
        await vi.waitFor((): void => {
            expect(retire).toHaveBeenCalledTimes(1);
        });
        expect(fixture.main.pending).not.toBeNull();
        expect(
            frames.filter(
                (value: ConnectorClientFrame): boolean =>
                    value.kind === ConnectorFrameKind.ExecutionAcknowledged,
            ),
        ).toHaveLength(0);
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
            ...link,
            session: current,
            leaseId: lease.leaseId,
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
                    kind: ConnectorFrameKind.ExecutionAcknowledgment,
                    acknowledgment: fixture.signed.terminalAck(port.completion(current)),
                },
                replacement,
            );
            await vi.waitFor((): void => {
                expect(retire).toHaveBeenCalledTimes(2);
            });
            expect(fixture.main.pending).not.toBeNull();
            const { signature: _signature, ...old }: ExecutionInputAcknowledgment =
                fixture.signed.acknowledgment(control, control.receipt);
            const body: ExecutionInputAcknowledgmentBody = { ...old, leaseId: lease.leaseId };
            const acknowledgment: ExecutionInputAcknowledgment = {
                ...body,
                signature: fixture.signed.peer.authority.sign(
                    SignaturePurpose.OperationExecutionInputAcknowledgment,
                    ExecutionInteractiveProof.acknowledgment(body, control.receipt, {
                        input: control.permit.input,
                        inputHash: control.permit.inputHash,
                        prior: control.prior,
                    }),
                ),
            };
            delivery.receive(
                {
                    kind: ConnectorFrameKind.ExecutionInputWork,
                    original: fixture.signed.original(admission.ready),
                    work: ExecutionInputWorkCapture.read(
                        JSON.parse(
                            '{"permit":null,"resolution":null,"acknowledgment":' +
                                ExecutionInputAcknowledgmentCodec.encode(
                                    acknowledgment,
                                    control.receipt,
                                ) +
                                '}',
                        ),
                    ),
                },
                replacement,
            );
            await vi.waitFor((): void => {
                expect(fixture.main.pending).toBeNull();
                expect(
                    frames.filter(
                        (value: ConnectorClientFrame): boolean =>
                            value.kind === ConnectorFrameKind.ExecutionAcknowledged,
                    ),
                ).toHaveLength(1);
            });
            const terminal: ConnectorClientFrame | undefined = frames.find(
                (value: ConnectorClientFrame): boolean =>
                    value.kind === ConnectorFrameKind.ExecutionAcknowledged,
            );
            expect(
                terminal?.kind === ConnectorFrameKind.ExecutionAcknowledged
                    ? terminal.receipt.leaseId
                    : null,
            ).toBe(lease.leaseId);
            expect(fixture.owner.journal.snapshot().pending).toBeNull();
            expect(fixture.owner.journal.snapshot().terminal).not.toBeNull();
            expect(capture.receiptJson()).toBe(
                ExecutionInputReceiptCapture.create(link.leaseId, control.receipt, {
                    input: control.permit.input,
                    inputHash: control.permit.inputHash,
                    prior: control.prior,
                }).receiptJson(),
            );
            expect(closes).toBe(0);
        } finally {
            delivery.detach(replacement);
            current[Symbol.dispose]();
        }
    },
);
