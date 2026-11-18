// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

import { readFile, readdir, unlink } from 'node:fs/promises';
import { expect, it } from 'vitest';
import { ExecutionInputJournalFixture as Fixture } from './support/ExecutionInputJournalFixture.js';
import { ExecutionInputJournalOwner as Owner } from '../src/execution/ExecutionInputJournalOwner.js';
import { ExecutionInputJournalStore } from '../src/execution/ExecutionInputJournalStore.js';
import {
    ExecutionInputJournalPhase,
    ExecutionInputJournalLimits,
    type ExecutionInputJournalAdmission,
    type ExecutionInputJournalPreparation,
    type ExecutionInputJournalRecordState,
} from '../src/execution/ExecutionInputJournalTypes.js';
import { ExecutionInputJournalValidation } from '../src/execution/ExecutionInputJournalValidation.js';
import { ExecutionInputRecordCodec } from '../src/execution/ExecutionInputRecordCodec.js';
import { SignaturePurpose } from 'nerva-connector-protocol/identity/IdentityFormat.js';
import { ExecutionProof } from 'nerva-connector-protocol/execution/ExecutionProof.js';
import type { ExecutionPermit } from 'nerva-connector-protocol/execution/ExecutionJobs.js';

function preparation(
    fixture: Fixture,
    admission: ExecutionInputJournalAdmission,
): ExecutionInputJournalPreparation {
    return {
        permit: fixture.permit(admission),
        rule: admission.rule,
        launch: admission.launch,
        incarnation: admission.ready.incarnation,
    };
}

it('preparation is encrypted in one fixed file and proves no Ready or input acceptance; confirmation survives observer disposal', async (): Promise<void> => {
    await using fixture: Fixture = await Fixture.create();
    await using owner: Owner = await Owner.open(
        fixture.directory,
        fixture.peer.identity,
        fixture.scope,
    );
    const admission: ExecutionInputJournalAdmission = fixture.admission(1n, 'private\0initial');
    await owner.prepareFresh(preparation(fixture, admission), fixture.session, fixture.peer.now);
    expect(owner.recordState().phase).toBe(ExecutionInputJournalPhase.Prepared);
    expect((): ReturnType<Owner['snapshot']> => owner.snapshot()).toThrow();
    expect((await readFile(fixture.file)).includes(Buffer.from('private\0initial'))).toBe(false);
    expect(await readdir(fixture.directory)).toEqual(['execution-input']);
    await expect(
        owner.stage(fixture.input(admission), fixture.session, fixture.peer.now),
    ).rejects.toThrow();
    fixture.session[Symbol.dispose]();
    const ready: ReturnType<Owner['snapshot']> = await owner.confirmReady(admission);
    expect(ready.phase).toBe(ExecutionInputJournalPhase.Ready);
    expect(ready.admission.ready).toEqual(admission.ready);
    expect(ready.cursor).toMatchObject({
        initialAccepted: false,
        acceptedOffset: 0n,
        processedSequence: null,
    });
    await expect(owner.confirmReady(admission)).rejects.toThrow('preparation');
});

it('Prepared recovery retains uncertainty, never promotes to Ready, and needs genuine terminal commitments before monotonic reuse', async (): Promise<void> => {
    await using fixture: Fixture = await Fixture.create();
    const admission: ExecutionInputJournalAdmission = fixture.admission();
    {
        await using owner: Owner = await Owner.open(
            fixture.directory,
            fixture.peer.identity,
            fixture.scope,
        );
        await owner.prepareFresh(
            preparation(fixture, admission),
            fixture.session,
            fixture.peer.now,
        );
    }
    await using owner: Owner = await Owner.open(
        fixture.directory,
        fixture.peer.identity,
        fixture.scope,
    );
    const state: ExecutionInputJournalRecordState = await owner.recoverOriginal(
        fixture.permit(admission),
        fixture.session,
        fixture.peer.now,
        admission.ready.incarnation,
    );
    expect(state).toMatchObject({
        phase: ExecutionInputJournalPhase.Prepared,
        ownerLost: true,
        terminal: null,
    });
    expect(Object.hasOwn(state, 'admission')).toBe(false);
    await expect(owner.confirmReady(admission)).rejects.toThrow('preparation');
    const next: ExecutionInputJournalAdmission = fixture.admission(2n);
    await expect(
        owner.prepareFresh(preparation(fixture, next), fixture.session, fixture.peer.now),
    ).rejects.toThrow('active');
    const terminal: ReturnType<Fixture['terminal']> = fixture.terminal(admission);
    await expect(
        owner.retirePrepared(
            { ...terminal, responseHash: 'f'.repeat(64) },
            fixture.terminalAck(terminal),
            fixture.session,
            fixture.peer.now,
        ),
    ).rejects.toThrow();
    const first: Awaited<ReturnType<Owner['retirePrepared']>> = await owner.retirePrepared(
        terminal,
        fixture.terminalAck(terminal),
        fixture.session,
        fixture.peer.now,
    );
    expect(
        await owner.retirePrepared(
            terminal,
            fixture.terminalAck(terminal),
            fixture.session,
            fixture.peer.now,
        ),
    ).toEqual(first);
    await expect(
        owner.prepareFresh(preparation(fixture, admission), fixture.session, fixture.peer.now),
    ).rejects.toThrow('previously used');
    await owner.prepareFresh(preparation(fixture, next), fixture.session, fixture.peer.now);
    expect(owner.recordState().phase).toBe(ExecutionInputJournalPhase.Prepared);
    expect(await readdir(fixture.directory)).toEqual(['execution-input']);
});

it('used originals require their exact authenticated encrypted phase; missing, changed and omitted-phase records fail closed', async (): Promise<void> => {
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
    {
        await using owner: Owner = await Owner.open(
            fixture.directory,
            fixture.peer.identity,
            fixture.scope,
        );
        await expect(
            owner.recoverOriginal(
                fixture.permit(fixture.admission(2n)),
                fixture.session,
                fixture.peer.now,
                admission.ready.incarnation,
            ),
        ).rejects.toThrow('original');
        const wrong: ExecutionPermit = { ...fixture.permit(admission), jobId: 'wrong-original' };
        const bad: ExecutionPermit = {
            ...wrong,
            signature: fixture.peer.authority.sign(
                SignaturePurpose.OperationExecutionPermit,
                ExecutionProof.permit(wrong),
            ),
        };
        await expect(
            owner.recoverOriginal(
                bad,
                fixture.session,
                fixture.peer.now,
                admission.ready.incarnation,
            ),
        ).rejects.toThrow('original');
        const state: ExecutionInputJournalRecordState = await owner.recoverOriginal(
            fixture.permit(admission),
            fixture.session,
            fixture.peer.now,
            admission.ready.incarnation,
        );
        expect(state.phase).toBe(ExecutionInputJournalPhase.Ready);
        expect(owner.snapshot().admission.ready).toEqual(admission.ready);
        expect(owner.snapshot().ownerLost).toBe(true);
        const codec: ExecutionInputRecordCodec = new ExecutionInputRecordCodec(
            new ExecutionInputJournalValidation(fixture.peer.identity, fixture.scope),
        );
        const { phase, ...omitted }: ExecutionInputJournalRecordState = state;
        expect(phase).toBe(ExecutionInputJournalPhase.Ready);
        expect((): ExecutionInputJournalRecordState =>
            codec.read(
                JSON.parse(
                    JSON.stringify(omitted, (_key: string, value: unknown): unknown =>
                        typeof value === 'bigint' ? value.toString() : value,
                    ),
                ),
            ),
        ).toThrow('phase');
    }
    await unlink(fixture.file);
    await using missing: Owner = await Owner.open(
        fixture.directory,
        fixture.peer.identity,
        fixture.scope,
    );
    await expect(
        missing.recoverOriginal(
            fixture.permit(admission),
            fixture.session,
            fixture.peer.now,
            admission.ready.incarnation,
        ),
    ).rejects.toThrow();
    expect(missing.loaded).toBe(false);
});

it('maximum valid escaped preparation with full signatures fits actual encrypted bounds and authenticates after reload', async (): Promise<void> => {
    await using fixture: Fixture = await Fixture.create();
    const admission: ExecutionInputJournalAdmission = fixture.admission(
        1n,
        '"'.repeat(1024),
        fixture.maximumRule(),
    );
    {
        await using owner: Owner = await Owner.open(
            fixture.directory,
            fixture.peer.identity,
            fixture.scope,
        );
        await owner.prepareFresh(
            preparation(fixture, admission),
            fixture.session,
            fixture.peer.now,
        );
        expect((await readFile(fixture.file)).byteLength).toBeLessThanOrEqual(
            ExecutionInputJournalLimits.recordBytes,
        );
    }
    await using store: ExecutionInputJournalStore = await ExecutionInputJournalStore.open(
        fixture.directory,
        fixture.peer.identity,
        fixture.scope,
    );
    const record: Awaited<ReturnType<ExecutionInputJournalStore['read']>> = await store.read();
    expect(record.state.phase).toBe(ExecutionInputJournalPhase.Prepared);
    const json: string = store.codec.encode(record.state);
    expect(Buffer.byteLength(json)).toBeLessThanOrEqual(ExecutionInputJournalLimits.plainBytes);
    if (record.state.phase !== ExecutionInputJournalPhase.Prepared) {
        throw new Error('Prepared record required');
    }
    expect(record.state.preparation.permit.signature.length).toBe(3312);
    expect(record.state.preparation.launch).toEqual(admission.launch);
});
