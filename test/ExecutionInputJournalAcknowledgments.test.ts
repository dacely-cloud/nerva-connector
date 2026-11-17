// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

import { readFile } from 'node:fs/promises';
import { expect, it } from 'vitest';
import { ExecutionInputJournalFixture as Fixture } from './support/ExecutionInputJournalFixture.js';
import { ExecutionInputJournalOwner as Owner } from '../src/execution/ExecutionInputJournalOwner.js';
import type {
    ExecutionInputJournalAdmission,
    ExecutionInputJournalControl,
} from '../src/execution/ExecutionInputJournalTypes.js';
import type {
    ExecutionInputAcknowledgment,
    ExecutionInputAcknowledgmentBody,
    ExecutionInputReceipt,
    ExecutionInputPermit,
    ExecutionInputPermitBody,
} from 'nerva-connector-protocol/execution/ExecutionInput.js';
import { ExecutionInputAcknowledgmentCodec } from 'nerva-connector-protocol/execution/ExecutionInputAcknowledgmentCodec.js';
import { ExecutionInputPermitCodec } from 'nerva-connector-protocol/execution/ExecutionInputPermitCodec.js';
import { ExecutionInteractiveProof as Proof } from 'nerva-connector-protocol/execution/ExecutionInteractiveProof.js';
import { ConnectorClientSession } from '../src/runtime/ConnectorClientSession.js';
import { SignaturePurpose } from 'nerva-connector-protocol/identity/IdentityFormat.js';
import { ExecutionLane } from 'nerva-connector-protocol/execution/ExecutionLane.js';

/** A second genuine mutual handshake establishes a replacement current lease without changing the enrolled identity. */
function confirmed(fixture: Fixture): ConnectorClientSession {
    const session: ConnectorClientSession = new ConnectorClientSession(fixture.peer.identity);
    try {
        const challenge: ReturnType<Fixture['peer']['challenge']> = fixture.peer.challenge(
            session.begin(fixture.peer.now),
        );
        session.confirm(
            fixture.peer.confirmation(challenge, session.prove(challenge, fixture.peer.now)),
            fixture.peer.now,
        );
        return session;
    } catch (caught: unknown) {
        session[Symbol.dispose]();
        throw caught;
    }
}

/** Renewal changes only delivery authority around the same full first receipt commitment. */
function renewed(
    fixture: Fixture,
    control: ExecutionInputJournalControl,
    receipt: ExecutionInputReceipt,
    session: ConnectorClientSession,
    generation: bigint,
): ExecutionInputAcknowledgment {
    const original: ExecutionInputAcknowledgment = fixture.acknowledgment(control, receipt);
    const body: ExecutionInputAcknowledgmentBody = {
        ...ExecutionInputAcknowledgmentCodec.unsigned(original, receipt),
        leaseId: ConnectorClientSession.current(session, fixture.peer.now).leaseId,
        writerGeneration: generation,
    };
    return {
        ...body,
        signature: fixture.peer.authority.sign(
            SignaturePurpose.OperationExecutionInputAcknowledgment,
            Proof.acknowledgment(body, receipt, {
                input: control.permit.input,
                inputHash: control.permit.inputHash,
                prior: control.prior,
            }),
        ),
    };
}

it('duplicate previous ACK targets last while next input is pending, both before and after the next signed outcome', async (): Promise<void> => {
    await using fixture: Fixture = await Fixture.create();
    await using owner: Owner = await Owner.open(
        fixture.directory,
        fixture.peer.identity,
        fixture.scope,
    );
    const admission: ExecutionInputJournalAdmission = fixture.admission();
    await fixture.initialize(
        owner,
        admission,
        fixture.permit(admission),
        fixture.session,
        fixture.peer.now,
    );
    const zero: ExecutionInputJournalControl = await owner.stage(
        fixture.input(admission),
        fixture.session,
        fixture.peer.now,
    );
    const zeroReceipt: ExecutionInputReceipt = fixture.receipt(zero);
    await owner.record(zeroReceipt);
    const zeroAck: ExecutionInputAcknowledgment = fixture.acknowledgment(zero, zeroReceipt);
    await owner.acknowledge(zeroAck, fixture.session, fixture.peer.now);
    const one: ExecutionInputJournalControl = await owner.stage(
        fixture.input(admission, Buffer.from('next'), 1n, owner.snapshot().cursor),
        fixture.session,
        fixture.peer.now,
    );
    const beforeReceipt: Buffer = await readFile(fixture.file);
    expect(await owner.acknowledge(zeroAck, fixture.session, fixture.peer.now)).toEqual(zeroAck);
    expect(owner.snapshot().pending).toEqual(one);
    expect((await readFile(fixture.file)).equals(beforeReceipt)).toBe(true);
    for (const changed of [
        { ...zeroAck, jobId: 'other-job' },
        { ...zeroAck, lane: ExecutionLane.Second },
        { ...zeroAck, readySha256: 'a'.repeat(64) },
        { ...zeroAck, admissionHash: 'b'.repeat(64) },
        { ...zeroAck, inputHash: 'c'.repeat(64) },
    ]) {
        await expect(owner.acknowledge(changed, fixture.session, fixture.peer.now)).rejects.toThrow(
            'Exact first',
        );
    }
    expect((await readFile(fixture.file)).equals(beforeReceipt)).toBe(true);
    const oneReceipt: ExecutionInputReceipt = fixture.receipt(one);
    await owner.record(oneReceipt);
    const afterReceipt: Buffer = await readFile(fixture.file);
    expect(await owner.acknowledge(zeroAck, fixture.session, fixture.peer.now)).toEqual(zeroAck);
    expect(owner.snapshot().pending?.receipt).toEqual(oneReceipt);
    expect((await readFile(fixture.file)).equals(afterReceipt)).toBe(true);
    await owner.acknowledge(
        fixture.acknowledgment(one, oneReceipt),
        fixture.session,
        fixture.peer.now,
    );
    expect(owner.snapshot()).toMatchObject({
        pending: null,
        last: { permit: { input: { inputSequence: 1n } } },
    });
});

it('current lease and writer renewal wraps the same receipt without clearing a newer pending original or replacing first proof within a wrapper', async (): Promise<void> => {
    await using fixture: Fixture = await Fixture.create();
    await using owner: Owner = await Owner.open(
        fixture.directory,
        fixture.peer.identity,
        fixture.scope,
    );
    const admission: ExecutionInputJournalAdmission = fixture.admission();
    await fixture.initialize(
        owner,
        admission,
        fixture.permit(admission),
        fixture.session,
        fixture.peer.now,
    );
    const zero: ExecutionInputJournalControl = await owner.stage(
        fixture.input(admission),
        fixture.session,
        fixture.peer.now,
    );
    const receipt: ExecutionInputReceipt = fixture.receipt(zero);
    await owner.record(receipt);
    const original: ExecutionInputAcknowledgment = fixture.acknowledgment(zero, receipt);
    await owner.acknowledge(original, fixture.session, fixture.peer.now);
    const one: ExecutionInputJournalControl = await owner.stage(
        fixture.input(admission, Buffer.from('next'), 1n, owner.snapshot().cursor),
        fixture.session,
        fixture.peer.now,
    );
    using session: ConnectorClientSession = confirmed(fixture);
    const renewal: ExecutionInputAcknowledgment = renewed(fixture, zero, receipt, session, 2n);
    expect(renewal.leaseId).not.toBe(original.leaseId);
    expect(renewal.receiptSha256).toBe(original.receiptSha256);
    await owner.acknowledge(renewal, session, fixture.peer.now);
    expect(owner.snapshot()).toMatchObject({
        writerGeneration: 2n,
        pending: one,
        last: { acknowledgment: renewal, receipt },
    });
    const before: Buffer = await readFile(fixture.file);
    const resigned: ExecutionInputAcknowledgment = renewed(fixture, zero, receipt, session, 2n);
    expect(resigned.signature).not.toBe(renewal.signature);
    expect(await owner.acknowledge(resigned, session, fixture.peer.now)).toEqual(renewal);
    expect((await readFile(fixture.file)).equals(before)).toBe(true);
    await expect(owner.acknowledge(original, session, fixture.peer.now)).rejects.toThrow('lease');
    await expect(
        owner.acknowledge(renewed(fixture, zero, receipt, session, 1n), session, fixture.peer.now),
    ).rejects.toThrow('Stale');
    await expect(
        owner.acknowledge({ ...renewal, receiptSha256: 'f'.repeat(64) }, session, fixture.peer.now),
    ).rejects.toThrow();
    expect(owner.snapshot().pending).toEqual(one);
    const body: ExecutionInputPermitBody = {
        ...ExecutionInputPermitCodec.unsigned(one.permit),
        leaseId: renewal.leaseId,
        writerGeneration: 2n,
    };
    const inputRenewal: ExecutionInputPermit = {
        ...body,
        signature: fixture.peer.authority.sign(
            SignaturePurpose.OperationExecutionInputPermit,
            Proof.permit(body, admission.ready),
        ),
    };
    expect((await owner.stage(inputRenewal, session, fixture.peer.now)).permit).toEqual(one.permit);
    const oneReceipt: ExecutionInputReceipt = fixture.receipt(one);
    await owner.record(oneReceipt);
    const renewedAgain: ExecutionInputAcknowledgment = renewed(fixture, zero, receipt, session, 3n);
    await owner.acknowledge(renewedAgain, session, fixture.peer.now);
    expect(owner.snapshot().pending?.receipt).toEqual(oneReceipt);
    await owner.acknowledge(
        renewed(fixture, one, oneReceipt, session, 3n),
        session,
        fixture.peer.now,
    );
    expect(owner.snapshot()).toMatchObject({
        pending: null,
        writerGeneration: 3n,
        last: {
            receipt: oneReceipt,
            acknowledgment: { writerGeneration: 3n, leaseId: renewal.leaseId },
        },
    });
});
