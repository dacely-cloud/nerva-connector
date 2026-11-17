// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

import {
    ExecutionInputJournalControlKind,
    type ExecutionInputJournalRetainedControl,
} from '../src/execution/ExecutionInputJournalTypes.js';
import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, it, vi, type MockInstance } from 'vitest';
import { ExecutionInputJournalOwner as Owner } from '../src/execution/ExecutionInputJournalOwner.js';
import { ExecutionInputJournalFixture as Fixture } from './support/ExecutionInputJournalFixture.js';
import type {
    ExecutionInputJournalAdmission,
    ExecutionInputJournalControl,
    ExecutionInputJournalState,
} from '../src/execution/ExecutionInputJournalTypes.js';
import { ConnectorPrivateDirectory } from '../src/runtime/ConnectorPrivateDirectory.js';
import {
    ExecutionInputDisposition,
    type ExecutionInputReceipt,
    type ExecutionInputReceiptBody,
} from 'nerva-connector-protocol/execution/ExecutionInput.js';
import { ExecutionInteractiveProof as Proof } from 'nerva-connector-protocol/execution/ExecutionInteractiveProof.js';
import { SignaturePurpose } from 'nerva-connector-protocol/identity/IdentityFormat.js';
import { SigningKey } from '../src/identity/SigningKey.js';

it('a publication acknowledgment failure retains possible input intent without returning native permission', async (): Promise<void> => {
    await using fixture: Fixture = await Fixture.create();
    const admission: ExecutionInputJournalAdmission = fixture.admission();
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
        const write: MockInstance<ConnectorPrivateDirectory['write']> = vi
            .spyOn(ConnectorPrivateDirectory.prototype, 'write')
            .mockImplementationOnce(async function (
                this: ConnectorPrivateDirectory,
                name: string,
                bytes: Buffer,
                maximum: number,
                initialize: boolean,
            ): Promise<void> {
                // Restore before the real publication; only its returned acknowledgment is lost.
                write.mockRestore();
                await this.write(name, bytes, maximum, initialize);
                throw new Error('fixture lost publication acknowledgment');
            });
        try {
            await expect(
                owner.stage(fixture.input(admission), fixture.session, fixture.peer.now),
            ).rejects.toThrow('lost publication');
            await expect(
                owner.stage(fixture.input(admission), fixture.session, fixture.peer.now),
            ).rejects.toThrow('unavailable');
        } finally {
            write.mockRestore();
        }
    }
    await using restored: Owner = await Owner.open(
        fixture.directory,
        fixture.peer.identity,
        fixture.scope,
    );
    expect(await restored.restore(admission)).toMatchObject({
        ownerLost: true,
        pending: { receipt: { disposition: ExecutionInputDisposition.Indeterminate } },
        cursor: {
            initialAccepted: false,
            acceptedOffset: 0n,
            blocked: true,
            processedSequence: null,
        },
    });
});

it('changed or invalid currently retained bytes cannot be overwritten by a live in-memory cursor', async (): Promise<void> => {
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
    await writeFile(fixture.file, 'corrupt retained state');
    await expect(
        owner.stage(fixture.input(admission), fixture.session, fixture.peer.now),
    ).rejects.toThrow();
    expect(await readFile(fixture.file, 'utf8')).toBe('corrupt retained state');
    await expect(
        owner.stage(fixture.input(admission), fixture.session, fixture.peer.now),
    ).rejects.toThrow('unavailable');
});

it('directory, authority pin and device identity changes fail encrypted scope authentication', async (): Promise<void> => {
    await using fixture: Fixture = await Fixture.create();
    const admission: ExecutionInputJournalAdmission = fixture.admission();
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
    const bytes: Buffer = await readFile(fixture.file);
    const moved: string = join(fixture.root, 'moved');
    await mkdir(moved, { mode: 0o700 });
    await writeFile(join(moved, 'execution-input'), bytes, { mode: 0o600 });
    {
        await using owner: Owner = await Owner.open(moved, fixture.peer.identity, fixture.scope);
        await expect(owner.restore(admission)).rejects.toThrow();
    }
    using foreign: SigningKey = SigningKey.generate();
    for (const identity of [
        {
            ...fixture.peer.identity,
            authority: { ...fixture.peer.identity.authority, publicKey: foreign.publicKey },
        },
        { ...fixture.peer.identity, publicKey: foreign.publicKey, key: foreign },
    ]) {
        await using owner: Owner = await Owner.open(fixture.directory, identity, fixture.scope);
        await expect(owner.restore(admission)).rejects.toThrow();
    }
    expect((await readFile(fixture.file)).equals(bytes)).toBe(true);
});

it('the first native refusal stops all later admission even when its signed cursor consumed a sequence without blocking', async (): Promise<void> => {
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
    const initial: ExecutionInputJournalControl = await owner.stage(
        fixture.input(admission),
        fixture.session,
        fixture.peer.now,
    );
    const applied: ExecutionInputReceipt = fixture.receipt(initial);
    await owner.record(applied);
    await owner.acknowledge(
        fixture.acknowledgment(initial, applied),
        fixture.session,
        fixture.peer.now,
    );
    const control: ExecutionInputJournalControl = await owner.stage(
        fixture.input(admission, Buffer.from('not applied'), 1n, owner.snapshot().cursor),
        fixture.session,
        fixture.peer.now,
    );
    const body: ExecutionInputReceiptBody = {
        ...fixture.original(control.permit.input),
        readySha256: control.permit.input.readySha256,
        inputId: control.permit.input.inputId,
        inputSequence: control.permit.input.inputSequence,
        inputHash: control.permit.inputHash,
        disposition: ExecutionInputDisposition.Rejected,
        cursor: {
            ...control.prior,
            processedSequence: 1n,
            processedInputHash: control.permit.inputHash,
            blocked: false,
        },
    };
    const receipt: ExecutionInputReceipt = {
        ...body,
        signature: fixture.peer.device.sign(
            SignaturePurpose.OperationExecutionInputReceipt,
            Proof.receipt(body, {
                input: control.permit.input,
                inputHash: control.permit.inputHash,
                prior: control.prior,
            }),
        ),
    };
    await owner.record(receipt);
    await owner.acknowledge(
        fixture.acknowledgment(control, receipt),
        fixture.session,
        fixture.peer.now,
    );
    expect(owner.snapshot()).toMatchObject({
        ownerLost: false,
        inputStopped: true,
        cursor: { blocked: false, acceptedOffset: 0n },
    });
    await expect(
        owner.stage(
            fixture.input(admission, Buffer.from('later'), 2n, owner.snapshot().cursor),
            fixture.session,
            fixture.peer.now,
        ),
    ).rejects.toThrow('unavailable');
});

it('restoring an already signed Applied receipt preserves that first proof but cannot resurrect its old native process', async (): Promise<void> => {
    await using fixture: Fixture = await Fixture.create();
    const admission: ExecutionInputJournalAdmission = fixture.admission(1n, 'accepted');
    let signature: string;
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
        const control: ExecutionInputJournalControl = await owner.stage(
            fixture.input(admission),
            fixture.session,
            fixture.peer.now,
        );
        const receipt: ExecutionInputReceipt = fixture.receipt(control);
        signature = receipt.signature;
        await owner.record(receipt);
    }
    await using owner: Owner = await Owner.open(
        fixture.directory,
        fixture.peer.identity,
        fixture.scope,
    );
    const state: ExecutionInputJournalState = await owner.restore(admission);
    expect(state).toMatchObject({
        ownerLost: true,
        pending: { receipt: { signature, disposition: ExecutionInputDisposition.Applied } },
        cursor: { acceptedOffset: 8n, initialAccepted: true },
    });
    const control: ExecutionInputJournalRetainedControl | null = state.pending;
    if (
        control?.receipt === null ||
        control === null ||
        control.kind !== ExecutionInputJournalControlKind.Permit
    ) {
        throw new Error('First signed receipt was not retained');
    }
    await owner.acknowledge(
        fixture.acknowledgment(control, control.receipt),
        fixture.session,
        fixture.peer.now,
    );
    await expect(
        owner.stage(
            fixture.input(admission, Buffer.from('later'), 1n, owner.snapshot().cursor),
            fixture.session,
            fixture.peer.now,
        ),
    ).rejects.toThrow('unavailable');
    expect(await readdir(fixture.directory)).toEqual(['execution-input']);
});
