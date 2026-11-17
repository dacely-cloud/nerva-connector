// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { expect, it } from 'vitest';
import { FileHistoryFixture } from './support/FileHistoryFixture.js';
import {
    ConnectorHistoryMigration,
    ConnectorHistoryMigrationError,
} from '../src/runtime/ConnectorHistoryMigration.js';
import {
    ConnectorHistoryMigrationMarker,
    ConnectorHistoryMigrationPhase,
    type ConnectorHistoryMigrationReceipt,
} from '../src/runtime/ConnectorHistoryMigrationMarker.js';

const helpers: boolean =
    process.platform === 'linux' && process.env['NERVA_CONNECTOR_FILES_HELPER'] !== undefined;

it.skipIf(!helpers)(
    'incomplete marker partials fence normal runtime and explicit stopped retry cleans only its known partial before validating complete history',
    async (): Promise<void> => {
        await using fixture: FileHistoryFixture = await FileHistoryFixture.create();
        await fixture.retain(fixture.permit());
        const path: string = join(
            dirname(fixture.identity.settings.privateKeyFile),
            ConnectorHistoryMigrationMarker.filename,
        );
        const marker: Buffer = await readFile(path);
        const original: Buffer = await readFile(join(fixture.state, 'file-journal'));
        await writeFile(path + '.partial', 'INTERRUPTED MARKER WRITE', { mode: 0o600 });
        await expect(
            ConnectorHistoryMigration.requireComplete(fixture.identity),
        ).rejects.toBeInstanceOf(ConnectorHistoryMigrationError);
        expect(
            await ConnectorHistoryMigration.run(
                fixture.identity.configurationFile,
                new AbortController().signal,
            ),
        ).toMatchObject({ complete: true, upgraded: 0 });
        await ConnectorHistoryMigration.requireComplete(fixture.identity);
        expect((await readFile(path)).equals(marker)).toBe(true);
        expect((await readFile(join(fixture.state, 'file-journal'))).equals(original)).toBe(true);
        await expect(readFile(path + '.partial')).rejects.toThrow();
    },
);

it.skipIf(!helpers)(
    'a tampered phase, wrong authority binding or signed omitted lane never permits normal startup or rewrites retained history',
    async (): Promise<void> => {
        await using fixture: FileHistoryFixture = await FileHistoryFixture.create();
        await fixture.retain(fixture.permit());
        const path: string = join(
            dirname(fixture.identity.settings.privateKeyFile),
            ConnectorHistoryMigrationMarker.filename,
        );
        const complete: ConnectorHistoryMigrationReceipt = ConnectorHistoryMigrationMarker.read(
            await readFile(path),
            fixture.identity,
        );
        const history: Buffer = await readFile(join(fixture.state, 'file-journal'));
        const candidates: readonly ConnectorHistoryMigrationReceipt[] = [
            { ...complete, phase: ConnectorHistoryMigrationPhase.Prepared },
            { ...complete, bindingSha256: 'f'.repeat(64) },
            ConnectorHistoryMigrationMarker.create(
                fixture.identity,
                ConnectorHistoryMigrationPhase.Complete,
                [],
                complete.approvalSha256,
                complete.appliedSha256,
            ),
        ];
        for (const marker of candidates) {
            await writeFile(path, JSON.stringify(marker), { mode: 0o600 });
            await expect(
                ConnectorHistoryMigration.requireComplete(fixture.identity),
            ).rejects.toBeInstanceOf(ConnectorHistoryMigrationError);
            await expect(
                ConnectorHistoryMigration.run(
                    fixture.identity.configurationFile,
                    new AbortController().signal,
                ),
            ).rejects.toBeInstanceOf(ConnectorHistoryMigrationError);
            expect((await readFile(join(fixture.state, 'file-journal'))).equals(history)).toBe(
                true,
            );
            expect(await readFile(path, 'utf8')).toBe(JSON.stringify(marker));
        }
    },
);
