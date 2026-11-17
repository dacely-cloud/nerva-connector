// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

import { readFile, rm, writeFile } from 'node:fs/promises';
import { expect, it, vi, type MockInstance } from 'vitest';
import { ExecutionInteractiveOwnershipFixture as Fixture } from './support/ExecutionInteractiveOwnershipFixture.js';
import { ExecutionInteractiveOwnership as Owner } from '../src/execution/ExecutionInteractiveOwnership.js';
import { ExecutionPipeProbe } from './support/ExecutionPipeFixture.js';
import { ExecutionInputWorkCapture } from 'nerva-connector-protocol/execution/ExecutionInputWorkCapture.js';
import { ExecutionInputPermitCodec } from 'nerva-connector-protocol/execution/ExecutionInputPermitCodec.js';
import type { ExecutionNativePipeHandle } from '../src/execution/ExecutionNativePipeHandle.js';
import type { ExecutionInteractiveDeliveryReply } from '../src/execution/ExecutionInteractiveOwnershipTypes.js';

const helper: string | undefined = process.env['NERVA_CONNECTOR_EXEC_HELPER'];

/** Recovery opens the same already-existing lane, authority pin and permanent main journal identity. */
async function reopen(fixture: Fixture): Promise<Owner> {
    return await Owner.open(
        fixture.signed.peer.identity,
        {
            policyFile: '/qualification-only/no-policy-publication',
            stateDirectory: fixture.signed.root,
            lane: fixture.permit.lane,
        },
        fixture.main,
        (): void => {},
    );
}

it.skipIf(helper === undefined)(
    'a completed main original restores first Ready and its exact receipt outbox without a current start permit or native relaunch',
    async (): Promise<void> => {
        if (helper === undefined) {
            throw new Error('Explicit unused native candidate required');
        }
        await using fixture: Fixture = await Fixture.create(
            helper,
            'first receipt',
            ExecutionPipeProbe.Hold,
        );
        const send: MockInstance<ExecutionNativePipeHandle['send']> = vi.spyOn(
            fixture.binding.pipe,
            'send',
        );
        const admission: ReturnType<typeof fixture.owner.journal.snapshot>['admission'] =
            fixture.owner.journal.snapshot().admission;
        const before: ExecutionInteractiveDeliveryReply = await fixture.owner.input(
            ExecutionInputWorkCapture.read(
                JSON.parse(
                    '{"permit":' +
                        ExecutionInputPermitCodec.encode(fixture.signed.input(admission)) +
                        ',"resolution":null,"acknowledgment":null}',
                ),
            ),
            fixture.signed.session,
        );
        fixture.stop.abort();
        await fixture.task;
        await fixture.owner[Symbol.asyncDispose]();
        const ciphertext: Buffer = await readFile(fixture.signed.file);
        await using restored: Owner = await reopen(fixture);
        await restored.restoreCompleted();
        expect(restored.journal.snapshot().ownerLost).toBe(true);
        expect(restored.journal.snapshot().inputStopped).toBe(true);
        expect(restored.ready(fixture.signed.session)).toEqual(admission.ready);
        const drained: ExecutionInteractiveDeliveryReply = await restored.input(
            ExecutionInputWorkCapture.empty(),
            fixture.signed.session,
        );
        expect(drained.completion?.receiptJson()).toBe(before.completion?.receiptJson());
        expect(send).toHaveBeenCalledTimes(1);
        expect(await readFile(fixture.signed.file)).not.toEqual(ciphertext);
        expect(fixture.main.pending?.response).not.toBeNull();
    },
);

it.skipIf(helper === undefined).each([false, true])(
    'a completed bound main original fails closed with missing/corrupt input state (corrupt=%s), preserving its terminal outcome',
    async (corrupt: boolean): Promise<void> => {
        if (helper === undefined) {
            throw new Error('Explicit unused native candidate required');
        }
        await using fixture: Fixture = await Fixture.create(helper, '', ExecutionPipeProbe.Hold);
        fixture.stop.abort();
        const response: Awaited<typeof fixture.task> = await fixture.task;
        await fixture.owner[Symbol.asyncDispose]();
        if (corrupt) {
            await writeFile(fixture.signed.file, 'corrupt-owned-fixture', { mode: 0o600 });
        } else {
            await rm(fixture.signed.file);
        }
        await using restored: Owner = await reopen(fixture);
        await expect(restored.restoreCompleted()).rejects.toThrow();
        expect(restored.journal.loaded).toBe(false);
        expect(fixture.main.pending?.response).toEqual(response);
        if (corrupt) {
            expect(await readFile(fixture.signed.file, 'utf8')).toBe('corrupt-owned-fixture');
        } else {
            await expect(readFile(fixture.signed.file)).rejects.toThrow();
        }
    },
);
