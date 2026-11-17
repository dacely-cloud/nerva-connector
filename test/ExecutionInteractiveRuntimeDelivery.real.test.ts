// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

import { setTimeout as delay } from 'node:timers/promises';
import { expect, it, vi, type MockInstance } from 'vitest';
import { SignaturePurpose } from 'nerva-connector-protocol/identity/IdentityFormat.js';
import { ExecutionInteractiveProof as Proof } from 'nerva-connector-protocol/execution/ExecutionInteractiveProof.js';
import {
    ExecutionInputDisposition,
    type ExecutionInputPermit,
    type ExecutionInputPermitBody,
} from 'nerva-connector-protocol/execution/ExecutionInput.js';
import { ExecutionInputJournalControlKind } from '../src/execution/ExecutionInputJournalTypes.js';
import { ExecutionInputPermitCodec } from 'nerva-connector-protocol/execution/ExecutionInputPermitCodec.js';
import type { ExecutionNativePipeHandle } from '../src/execution/ExecutionNativePipeHandle.js';
import { ExecutionInteractiveRuntimeFixture as Fixture } from './support/ExecutionInteractiveRuntimeFixture.js';

const helper: string | undefined = process.env['NERVA_CONNECTOR_EXEC_HELPER'];

it.skipIf(helper === undefined)(
    'the actual native frame uses the current signed delivery cutoff while retaining the immutable first journal permit and its exact input',
    async (): Promise<void> => {
        if (helper === undefined) {
            throw new Error('Explicit unused native candidate required');
        }
        await using fixture: Fixture = await Fixture.create(helper);
        const base: ExecutionInputPermit = fixture.data();
        const firstBody: ExecutionInputPermitBody = {
            ...ExecutionInputPermitCodec.unsigned(base),
            expiresAtMs: fixture.clock.now() + 200n,
        };
        const first: ExecutionInputPermit = {
            ...firstBody,
            signature: fixture.signed.peer.authority.sign(
                SignaturePurpose.OperationExecutionInputPermit,
                Proof.permit(firstBody, fixture.runtime.admission.ready),
            ),
        };
        await fixture.journal.stage(first, fixture.signed.session, fixture.clock.now());
        await delay(220);
        const renewedBody: ExecutionInputPermitBody = {
            ...ExecutionInputPermitCodec.unsigned(first),
            issuedAtMs: fixture.clock.now(),
            expiresAtMs: fixture.clock.now() + 1000n,
        };
        const renewed: ExecutionInputPermit = {
            ...renewedBody,
            signature: fixture.signed.peer.authority.sign(
                SignaturePurpose.OperationExecutionInputPermit,
                Proof.permit(renewedBody, fixture.runtime.admission.ready),
            ),
        };
        const send: MockInstance<ExecutionNativePipeHandle['send']> = vi.spyOn(
            fixture.invocation.pipe,
            'send',
        );
        try {
            const result: Awaited<ReturnType<typeof fixture.runtime.process>> =
                await fixture.runtime.process(
                    { acknowledgment: null, permit: renewed },
                    fixture.signed.session,
                );
            expect(result.receipt?.disposition).toBe(ExecutionInputDisposition.Applied);
            expect(send).toHaveBeenCalledTimes(1);
            expect(send.mock.calls[0]?.[0].deliveryExpiresAtMs).toBe(renewed.expiresAtMs);
            expect(send.mock.calls[0]?.[0].deliveryExpiresAtMs).not.toBe(first.expiresAtMs);
            const state: ReturnType<typeof fixture.journal.snapshot> = fixture.journal.snapshot();
            expect(state.pending?.kind).toBe(ExecutionInputJournalControlKind.Permit);
            if (state.pending?.kind !== ExecutionInputJournalControlKind.Permit) {
                throw new Error('Exact first permit capture required');
            }
            expect(state.pending.permit.expiresAtMs).toBe(first.expiresAtMs);
            expect(state.pending.permit.inputHash).toBe(renewed.inputHash);
            expect(state.pending.receipt).toEqual(result.receipt);
        } finally {
            send.mockRestore();
        }
    },
);
