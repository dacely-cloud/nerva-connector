// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

import { expect, it, vi, type MockInstance } from 'vitest';
import { ExecutionInteractiveRuntimeFixture as Fixture } from './support/ExecutionInteractiveRuntimeFixture.js';
import { ExecutionPipeProbe } from './support/ExecutionPipeFixture.js';
import type { ConnectorClientSession } from '../src/runtime/ConnectorClientSession.js';
import { SignaturePurpose } from 'nerva-connector-protocol/identity/IdentityFormat.js';
import { SigningKey } from '../src/identity/SigningKey.js';
import {
    ExecutionInputDisposition,
    type ExecutionInputPermit,
    type ExecutionInputReceipt,
} from 'nerva-connector-protocol/execution/ExecutionInput.js';
import { ExecutionInputReceiptCodec } from 'nerva-connector-protocol/execution/ExecutionInputReceiptCodec.js';
import { ExecutionInteractiveProof as Proof } from 'nerva-connector-protocol/execution/ExecutionInteractiveProof.js';
import type { ExecutionInteractiveRuntimeReply } from '../src/execution/ExecutionInteractiveRuntimeTypes.js';
import type { ExecutionNativePipeHandle } from '../src/execution/ExecutionNativePipeHandle.js';
import type { ExecutionInputJournalOwner } from '../src/execution/ExecutionInputJournalOwner.js';
import {
    ExecutionInputJournalControlKind,
    type ExecutionInputJournalControl,
    type ExecutionInputJournalRetainedControl,
} from '../src/execution/ExecutionInputJournalTypes.js';

/** A private fixture clock models time crossing during real encrypted journal publication; native host time is untouched. */
enum FreshnessLoss {
    InputExpiry = 'input-expiry',
    InputExpiryWithCallerMutation = 'input-expiry-with-caller-mutation',
    OriginalExpiry = 'original-expiry',
    SessionDisposal = 'session-disposal',
}

const helper: string | undefined = process.env['NERVA_CONNECTOR_EXEC_HELPER'];

for (const loss of Object.values(FreshnessLoss)) {
    it.skipIf(helper === undefined)(
        `durable input staging followed by ${loss} produces retained uncertainty without native I/O`,
        async (): Promise<void> => {
            if (helper === undefined) {
                throw new Error('An explicit native qualification helper is required');
            }
            await using fixture: Fixture = await Fixture.create(
                helper,
                ExecutionPipeProbe.Echo,
                'a\0b',
                5000,
            );
            const permit: ExecutionInputPermit = { ...fixture.data() };
            const entered: PromiseWithResolvers<undefined> = Promise.withResolvers<undefined>();
            const release: PromiseWithResolvers<undefined> = Promise.withResolvers<undefined>();
            const stage: ExecutionInputJournalOwner['stage'] = fixture.journal.stage.bind(
                fixture.journal,
            );
            const held: MockInstance<ExecutionInputJournalOwner['stage']> = vi
                .spyOn(fixture.journal, 'stage')
                .mockImplementation(
                    async (
                        value: ExecutionInputPermit,
                        session: ConnectorClientSession,
                        nowMs: bigint,
                    ): Promise<ExecutionInputJournalControl> => {
                        const result: ExecutionInputJournalControl = await stage(
                            value,
                            session,
                            nowMs,
                        );
                        entered.resolve(undefined);
                        await release.promise;
                        return result;
                    },
                );
            const send: MockInstance<ExecutionNativePipeHandle['send']> = vi.spyOn(
                fixture.invocation.pipe,
                'send',
            );
            const work: Promise<ExecutionInteractiveRuntimeReply> = fixture.runtime.process(
                { acknowledgment: null, permit },
                fixture.signed.session,
            );
            void Promise.allSettled([work]);
            try {
                await entered.promise;
                expect(send).not.toHaveBeenCalled();
                if (loss === FreshnessLoss.SessionDisposal) {
                    fixture.signed.session[Symbol.dispose]();
                } else {
                    fixture.clock.advanceTo(
                        loss === FreshnessLoss.OriginalExpiry
                            ? permit.executionDeadlineMs
                            : permit.expiresAtMs,
                    );
                    if (loss === FreshnessLoss.InputExpiryWithCallerMutation) {
                        expect(Reflect.set(permit, 'expiresAtMs', permit.executionDeadlineMs)).toBe(
                            true,
                        );
                    }
                }
                release.resolve(undefined);
                const reply: ExecutionInteractiveRuntimeReply = await work;
                const receipt: ExecutionInputReceipt | null = reply.receipt;
                if (receipt === null) {
                    throw new Error('The exact staged input requires durable uncertainty');
                }
                const retained: ExecutionInputJournalRetainedControl | null =
                    fixture.journal.snapshot().pending;
                if (
                    retained === null ||
                    retained.kind !== ExecutionInputJournalControlKind.Permit
                ) {
                    throw new Error('The first exact control must remain retained');
                }
                const context: Parameters<typeof ExecutionInputReceiptCodec.unsigned>[1] = {
                    input: retained.permit.input,
                    inputHash: retained.permit.inputHash,
                    prior: retained.prior,
                };
                expect(receipt.disposition).toBe(ExecutionInputDisposition.Indeterminate);
                expect(receipt.cursor).toEqual({ ...retained.prior, blocked: true });
                expect(retained.receipt).toEqual(receipt);
                expect(
                    SigningKey.verify(
                        SignaturePurpose.OperationExecutionInputReceipt,
                        fixture.signed.peer.device.publicKey,
                        Proof.receipt(
                            ExecutionInputReceiptCodec.unsigned(receipt, context),
                            context,
                        ),
                        receipt.signature,
                    ),
                ).toBe(true);
                expect(send).not.toHaveBeenCalled();
                expect(fixture.invocation.pipe.cursor()).toMatchObject({
                    initialAccepted: false,
                    acceptedOffset: 0n,
                    ended: false,
                });
            } finally {
                release.resolve(undefined);
                await Promise.allSettled([work]);
                held.mockRestore();
                send.mockRestore();
            }
        },
    );
}
