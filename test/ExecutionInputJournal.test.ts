// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

import {
    ExecutionInputJournalControlKind,
    type ExecutionInputJournalRetainedControl,
} from '../src/execution/ExecutionInputJournalTypes.js';
import { readFile, writeFile, rm, readdir, stat } from 'node:fs/promises';
import { expect, it, vi, type MockInstance } from 'vitest';
import { ExecutionInputJournalOwner as Owner } from '../src/execution/ExecutionInputJournalOwner.js';
import { ExecutionInputJournalFixture as Fixture } from './support/ExecutionInputJournalFixture.js';
import {
    ExecutionInputJournalLimits as Limits,
    type ExecutionInputJournalAdmission,
    type ExecutionInputJournalControl,
    type ExecutionInputJournalState,
} from '../src/execution/ExecutionInputJournalTypes.js';
import {
    ConnectorPrivateDirectory,
    ConnectorDirectoryPurpose,
} from '../src/runtime/ConnectorPrivateDirectory.js';
import { ExecutionLane } from 'nerva-connector-protocol/execution/ExecutionLane.js';
import type { ExecutionCompletion } from '../src/execution/ExecutionJobs.js';
import {
    ExecutionInputDisposition,
    type ExecutionInputPermit,
    type ExecutionInputReceipt,
    type ExecutionInputAcknowledgment,
} from 'nerva-connector-protocol/execution/ExecutionInput.js';
import type { ExecutionInteractiveInvocationRule } from 'nerva-connector-protocol/execution/ExecutionInteractiveInvocation.js';
import { ExecutionInteractiveProof as Proof } from 'nerva-connector-protocol/execution/ExecutionInteractiveProof.js';
import { SignaturePurpose } from 'nerva-connector-protocol/identity/IdentityFormat.js';
import { ConnectorClientSession } from '../src/runtime/ConnectorClientSession.js';

it('owns one encrypted fixed lane cursor independently of the existing execution journal lock', async (): Promise<void> => {
    await using fixture: Fixture = await Fixture.create();
    await using original: ConnectorPrivateDirectory = await ConnectorPrivateDirectory.open(
        fixture.directory,
        ConnectorDirectoryPurpose.Execution,
    );
    expect(original.directory).toBe(fixture.directory);
    await using owner: Owner = await Owner.open(
        fixture.directory,
        fixture.peer.identity,
        fixture.scope,
    );
    await expect(
        Owner.open(fixture.directory, fixture.peer.identity, fixture.scope),
    ).rejects.toThrow();
    const admission: ExecutionInputJournalAdmission = fixture.admission(1n, 'private\0initial');
    await fixture.initialize(
        owner,
        admission,
        fixture.permit(admission),
        fixture.session,
        fixture.peer.now,
    );
    const bytes: Buffer = await readFile(fixture.file);
    expect(bytes.byteLength).toBeLessThanOrEqual(Limits.recordBytes);
    expect(bytes.includes(Buffer.from('private'))).toBe(false);
    expect(bytes.includes(Buffer.from(admission.ready.incarnation))).toBe(false);
    expect((await stat(fixture.file)).mode & 0o777).toBe(0o600);
    expect(await readdir(fixture.directory)).toEqual(['execution-input']);
    expect(owner.snapshot().cursor).toMatchObject({
        processedSequence: null,
        initialAccepted: false,
        acceptedOffset: 0n,
    });
});

it('publishes the immutable pending original before native permission and keeps first complete signed proofs across exact retries', async (): Promise<void> => {
    await using fixture: Fixture = await Fixture.create();
    await using owner: Owner = await Owner.open(
        fixture.directory,
        fixture.peer.identity,
        fixture.scope,
    );
    const admission: ExecutionInputJournalAdmission = fixture.admission(1n, 'a\0b');
    await fixture.initialize(
        owner,
        admission,
        fixture.permit(admission),
        fixture.session,
        fixture.peer.now,
    );
    const permit: ExecutionInputPermit = fixture.input(admission);
    const staged: ExecutionInputJournalControl = await owner.stage(
        permit,
        fixture.session,
        fixture.peer.now,
    );
    expect(staged.receipt).toBe(null);
    const source: Buffer = await readFile(fixture.file);
    expect(await owner.stage(permit, fixture.session, fixture.peer.now)).toEqual(staged);
    expect(
        (await owner.stage(fixture.input(admission), fixture.session, fixture.peer.now)).permit
            .signature,
    ).toBe(staged.permit.signature);
    expect((await readFile(fixture.file)).equals(source)).toBe(true);
    const receipt: ExecutionInputReceipt = fixture.receipt(staged);
    await owner.record(receipt);
    expect(owner.snapshot().pending?.receipt).toEqual(receipt);
    await expect(owner.record(fixture.receipt(staged))).rejects.toThrow('cannot be replaced');
    const changed: ExecutionInputPermit = fixture.input(
        admission,
        Buffer.from('different'),
        1n,
        owner.snapshot().cursor,
    );
    await expect(owner.stage(changed, fixture.session, fixture.peer.now)).rejects.toThrow();
    const acknowledgment: ExecutionInputAcknowledgment = fixture.acknowledgment(staged, receipt);
    await owner.acknowledge(acknowledgment, fixture.session, fixture.peer.now);
    expect(owner.snapshot()).toMatchObject({
        pending: null,
        cursor: { acceptedOffset: 3n, processedSequence: 0n, initialAccepted: true },
    });
    expect(await owner.acknowledge(acknowledgment, fixture.session, fixture.peer.now)).toEqual(
        acknowledgment,
    );
    expect(
        await owner.acknowledge(
            fixture.acknowledgment(staged, receipt),
            fixture.session,
            fixture.peer.now,
        ),
    ).toEqual(acknowledgment);
    const next: ExecutionInputPermit = fixture.input(
        admission,
        Buffer.from([0, 255]),
        1n,
        owner.snapshot().cursor,
    );
    await owner.stage(next, fixture.session, fixture.peer.now);
    await expect(
        owner.stage(
            fixture.input(
                admission,
                Buffer.from('changed'),
                1n,
                owner.snapshot().last?.receipt?.cursor,
            ),
            fixture.session,
            fixture.peer.now,
        ),
    ).rejects.toThrow();
});

it('process replacement preserves the prior confirmed lower bound and signs blocked Indeterminate without replaying pending bytes', async (): Promise<void> => {
    await using fixture: Fixture = await Fixture.create();
    const admission: ExecutionInputJournalAdmission = fixture.admission(1n, 'initial');
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
        const initial: ExecutionInputJournalControl = await owner.stage(
            fixture.input(admission),
            fixture.session,
            fixture.peer.now,
        );
        const receipt: ExecutionInputReceipt = fixture.receipt(initial);
        await owner.record(receipt);
        await owner.acknowledge(
            fixture.acknowledgment(initial, receipt),
            fixture.session,
            fixture.peer.now,
        );
        await owner.stage(
            fixture.input(admission, Buffer.from('uncertain'), 1n, owner.snapshot().cursor),
            fixture.session,
            fixture.peer.now,
        );
    }
    let firstReceipt: string;
    {
        await using owner: Owner = await Owner.open(
            fixture.directory,
            fixture.peer.identity,
            fixture.scope,
        );
        const restored: ExecutionInputJournalState = await owner.restore(admission);
        expect(restored).toMatchObject({
            ownerLost: true,
            cursor: { acceptedOffset: 7n, processedSequence: 0n, blocked: true },
            pending: { receipt: { disposition: ExecutionInputDisposition.Indeterminate } },
        });
        const pending: ExecutionInputJournalRetainedControl | null = restored.pending;
        if (
            pending === null ||
            pending.kind !== ExecutionInputJournalControlKind.Permit ||
            pending.receipt === null
        ) {
            throw new Error('Exact uncertain original was not retained');
        }
        firstReceipt = pending.receipt.signature;
        expect(
            (await owner.stage(pending.permit, fixture.session, fixture.peer.now)).receipt,
        ).toEqual(pending.receipt);
        await expect(owner.record(fixture.receipt(pending))).rejects.toThrow('cannot be replaced');
    }
    await using again: Owner = await Owner.open(
        fixture.directory,
        fixture.peer.identity,
        fixture.scope,
    );
    expect((await again.restore(admission)).pending?.receipt?.signature).toBe(firstReceipt);
});

it('never recreates absent, corrupt, moved, differently bound or mismatched used state', async (): Promise<void> => {
    await using fixture: Fixture = await Fixture.create();
    const admission: ExecutionInputJournalAdmission = fixture.admission();
    {
        await using missing: Owner = await Owner.open(
            fixture.directory,
            fixture.peer.identity,
            fixture.scope,
        );
        await expect(missing.restore(admission)).rejects.toMatchObject({ code: 'ENOENT' });
    }
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
    }
    const original: Buffer = await readFile(fixture.file);
    for (const scope of [
        { ...fixture.scope, lane: ExecutionLane.Second },
        { ...fixture.scope, journalId: 'c'.repeat(64) },
    ]) {
        await using changed: Owner = await Owner.open(
            fixture.directory,
            fixture.peer.identity,
            scope,
        );
        await expect(changed.restore(admission)).rejects.toThrow();
    }
    {
        await using changed: Owner = await Owner.open(
            fixture.directory,
            fixture.peer.identity,
            fixture.scope,
        );
        await expect(
            changed.restore({ ...admission, policySha256: 'd'.repeat(64) }),
        ).rejects.toThrow('changed');
        await expect(
            changed.restore({ ...admission, rule: { ...admission.rule, maximumControls: 255 } }),
        ).rejects.toThrow('changed');
    }
    original[100] = original[100] === 65 ? 66 : 65;
    await writeFile(fixture.file, original);
    {
        await using corrupt: Owner = await Owner.open(
            fixture.directory,
            fixture.peer.identity,
            fixture.scope,
        );
        await expect(corrupt.restore(admission)).rejects.toThrow();
        await expect(
            fixture.initialize(
                corrupt,
                admission,
                fixture.permit(admission),
                fixture.session,
                fixture.peer.now,
            ),
        ).rejects.toThrow();
    }
    await rm(fixture.file);
    await using removed: Owner = await Owner.open(
        fixture.directory,
        fixture.peer.identity,
        fixture.scope,
    );
    await expect(removed.restore(admission)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readdir(fixture.directory)).toEqual([]);
});

it('storage publication failure never returns native permission and poisons the live owner', async (): Promise<void> => {
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
    const before: Buffer = await readFile(fixture.file);
    const write: MockInstance<ConnectorPrivateDirectory['write']> = vi
        .spyOn(ConnectorPrivateDirectory.prototype, 'write')
        .mockRejectedValueOnce(new Error('owned fixture publication failed'));
    try {
        await expect(
            owner.stage(fixture.input(admission), fixture.session, fixture.peer.now),
        ).rejects.toThrow('publication failed');
        expect((await readFile(fixture.file)).equals(before)).toBe(true);
        await expect(
            owner.stage(fixture.input(admission), fixture.session, fixture.peer.now),
        ).rejects.toThrow('unavailable');
    } finally {
        write.mockRestore();
    }
    expect(await readdir(fixture.directory)).toEqual(['execution-input']);
});

it('does not compact or reuse a lane before genuine terminal and both input/backend acknowledgment commitments', async (): Promise<void> => {
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
    const next: ExecutionInputJournalAdmission = fixture.admission(2n);
    await expect(
        fixture.initialize(owner, next, fixture.permit(next), fixture.session, fixture.peer.now),
    ).rejects.toThrow('active');
    const terminal: ExecutionCompletion = fixture.terminal(admission);
    const pending: ExecutionInputJournalControl = await owner.stage(
        fixture.input(admission),
        fixture.session,
        fixture.peer.now,
    );
    await expect(
        owner.retire(terminal, fixture.terminalAck(terminal), fixture.session, fixture.peer.now),
    ).rejects.toThrow('receipt acknowledgment');
    const receipt: ExecutionInputReceipt = fixture.receipt(pending);
    await owner.record(receipt);
    await expect(
        owner.retire(terminal, fixture.terminalAck(terminal), fixture.session, fixture.peer.now),
    ).rejects.toThrow();
    await owner.acknowledge(
        fixture.acknowledgment(pending, receipt),
        fixture.session,
        fixture.peer.now,
    );
    await expect(
        owner.retire(
            {
                ...terminal,
                signature: fixture.peer.authority.sign(
                    SignaturePurpose.OperationExecutionResult,
                    Buffer.from('wrong'),
                ),
            },
            fixture.terminalAck(terminal),
            fixture.session,
            fixture.peer.now,
        ),
    ).rejects.toThrow('genuine');
    await owner.retire(terminal, fixture.terminalAck(terminal), fixture.session, fixture.peer.now);
    await expect(
        fixture.initialize(
            owner,
            admission,
            fixture.permit(admission),
            fixture.session,
            fixture.peer.now,
        ),
    ).rejects.toThrow('previously used');
    await fixture.initialize(owner, next, fixture.permit(next), fixture.session, fixture.peer.now);
    expect(owner.snapshot().admission.ready.sequence).toBe(2n);
    expect(await readdir(fixture.directory)).toEqual(['execution-input']);
});

it('enforces original tighter grants, current confirmed leases, full proof signatures and monotonic writer generations', async (): Promise<void> => {
    await using fixture: Fixture = await Fixture.create();
    await using owner: Owner = await Owner.open(
        fixture.directory,
        fixture.peer.identity,
        fixture.scope,
    );
    const rule: ExecutionInteractiveInvocationRule = {
        ...fixture.rule(),
        maximumInputBytes: 3n,
        maximumControls: 2,
    };
    const admission: ExecutionInputJournalAdmission = fixture.admission(1n, 'abc', rule);
    await fixture.initialize(
        owner,
        admission,
        fixture.permit(admission),
        fixture.session,
        fixture.peer.now,
    );
    const original: ExecutionInputPermit = fixture.input(
        admission,
        Buffer.from('abc'),
        0n,
        null,
        2n,
    );
    using unconfirmed: ConnectorClientSession = new ConnectorClientSession(fixture.peer.identity);
    await expect(owner.stage(original, unconfirmed, fixture.peer.now)).rejects.toThrow();
    await expect(
        owner.stage(
            {
                ...original,
                signature: fixture.peer.device.sign(
                    SignaturePurpose.OperationExecutionInputPermit,
                    Buffer.from('wrong'),
                ),
            },
            fixture.session,
            fixture.peer.now,
        ),
    ).rejects.toThrow();
    const control: ExecutionInputJournalControl = await owner.stage(
        original,
        fixture.session,
        fixture.peer.now,
    );
    const receipt: ExecutionInputReceipt = fixture.receipt(control);
    await owner.record(receipt);
    const ack: ExecutionInputAcknowledgment = fixture.acknowledgment(control, receipt);
    await expect(
        owner.acknowledge(
            { ...ack, receiptSha256: 'f'.repeat(64) },
            fixture.session,
            fixture.peer.now,
        ),
    ).rejects.toThrow();
    await owner.acknowledge(ack, fixture.session, fixture.peer.now);
    await expect(
        owner.stage(
            fixture.input(admission, Buffer.from('d'), 1n, owner.snapshot().cursor, 2n),
            fixture.session,
            fixture.peer.now,
        ),
    ).rejects.toThrow('grant');
    await expect(
        owner.stage(
            fixture.input(admission, Buffer.from('d'), 1n, owner.snapshot().cursor, 1n),
            fixture.session,
            fixture.peer.now,
        ),
    ).rejects.toThrow('Stale');
    expect(owner.snapshot().cursor.acceptedOffset).toBe(3n);
});

it('bounds encrypted state while retaining full proofs and maximum binary controls beside escaped initial launch data', async (): Promise<void> => {
    await using fixture: Fixture = await Fixture.create();
    const admission: ExecutionInputJournalAdmission = fixture.admission(1n, '\0'.repeat(400));
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
    for (let sequence: bigint = 0n; sequence < 3n; sequence++) {
        const bytes: Buffer =
            sequence === 0n
                ? Buffer.from(admission.launch.invocation.stdin)
                : Buffer.alloc(4096, 255);
        const pending: ExecutionInputJournalControl = await owner.stage(
            fixture.input(
                admission,
                bytes,
                sequence,
                sequence === 0n ? null : owner.snapshot().cursor,
            ),
            fixture.session,
            fixture.peer.now,
        );
        const receipt: ExecutionInputReceipt = fixture.receipt(pending);
        await owner.record(receipt);
        if (sequence < 2n) {
            await owner.acknowledge(
                fixture.acknowledgment(pending, receipt),
                fixture.session,
                fixture.peer.now,
            );
        }
    }
    expect((await stat(fixture.file)).size).toBeLessThanOrEqual(Limits.recordBytes);
    expect((await readdir(fixture.directory)).length).toBe(1);
    const current: ExecutionInputJournalState = owner.snapshot();
    if (
        current.last?.kind !== ExecutionInputJournalControlKind.Permit ||
        current.pending?.kind !== ExecutionInputJournalControlKind.Permit
    ) {
        throw new Error('Actual write controls required');
    }
    expect(current.last.permit.signature.length).toBe(3312);
    expect(current.pending.permit.signature.length).toBe(3312);
    expect(current.pending?.receipt?.signature.length).toBe(3312);
    expect(Proof.readySha256(current.admission.ready)).toBe(Proof.readySha256(admission.ready));
});
