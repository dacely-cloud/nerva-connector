// SPDX-FileCopyrightText: 2026 Dacely <business@dacely.com>
// SPDX-License-Identifier: LicenseRef-Proprietary

import { readFile } from 'node:fs/promises';
import { expect, it, vi, type MockInstance } from 'vitest';
import { ExecutionInputJournalFixture as Fixture } from './support/ExecutionInputJournalFixture.js';
import { ExecutionInputJournalOwner as Owner } from '../src/execution/ExecutionInputJournalOwner.js';
import type {
    ExecutionInputJournalAdmission,
    ExecutionInputJournalState,
} from '../src/execution/ExecutionInputJournalTypes.js';
import type {
    ExecutionCompletion,
    ExecutionAcknowledgment,
} from 'nerva-connector-protocol/execution/ExecutionJobs.js';
import { ExecutionLane } from 'nerva-connector-protocol/execution/ExecutionLane.js';
import { ExecutionProof } from 'nerva-connector-protocol/execution/ExecutionProof.js';
import { SignaturePurpose } from 'nerva-connector-protocol/identity/IdentityFormat.js';
import { ConnectorPrivateDirectory } from '../src/runtime/ConnectorPrivateDirectory.js';

/** Terminal signatures are genuine fixture proofs; no arbitrary application or account effect is asserted. */
function signedCompletion(
    fixture: Fixture,
    value: ExecutionCompletion,
    leaseId: string = value.leaseId,
): ExecutionCompletion {
    const { signature: _signature, ...body }: ExecutionCompletion = value;
    const changed: Omit<ExecutionCompletion, 'signature'> = { ...body, leaseId };
    return {
        ...changed,
        signature: fixture.peer.device.sign(
            SignaturePurpose.OperationExecutionResult,
            ExecutionProof.completion(changed),
        ),
    };
}

/** The same private session owner replaces its confirmed lease, so the old wrapper is genuinely stale for that object. */
function renew(fixture: Fixture): string {
    const now: bigint = fixture.peer.now + 1n;
    const challenge: ReturnType<Fixture['peer']['challenge']> = fixture.peer.challenge(
        fixture.session.begin(now),
    );
    return fixture.session.confirm(
        fixture.peer.confirmation(challenge, fixture.session.prove(challenge, now)),
        now,
    ).leaseId;
}

it('verified same-wrapper re-signing and genuine lease renewal return first terminal commitments without a write', async (): Promise<void> => {
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
    const firstCompletion: ExecutionCompletion = fixture.terminal(admission);
    const firstAck: ExecutionAcknowledgment = fixture.terminalAck(firstCompletion);
    const first: ExecutionInputJournalState = await owner.retire(
        firstCompletion,
        firstAck,
        fixture.session,
        fixture.peer.now,
    );
    const before: Buffer = await readFile(fixture.file);
    const write: MockInstance<ConnectorPrivateDirectory['write']> = vi.spyOn(
        ConnectorPrivateDirectory.prototype,
        'write',
    );
    try {
        const resigned: ExecutionCompletion = signedCompletion(fixture, firstCompletion);
        expect(resigned.signature).not.toBe(firstCompletion.signature);
        expect(
            await owner.retire(
                resigned,
                fixture.terminalAck(resigned),
                fixture.session,
                fixture.peer.now,
            ),
        ).toBe(first);
        const leaseId: string = renew(fixture);
        expect(leaseId).not.toBe(firstCompletion.leaseId);
        const renewed: ExecutionCompletion = signedCompletion(fixture, firstCompletion, leaseId);
        const renewedAck: ExecutionAcknowledgment = fixture.terminalAck(renewed);
        expect(
            await owner.retire(renewed, renewedAck, fixture.session, fixture.peer.now + 1n),
        ).toBe(first);
        expect(owner.snapshot().terminal).toEqual(first.terminal);
        expect((await readFile(fixture.file)).equals(before)).toBe(true);
        expect(write).not.toHaveBeenCalled();
        await expect(
            owner.retire(firstCompletion, firstAck, fixture.session, fixture.peer.now + 1n),
        ).rejects.toThrow('lease');
        await expect(
            owner.retire(firstCompletion, renewedAck, fixture.session, fixture.peer.now + 1n),
        ).rejects.toThrow('genuine');
        fixture.session[Symbol.dispose]();
        await expect(
            owner.retire(renewed, renewedAck, fixture.session, fixture.peer.now + 1n),
        ).rejects.toThrow('session');
        expect(write).not.toHaveBeenCalled();
    } finally {
        write.mockRestore();
    }
});

it('a reloaded terminal accepts current signed wrappers while preserving its original encrypted commitments', async (): Promise<void> => {
    await using fixture: Fixture = await Fixture.create();
    const admission: ExecutionInputJournalAdmission = fixture.admission();
    const completion: ExecutionCompletion = fixture.terminal(admission);
    let first: ExecutionInputJournalState;
    {
        await using owner: Owner = await Owner.open(
            fixture.directory,
            fixture.peer.identity,
            fixture.scope,
        );
        await fixture.initialize(
            owner,
            admission,
            fixture.permit(admission),
            fixture.session,
            fixture.peer.now,
        );
        first = await owner.retire(
            completion,
            fixture.terminalAck(completion),
            fixture.session,
            fixture.peer.now,
        );
    }
    const current: ExecutionCompletion = signedCompletion(fixture, completion, renew(fixture));
    const before: Buffer = await readFile(fixture.file);
    await using owner: Owner = await Owner.open(
        fixture.directory,
        fixture.peer.identity,
        fixture.scope,
    );
    await owner.restore(admission);
    const write: MockInstance<ConnectorPrivateDirectory['write']> = vi.spyOn(
        ConnectorPrivateDirectory.prototype,
        'write',
    );
    try {
        expect(
            (
                await owner.retire(
                    current,
                    fixture.terminalAck(current),
                    fixture.session,
                    fixture.peer.now + 1n,
                )
            ).terminal,
        ).toEqual(first.terminal);
        expect((await readFile(fixture.file)).equals(before)).toBe(true);
        expect(write).not.toHaveBeenCalled();
    } finally {
        write.mockRestore();
    }
});

it('changed outcomes, body/hash disagreement, original metadata, authority and missing proof components never replace the first terminal', async (): Promise<void> => {
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
    const original: ExecutionCompletion = fixture.terminal(admission);
    const first: ExecutionInputJournalState = await owner.retire(
        original,
        fixture.terminalAck(original),
        fixture.session,
        fixture.peer.now,
    );
    const before: Buffer = await readFile(fixture.file);
    const changedBody: ExecutionCompletion = {
        ...original,
        response: {
            ...original.response,
            stdoutBase64: Buffer.from('different').toString('base64'),
        },
    };
    const different: ExecutionCompletion = signedCompletion(fixture, {
        ...changedBody,
        responseHash: ExecutionProof.responseHash(changedBody.response),
    });
    await expect(
        owner.retire(different, fixture.terminalAck(different), fixture.session, fixture.peer.now),
    ).rejects.toThrow('outcome');
    for (const changed of [
        changedBody,
        { ...original, responseHash: 'f'.repeat(64) },
        { ...original, jobId: 'other-job' },
        { ...original, lane: ExecutionLane.Second },
        { ...original, dispatchId: 'c'.repeat(43) },
        { ...original, admissionHash: 'd'.repeat(64) },
    ]) {
        const signed: ExecutionCompletion = signedCompletion(fixture, changed);
        await expect(
            owner.retire(signed, fixture.terminalAck(signed), fixture.session, fixture.peer.now),
        ).rejects.toThrow();
    }
    const correctAck: ExecutionAcknowledgment = fixture.terminalAck(original);
    await expect(
        owner.retire(
            { ...original, signature: 'A'.repeat(3312) },
            correctAck,
            fixture.session,
            fixture.peer.now,
        ),
    ).rejects.toThrow('genuine');
    await expect(
        owner.retire(
            original,
            { ...correctAck, signature: 'A'.repeat(3312) },
            fixture.session,
            fixture.peer.now,
        ),
    ).rejects.toThrow('genuine');
    const { signature: _signature, ...ackBody }: ExecutionAcknowledgment = correctAck;
    const wrongAuthority: Omit<ExecutionAcknowledgment, 'signature'> = {
        ...ackBody,
        authorityId: 'other-authority',
    };
    await expect(
        owner.retire(
            original,
            {
                ...wrongAuthority,
                signature: fixture.peer.authority.sign(
                    SignaturePurpose.OperationExecutionAcknowledgment,
                    ExecutionProof.acknowledgment(wrongAuthority),
                ),
            },
            fixture.session,
            fixture.peer.now,
        ),
    ).rejects.toThrow('genuine');
    expect(owner.snapshot().terminal).toEqual(first.terminal);
    expect((await readFile(fixture.file)).equals(before)).toBe(true);
});

it('the first terminal commitment still requires successful durable publication', async (): Promise<void> => {
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
    const completion: ExecutionCompletion = fixture.terminal(admission);
    const before: Buffer = await readFile(fixture.file);
    const write: MockInstance<ConnectorPrivateDirectory['write']> = vi
        .spyOn(ConnectorPrivateDirectory.prototype, 'write')
        .mockRejectedValueOnce(new Error('fixture terminal publication failed'));
    try {
        await expect(
            owner.retire(
                completion,
                fixture.terminalAck(completion),
                fixture.session,
                fixture.peer.now,
            ),
        ).rejects.toThrow('publication failed');
        expect((await readFile(fixture.file)).equals(before)).toBe(true);
        await expect(
            owner.retire(
                completion,
                fixture.terminalAck(completion),
                fixture.session,
                fixture.peer.now,
            ),
        ).rejects.toThrow('unavailable');
    } finally {
        write.mockRestore();
    }
});
