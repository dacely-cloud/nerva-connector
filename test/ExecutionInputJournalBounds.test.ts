// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

import { readFile } from 'node:fs/promises';
import { expect, it } from 'vitest';
import { ExecutionInputJournalFixture as Fixture } from './support/ExecutionInputJournalFixture.js';
import { ExecutionInputJournalOwner as Owner } from '../src/execution/ExecutionInputJournalOwner.js';
import { ExecutionInputJournalCodec } from '../src/execution/ExecutionInputJournalCodec.js';
import { ExecutionInputJournalValidation } from '../src/execution/ExecutionInputJournalValidation.js';
import {
    ExecutionInputJournalLimits as Limits,
    ExecutionInputJournalControlKind,
    type ExecutionInputJournalState,
    type ExecutionInputJournalControl,
    type ExecutionInputJournalAdmission,
} from '../src/execution/ExecutionInputJournalTypes.js';
import { ExecutionInteractiveLimits } from 'nerva-connector-protocol/execution/ExecutionInteractive.js';
import { ExecutionInputTerminalResolutionLimits } from 'nerva-connector-protocol/execution/ExecutionInputTerminalResolution.js';
import { ExecutionInteractiveCodec } from 'nerva-connector-protocol/execution/ExecutionInteractiveCodec.js';
import { ExecutionInteractiveLaunchCodec } from 'nerva-connector-protocol/execution/ExecutionInteractiveLaunchCodec.js';
import { ExecutionInputPermitCodec } from 'nerva-connector-protocol/execution/ExecutionInputPermitCodec.js';
import { ExecutionInputReceiptCodec } from 'nerva-connector-protocol/execution/ExecutionInputReceiptCodec.js';
import { ExecutionInputAcknowledgmentCodec } from 'nerva-connector-protocol/execution/ExecutionInputAcknowledgmentCodec.js';
import type { ExecutionInputReceipt } from 'nerva-connector-protocol/execution/ExecutionInput.js';

it('complete maximum binary ranges, maximum initial bytes and full first proof pairs fit one finite encrypted file', async (): Promise<void> => {
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
        if (sequence !== 2n) {
            await owner.acknowledge(
                fixture.acknowledgment(pending, receipt),
                fixture.session,
                fixture.peer.now,
            );
        }
    }
    const state: ExecutionInputJournalState = owner.snapshot();
    const codec: ExecutionInputJournalCodec = new ExecutionInputJournalCodec(
        new ExecutionInputJournalValidation(fixture.peer.identity, fixture.scope),
    );
    const plain: string = codec.encode(state);
    const ruleBytes: number = Buffer.byteLength(codec.validation.json(state.admission.rule));
    expect(ruleBytes).toBeGreaterThan(8192);
    /** All variable text is at its grammar ceiling: fixed switches contribute 2048*6 bytes,
     * nine aliases contribute 9*128 ASCII characters, and sixteen environment names contribute 16*64.
     * Remaining enum spellings, object keys, separators and maximum-width bounded numbers are fixed. */
    expect(ruleBytes).toBe(15816);
    expect(ruleBytes).toBeLessThanOrEqual(Limits.ruleBytes);
    expect(Buffer.byteLength(plain)).toBeLessThanOrEqual(Limits.plainBytes);
    expect((await readFile(fixture.file)).byteLength).toBeLessThanOrEqual(Limits.recordBytes);
    expect(
        Buffer.byteLength(ExecutionInteractiveCodec.encode(state.admission.ready)),
    ).toBeLessThanOrEqual(ExecutionInteractiveLimits.readyJsonBytes);
    expect(
        Buffer.byteLength(
            ExecutionInteractiveLaunchCodec.encode(state.admission.rule, state.admission.launch),
        ),
    ).toBeLessThanOrEqual(4096);
    for (const control of [state.last, state.pending]) {
        if (
            control === null ||
            control.kind !== ExecutionInputJournalControlKind.Permit ||
            control.receipt === null
        ) {
            throw new Error('Both complete retained controls are required');
        }
        const context: ReturnType<ExecutionInputJournalValidation['context']> =
            codec.validation.context(control);
        expect(
            Buffer.byteLength(ExecutionInputPermitCodec.encode(control.permit)),
        ).toBeLessThanOrEqual(ExecutionInteractiveLimits.permitJsonBytes);
        expect(
            Buffer.byteLength(ExecutionInputReceiptCodec.encode(control.receipt, context)),
        ).toBeLessThanOrEqual(ExecutionInteractiveLimits.receiptJsonBytes);
        if (control.acknowledgment !== null) {
            expect(
                Buffer.byteLength(
                    ExecutionInputAcknowledgmentCodec.encode(
                        control.acknowledgment,
                        control.receipt,
                    ),
                ),
            ).toBeLessThanOrEqual(ExecutionInteractiveLimits.acknowledgmentJsonBytes);
        }
        expect(
            Buffer.byteLength(
                JSON.stringify(control.prior, (_key: string, value: unknown): unknown =>
                    typeof value === 'bigint' ? value.toString() : value,
                ),
            ),
        ).toBeLessThanOrEqual(1024);
    }
    /** Component wire caps include binary base64, full signatures and JSON escaping, including
     * the resolution envelope's embedded prior cursor. Three separate cursors and 4096 metadata
     * bytes cover scope, discriminants, property names, writer/owner flags and terminal commitments. */
    const maximumComponents: number =
        ExecutionInteractiveLimits.readyJsonBytes +
        Limits.ruleBytes +
        4096 +
        2 *
            Math.max(
                ExecutionInteractiveLimits.permitJsonBytes,
                ExecutionInputTerminalResolutionLimits.jsonBytes,
            ) +
        2 * ExecutionInteractiveLimits.receiptJsonBytes +
        ExecutionInteractiveLimits.acknowledgmentJsonBytes +
        3 * 1024 +
        4096;
    expect(maximumComponents).toBeLessThanOrEqual(Limits.plainBytes);
    expect(Math.ceil((Limits.plainBytes * 8) / 6) + 128).toBeLessThanOrEqual(Limits.recordBytes);
    const invalid: unknown = { ...JSON.parse(plain), extra: 'x'.repeat(Limits.plainBytes) };
    expect((): ExecutionInputJournalState => codec.read(invalid)).toThrow();
});

it('storage decoding never treats signed contradictory cursors or missing immutable proof fields as fresh state', async (): Promise<void> => {
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
    const codec: ExecutionInputJournalCodec = new ExecutionInputJournalCodec(
        new ExecutionInputJournalValidation(fixture.peer.identity, fixture.scope),
    );
    const state: ExecutionInputJournalState = owner.snapshot();
    for (const changed of [
        { ...state, schema: 'unknown-schema' },
        { ...state, cursor: { ...state.cursor, initialAccepted: true } },
        { ...state, scope: { ...state.scope, journalId: 'f'.repeat(64) } },
        { ...state, admission: { ...state.admission, launch: undefined } },
        { ...state, writerGeneration: -1n },
    ]) {
        const raw: unknown = JSON.parse(
            JSON.stringify(changed, (_key: string, value: unknown): unknown =>
                typeof value === 'bigint' ? value.toString() : value,
            ),
        );
        expect((): ExecutionInputJournalState => codec.read(raw)).toThrow();
    }
});
