// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { expect, it } from 'vitest';
import { ConnectorClientFiles } from '../src/runtime/ConnectorClientFiles.js';
import { ConnectorFileProof } from 'nerva-connector-protocol/protocol/ConnectorFileProof.js';
import { SignaturePurpose } from 'nerva-connector-protocol/identity/IdentityFormat.js';
import {
    ConnectorFileFailure,
    type ConnectorFileResponse,
} from 'nerva-connector-protocol/protocol/ConnectorFiles.js';
import type {
    ConnectorFilePermit,
    ConnectorFileCompletion,
} from 'nerva-connector-protocol/protocol/ConnectorFileJobs.js';
import { FileHistoryFixture } from './support/FileHistoryFixture.js';

enum OriginalPhase {
    Started = 'started',
    Terminal = 'terminal',
}

const helpers: boolean =
    process.platform === 'linux' && process.env['NERVA_CONNECTOR_FILES_HELPER'] !== undefined;

it.skipIf(!helpers).each(Object.values(OriginalPhase))(
    'runtime recovery of %s Write preserves both original and replacement staging without repeating the destination effect',
    async (phase: OriginalPhase): Promise<void> => {
        await using fixture: FileHistoryFixture = await FileHistoryFixture.create();
        const now: bigint = BigInt(Date.now());
        const original: ConnectorFilePermit = {
            ...fixture.permit(),
            issuedAtMs: now,
            expiresAtMs: now + 5000n,
        };
        const permit: ConnectorFilePermit = {
            ...original,
            signature: ConnectorFileProof.sign(
                fixture.identity.key,
                SignaturePurpose.OperationFilePermit,
                ConnectorFileProof.permit(original),
            ),
        };
        const saved: ConnectorFileResponse = { ok: false, error: ConnectorFileFailure.Denied };
        await fixture.retain(permit, phase === OriginalPhase.Terminal ? saved : null);
        await writeFile(join(fixture.files.root, 'destination'), 'KEEP DESTINATION', {
            mode: 0o600,
        });
        await writeFile(fixture.staged(permit), 'ORIGINAL', { mode: 0o600 });
        const retired: string = join(fixture.files.directory, 'retained-original-stage');
        await rename(join(fixture.files.directory, 'staging'), retired);
        await mkdir(join(fixture.files.directory, 'staging'), { mode: 0o700 });
        await writeFile(fixture.staged(permit), 'UNRELATED REPLACEMENT', { mode: 0o600 });
        const ciphertext: Buffer = await readFile(join(fixture.state, 'file-journal'));
        {
            await using client: ConnectorClientFiles = await ConnectorClientFiles.load(
                fixture.identity,
            );
            const result: ConnectorFileCompletion = await client.execute(
                permit,
                permit.leaseId,
                now + 10000n,
            );
            expect(result.response).toEqual(
                phase === OriginalPhase.Terminal
                    ? saved
                    : { ok: false, error: ConnectorFileFailure.Indeterminate },
            );
            expect(result.requestHash).toBe(permit.requestHash);
        }
        expect(await readFile(join(retired, basename(fixture.staged(permit))), 'utf8')).toBe(
            'ORIGINAL',
        );
        expect(await readFile(fixture.staged(permit), 'utf8')).toBe('UNRELATED REPLACEMENT');
        expect(await readFile(join(fixture.files.root, 'destination'), 'utf8')).toBe(
            'KEEP DESTINATION',
        );
        expect((await fixture.pending())?.request).toEqual(permit.request);
        if (phase === OriginalPhase.Terminal) {
            expect(await readFile(join(fixture.state, 'file-journal'))).toEqual(ciphertext);
        }
    },
);
