// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

import { readFile } from 'node:fs/promises';
import { expect, it, vi, type MockInstance } from 'vitest';
import { ExecutionInteractiveRuntimeFixture as Fixture } from './support/ExecutionInteractiveRuntimeFixture.js';
import { ExecutionPipeProbe } from './support/ExecutionPipeFixture.js';
import { ConnectorSessionFixture } from './support/ConnectorSessionFixture.js';
import { ConnectorClientSession } from '../src/runtime/ConnectorClientSession.js';
import type {
    ExecutionInputReceipt,
    ExecutionInputAcknowledgment,
    ExecutionInputAcknowledgmentBody,
} from 'nerva-connector-protocol/execution/ExecutionInput.js';
import { ExecutionInputDisposition } from 'nerva-connector-protocol/execution/ExecutionInput.js';
import {
    ExecutionInputJournalControlKind,
    type ExecutionInputJournalRetainedControl,
} from '../src/execution/ExecutionInputJournalTypes.js';
import { ExecutionInputJournalOwner } from '../src/execution/ExecutionInputJournalOwner.js';
import { ExecutionInputAcknowledgmentCodec } from 'nerva-connector-protocol/execution/ExecutionInputAcknowledgmentCodec.js';
import { ExecutionInteractiveProof as Proof } from 'nerva-connector-protocol/execution/ExecutionInteractiveProof.js';
import { SignaturePurpose } from 'nerva-connector-protocol/identity/IdentityFormat.js';
import type { SigningKey } from '../src/identity/SigningKey.js';
import type { ExecutionNativePipeHandle } from '../src/execution/ExecutionNativePipeHandle.js';

const helper: string | undefined = process.env['NERVA_CONNECTOR_EXEC_HELPER'];
function candidate(): string {
    if (helper === undefined) {
        throw new Error('Explicit native candidate required');
    }
    return helper;
}

/** The test connection manager retires the old session; the new lease is established by the actual mutual handshake. */
function confirmed(peer: ConnectorSessionFixture, now: bigint): ConnectorClientSession {
    const session: ConnectorClientSession = new ConnectorClientSession(peer.identity);
    try {
        const challenge: ReturnType<ConnectorSessionFixture['challenge']> = peer.challenge(
            session.begin(now),
        );
        session.confirm(peer.confirmation(challenge, session.prove(challenge, now)), now);
        return session;
    } catch (caught: unknown) {
        session[Symbol.dispose]();
        throw caught;
    }
}

it.skipIf(helper === undefined)(
    'an empty authenticated poll drains the exact lost Applied proof after deadline without refreshing native authority or re-signing',
    async (): Promise<void> => {
        await using fixture: Fixture = await Fixture.create(
            candidate(),
            ExecutionPipeProbe.Hold,
            'a\0b',
        );
        const native: MockInstance<ExecutionNativePipeHandle['send']> = vi.spyOn(
            fixture.invocation.pipe,
            'send',
        );
        try {
            const first: ExecutionInputReceipt | null = (
                await fixture.runtime.process(
                    { acknowledgment: null, permit: fixture.data() },
                    fixture.signed.session,
                )
            ).receipt;
            const control: ExecutionInputJournalRetainedControl | null =
                fixture.journal.snapshot().pending;
            if (
                first === null ||
                control === null ||
                control.kind !== ExecutionInputJournalControlKind.Permit
            ) {
                throw new Error('Actual durable input receipt required');
            }
            expect(first.disposition).toBe(ExecutionInputDisposition.Applied);
            expect(fixture.invocation.pipe.cursor().acceptedOffset).toBe(3n);
            fixture.clock.advanceTo(fixture.runtime.admission.launch.executionDeadlineMs + 1n);
            fixture.signed.session[Symbol.dispose]();
            using current: ConnectorClientSession = confirmed(
                fixture.signed.peer,
                fixture.clock.now(),
            );
            using unconfirmed: ConnectorClientSession = new ConnectorClientSession(
                fixture.signed.peer.identity,
            );
            using foreign: ConnectorSessionFixture = new ConnectorSessionFixture();
            using foreignSession: ConnectorClientSession = confirmed(foreign, fixture.clock.now());
            const sign: MockInstance<SigningKey['sign']> = vi.spyOn(
                fixture.signed.peer.device,
                'sign',
            );
            try {
                const before: Buffer = await readFile(fixture.signed.file);
                expect(
                    (await fixture.runtime.process({ acknowledgment: null, permit: null }, current))
                        .receipt,
                ).toEqual(first);
                expect(
                    (await fixture.runtime.process({ acknowledgment: null, permit: null }, current))
                        .receipt,
                ).toEqual(first);
                expect((await readFile(fixture.signed.file)).equals(before)).toBe(true);
                expect(native).toHaveBeenCalledTimes(1);
                expect(sign).not.toHaveBeenCalled();
                await expect(
                    fixture.runtime.process(
                        { acknowledgment: null, permit: null },
                        fixture.signed.session,
                    ),
                ).rejects.toThrow('session');
                await expect(
                    fixture.runtime.process({ acknowledgment: null, permit: null }, unconfirmed),
                ).rejects.toThrow('session');
                await expect(
                    fixture.runtime.process({ acknowledgment: null, permit: null }, foreignSession),
                ).rejects.toThrow('owner');
                const body: ExecutionInputAcknowledgmentBody = {
                    ...ExecutionInputAcknowledgmentCodec.unsigned(
                        fixture.signed.acknowledgment(control, first),
                        first,
                    ),
                    leaseId: ConnectorClientSession.current(current, fixture.clock.now()).leaseId,
                    writerGeneration: 2n,
                };
                const acknowledgment: ExecutionInputAcknowledgment = {
                    ...body,
                    signature: fixture.signed.peer.authority.sign(
                        SignaturePurpose.OperationExecutionInputAcknowledgment,
                        Proof.acknowledgment(body, first, {
                            input: control.permit.input,
                            inputHash: control.permit.inputHash,
                            prior: control.prior,
                        }),
                    ),
                };
                expect(
                    (await fixture.runtime.process({ acknowledgment, permit: null }, current))
                        .receipt,
                ).toBe(null);
                expect(
                    (await fixture.runtime.process({ acknowledgment: null, permit: null }, current))
                        .receipt,
                ).toBe(null);
                expect(native).toHaveBeenCalledTimes(1);
                expect(sign).not.toHaveBeenCalled();
                fixture.clock.advanceTo(
                    ConnectorClientSession.current(current, fixture.clock.now()).expiresAtMs,
                );
                await expect(
                    fixture.runtime.process({ acknowledgment: null, permit: null }, current),
                ).rejects.toThrow('session');
            } finally {
                sign.mockRestore();
            }
        } finally {
            native.mockRestore();
        }
    },
);

it.skipIf(helper === undefined)(
    'a restored Indeterminate pending outbox remains readable after deadline under a new live session without native replay',
    async (): Promise<void> => {
        await using fixture: Fixture = await Fixture.create(
            candidate(),
            ExecutionPipeProbe.Hold,
            'uncertain',
        );
        const native: MockInstance<ExecutionNativePipeHandle['send']> = vi.spyOn(
            fixture.invocation.pipe,
            'send',
        );
        try {
            await fixture.journal.stage(
                fixture.data(),
                fixture.signed.session,
                fixture.clock.now(),
            );
            fixture.stop.abort();
            await fixture.invocation.joined;
            await fixture.journal[Symbol.asyncDispose]();
            await using restored: ExecutionInputJournalOwner =
                await ExecutionInputJournalOwner.open(
                    fixture.signed.directory,
                    fixture.signed.peer.identity,
                    fixture.signed.scope,
                );
            const recovered: Awaited<ReturnType<ExecutionInputJournalOwner['restore']>> =
                await restored.restore(fixture.runtime.admission);
            const first: ExecutionInputReceipt | null = recovered.pending?.receipt ?? null;
            if (first === null) {
                throw new Error('Recovered exact uncertain input receipt required');
            }
            expect(first).toMatchObject({
                disposition: ExecutionInputDisposition.Indeterminate,
                cursor: {
                    processedSequence: null,
                    initialAccepted: false,
                    acceptedOffset: 0n,
                    blocked: true,
                },
            });
            fixture.clock.advanceTo(fixture.runtime.admission.launch.executionDeadlineMs + 1n);
            fixture.signed.session[Symbol.dispose]();
            using current: ConnectorClientSession = confirmed(
                fixture.signed.peer,
                fixture.clock.now(),
            );
            const sign: MockInstance<SigningKey['sign']> = vi.spyOn(
                fixture.signed.peer.device,
                'sign',
            );
            try {
                const before: Buffer = await readFile(fixture.signed.file);
                expect(restored.pendingReceipt(current, fixture.clock.now())).toEqual(first);
                expect(restored.pendingReceipt(current, fixture.clock.now())).toEqual(first);
                expect((await readFile(fixture.signed.file)).equals(before)).toBe(true);
                expect((): ExecutionInputReceipt | null =>
                    restored.pendingReceipt(fixture.signed.session, fixture.clock.now()),
                ).toThrow('session');
                expect(sign).not.toHaveBeenCalled();
                expect(native).not.toHaveBeenCalled();
            } finally {
                sign.mockRestore();
            }
        } finally {
            native.mockRestore();
        }
    },
);
