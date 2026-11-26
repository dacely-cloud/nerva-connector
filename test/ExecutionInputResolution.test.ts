// SPDX-FileCopyrightText: 2026 Dacely <business@dacely.com>
// SPDX-License-Identifier: LicenseRef-Proprietary

import { readFile } from 'node:fs/promises';
import { expect, it, vi, type MockInstance } from 'vitest';
import { ExecutionInputJournalFixture as Fixture } from './support/ExecutionInputJournalFixture.js';
import { ExecutionInputJournalOwner as Owner } from '../src/execution/ExecutionInputJournalOwner.js';
import { ExecutionInputJournalControls } from '../src/execution/ExecutionInputJournalControls.js';
import {
    ExecutionInputJournalControlKind,
    ExecutionInputJournalLimits,
    type ExecutionInputJournalAdmission,
    type ExecutionInputJournalRetainedControl,
} from '../src/execution/ExecutionInputJournalTypes.js';
import type {
    ExecutionInputTerminalResolution,
    ExecutionInputTerminalResolutionBody,
} from 'nerva-connector-protocol/execution/ExecutionInputTerminalResolution.js';
import {
    ExecutionInputDisposition,
    type ExecutionInputPermit,
    type ExecutionInputReceipt,
    type ExecutionInputAcknowledgment,
    type ExecutionInputAcknowledgmentBody,
    type ExecutionInputCursor,
} from 'nerva-connector-protocol/execution/ExecutionInput.js';
import { ExecutionInteractiveProof as Proof } from 'nerva-connector-protocol/execution/ExecutionInteractiveProof.js';
import { SignaturePurpose } from 'nerva-connector-protocol/identity/IdentityFormat.js';
import { ConnectorPrivateDirectory } from '../src/runtime/ConnectorPrivateDirectory.js';
import { ExecutionInputJournalCodec } from '../src/execution/ExecutionInputJournalCodec.js';
import { ExecutionInputJournalValidation } from '../src/execution/ExecutionInputJournalValidation.js';
import { ExecutionInputTerminalResolutionCodec } from 'nerva-connector-protocol/execution/ExecutionInputTerminalResolutionCodec.js';

/** These genuine fixture proofs qualify no-effect journal transitions, not real account or native terminal authority. */
function resolution(
    fixture: Fixture,
    admission: ExecutionInputJournalAdmission,
    input: ExecutionInputPermit,
    prior: ExecutionInputCursor,
    generation: bigint = 1n,
    responseHash: string = fixture.terminal(admission).responseHash,
): ExecutionInputTerminalResolution {
    const body: ExecutionInputTerminalResolutionBody = {
        input: input.input,
        inputHash: input.inputHash,
        prior,
        leaseId: fixture.lease.leaseId,
        writerGeneration: generation,
        executionDeadlineMs: admission.launch.executionDeadlineMs,
        responseHash,
        issuedAtMs: fixture.peer.now,
        deliveryExpiresAtMs: fixture.peer.now + 2000n,
    };
    return {
        ...body,
        signature: fixture.peer.authority.sign(
            SignaturePurpose.OperationExecutionInputTerminalResolution,
            Proof.resolution(body, admission.ready),
        ),
    };
}
function acknowledgment(
    fixture: Fixture,
    control: ExecutionInputJournalRetainedControl,
    receipt: ExecutionInputReceipt,
): ExecutionInputAcknowledgment {
    const context: ReturnType<typeof ExecutionInputJournalControls.context> =
        ExecutionInputJournalControls.context(control);
    const {
        signature: _signature,
        disposition: _disposition,
        cursor: _cursor,
        ...identity
    }: ExecutionInputReceipt = receipt;
    const body: ExecutionInputAcknowledgmentBody = {
        ...identity,
        receiptSha256: Proof.receiptSha256(receipt, context),
        leaseId: fixture.lease.leaseId,
        writerGeneration: 2n,
    };
    return {
        ...body,
        signature: fixture.peer.authority.sign(
            SignaturePurpose.OperationExecutionInputAcknowledgment,
            Proof.acknowledgment(body, receipt, context),
        ),
    };
}

it('retains distinct no-effect authority and first receipt exactly, rejects stale/purpose/response changes and permits actual ACK retirement', async (): Promise<void> => {
    await using fixture: Fixture = await Fixture.create();
    await using owner: Owner = await Owner.open(
        fixture.directory,
        fixture.peer.identity,
        fixture.scope,
    );
    const admission: ExecutionInputJournalAdmission = fixture.admission(1n, 'unseen\0initial');
    await fixture.initialize(
        owner,
        admission,
        fixture.permit(admission),
        fixture.session,
        fixture.peer.now,
    );
    const authority: ExecutionInputTerminalResolution = resolution(
        fixture,
        admission,
        fixture.input(admission),
        owner.snapshot().cursor,
        2n,
    );
    const first: ExecutionInputReceipt = await owner.resolveTerminal(
        authority,
        authority.responseHash,
        fixture.session,
        fixture.peer.now,
    );
    expect(first).toMatchObject({
        disposition: ExecutionInputDisposition.Indeterminate,
        cursor: { initialAccepted: false, acceptedOffset: 0n, blocked: true },
    });
    const control: ExecutionInputJournalRetainedControl | null = owner.snapshot().pending;
    if (control?.kind !== ExecutionInputJournalControlKind.TerminalResolution) {
        throw new Error('Distinct terminal resolution required');
    }
    expect(Object.hasOwn(control, 'permit')).toBe(false);
    const encrypted: Buffer = await readFile(fixture.file);
    expect(
        await owner.resolveTerminal(
            resolution(fixture, admission, fixture.input(admission), control.prior, 2n),
            authority.responseHash,
            fixture.session,
            fixture.peer.now,
        ),
    ).toEqual(first);
    expect(await readFile(fixture.file)).toEqual(encrypted);
    await expect(
        owner.resolveTerminal(
            resolution(fixture, admission, fixture.input(admission), control.prior, 1n),
            authority.responseHash,
            fixture.session,
            fixture.peer.now,
        ),
    ).rejects.toThrow('denied');
    await expect(
        owner.resolveTerminal(
            resolution(
                fixture,
                admission,
                fixture.input(admission),
                control.prior,
                2n,
                'f'.repeat(64),
            ),
            authority.responseHash,
            fixture.session,
            fixture.peer.now,
        ),
    ).rejects.toThrow('denied');
    await expect(
        owner.resolveTerminal(
            {
                ...authority,
                signature: fixture.peer.authority.sign(
                    SignaturePurpose.OperationExecutionInputPermit,
                    Proof.resolution(
                        ExecutionInputTerminalResolutionCodec.unsigned(authority),
                        admission.ready,
                    ),
                ),
            },
            authority.responseHash,
            fixture.session,
            fixture.peer.now,
        ),
    ).rejects.toThrow('denied');
    const receiptAck: ExecutionInputAcknowledgment = acknowledgment(fixture, control, first);
    await owner.acknowledge(receiptAck, fixture.session, fixture.peer.now);
    const terminal: ReturnType<Fixture['terminal']> = fixture.terminal(admission);
    await owner.retire(terminal, fixture.terminalAck(terminal), fixture.session, fixture.peer.now);
    expect(owner.snapshot().terminal?.responseHash).toBe(terminal.responseHash);
});

it('an existing genuine Applied receipt wins over terminal uncertainty without replacement or native authority renewal', async (): Promise<void> => {
    await using fixture: Fixture = await Fixture.create();
    await using owner: Owner = await Owner.open(
        fixture.directory,
        fixture.peer.identity,
        fixture.scope,
    );
    const admission: ExecutionInputJournalAdmission = fixture.admission(1n, 'already-applied');
    await fixture.initialize(
        owner,
        admission,
        fixture.permit(admission),
        fixture.session,
        fixture.peer.now,
    );
    const live: Awaited<ReturnType<Owner['stage']>> = await owner.stage(
        fixture.input(admission),
        fixture.session,
        fixture.peer.now,
    );
    const receipt: ExecutionInputReceipt = fixture.receipt(live);
    await owner.record(receipt);
    const authority: ExecutionInputTerminalResolution = resolution(
        fixture,
        admission,
        live.permit,
        live.prior,
    );
    const bytes: Buffer = await readFile(fixture.file);
    expect(
        await owner.resolveTerminal(
            authority,
            authority.responseHash,
            fixture.session,
            fixture.peer.now,
        ),
    ).toEqual(receipt);
    expect(await readFile(fixture.file)).toEqual(bytes);
    expect(owner.snapshot().pending?.kind).toBe(ExecutionInputJournalControlKind.Permit);
});

it.each([1, 2])(
    'a terminal publication fault at write %i never returns an unsaved receipt and recovery retains the confirmed lower bound',
    async (failAt: number): Promise<void> => {
        await using fixture: Fixture = await Fixture.create();
        const admission: ExecutionInputJournalAdmission = fixture.admission(1n, 'not-accepted');
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
            const authority: ExecutionInputTerminalResolution = resolution(
                fixture,
                admission,
                fixture.input(admission),
                owner.snapshot().cursor,
            );
            let writes: number = 0;
            let write: MockInstance<ConnectorPrivateDirectory['write']> = vi.spyOn(
                ConnectorPrivateDirectory.prototype,
                'write',
            );
            async function publication(
                this: ConnectorPrivateDirectory,
                ...args: Parameters<ConnectorPrivateDirectory['write']>
            ): Promise<void> {
                writes++;
                if (writes === failAt) {
                    throw new Error('Fixture terminal storage failure');
                }
                write.mockRestore();
                try {
                    await this.write(...args);
                } finally {
                    write = vi
                        .spyOn(ConnectorPrivateDirectory.prototype, 'write')
                        .mockImplementation(publication);
                }
            }
            write.mockImplementation(publication);
            try {
                await expect(
                    owner.resolveTerminal(
                        authority,
                        authority.responseHash,
                        fixture.session,
                        fixture.peer.now,
                    ),
                ).rejects.toThrow('storage');
                expect(owner.failed).toBe(true);
            } finally {
                write.mockRestore();
            }
        }
        await using restored: Owner = await Owner.open(
            fixture.directory,
            fixture.peer.identity,
            fixture.scope,
        );
        await restored.restore(admission);
        if (failAt === 1) {
            expect(restored.snapshot().pending).toBe(null);
        } else {
            const control: ExecutionInputJournalRetainedControl | null =
                restored.snapshot().pending;
            expect(control?.kind).toBe(ExecutionInputJournalControlKind.TerminalResolution);
            expect(control?.receipt).toMatchObject({
                disposition: ExecutionInputDisposition.Indeterminate,
                cursor: { acceptedOffset: 0n, initialAccepted: false, blocked: true },
            });
        }
    },
);

it('maximum legal escaped grant and two full binary controls fit actual encrypted resolution state without increasing shared caps', async (): Promise<void> => {
    await using fixture: Fixture = await Fixture.create();
    await using owner: Owner = await Owner.open(
        fixture.directory,
        fixture.peer.identity,
        fixture.scope,
    );
    const admission: ExecutionInputJournalAdmission = fixture.admission(
        1n,
        '"'.repeat(1024),
        fixture.maximumRule(),
    );
    await fixture.initialize(
        owner,
        admission,
        fixture.permit(admission),
        fixture.session,
        fixture.peer.now,
    );
    for (let sequence: bigint = 0n; sequence < 2n; sequence++) {
        const bytes: Buffer =
            sequence === 0n
                ? Buffer.from(admission.launch.invocation.stdin)
                : Buffer.alloc(4096, 255);
        const live: Awaited<ReturnType<Owner['stage']>> = await owner.stage(
            fixture.input(
                admission,
                bytes,
                sequence,
                sequence === 0n ? null : owner.snapshot().cursor,
            ),
            fixture.session,
            fixture.peer.now,
        );
        const accepted: ExecutionInputReceipt = fixture.receipt(live);
        await owner.record(accepted);
        await owner.acknowledge(
            fixture.acknowledgment(live, accepted),
            fixture.session,
            fixture.peer.now,
        );
    }
    const next: ExecutionInputPermit = fixture.input(
        admission,
        Buffer.alloc(4096, 255),
        2n,
        owner.snapshot().cursor,
    );
    const authority: ExecutionInputTerminalResolution = resolution(
        fixture,
        admission,
        next,
        owner.snapshot().cursor,
    );
    await owner.resolveTerminal(
        authority,
        authority.responseHash,
        fixture.session,
        fixture.peer.now,
    );
    const codec: ExecutionInputJournalCodec = new ExecutionInputJournalCodec(
        new ExecutionInputJournalValidation(fixture.peer.identity, fixture.scope),
    );
    expect(Buffer.byteLength(codec.encode(owner.snapshot()))).toBeLessThanOrEqual(
        ExecutionInputJournalLimits.plainBytes,
    );
    expect((await readFile(fixture.file)).byteLength).toBeLessThanOrEqual(
        ExecutionInputJournalLimits.recordBytes,
    );
});
