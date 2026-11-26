// SPDX-FileCopyrightText: 2026 Dacely <business@dacely.com>
// SPDX-License-Identifier: LicenseRef-Proprietary

import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, it, vi, type MockInstance } from 'vitest';
import { CapturedEffectsFixture } from './support/CapturedEffectsFixture.js';
import { JointOperationFixture } from './support/JointOperationFixture.js';
import { ConnectorClientFiles } from '../src/runtime/ConnectorClientFiles.js';
import { ConnectorFilesystem } from '../src/runtime/ConnectorFilesystem.js';
import {
    ConnectorAuthorizationKind,
    type ConnectorAuthorization,
} from 'nerva-connector-protocol/protocol/ConnectorAuthorization.js';
import { JointWorkspaceProof } from 'nerva-connector-protocol/workspace/JointWorkspaceProof.js';
import type { JointWorkspaceBinding } from 'nerva-connector-protocol/workspace/JointWorkspaceBinding.js';
import type { ConnectorFilePermit } from 'nerva-connector-protocol/protocol/ConnectorFileJobs.js';

const helper: string | undefined = process.env['NERVA_CONNECTOR_FILES_HELPER'];
it.skipIf(helper === undefined)(
    'an original joint terminal result survives current policy cutover without fresh capture, current-ready owner, cleanup or envelope substitution',
    async (): Promise<void> => {
        await using fixture: CapturedEffectsFixture = await CapturedEffectsFixture.create();
        let journalId: string;
        {
            await using journal: Awaited<ReturnType<typeof fixture.history.journal>> =
                await fixture.history.journal();
            journalId = journal.id;
        }
        const binding: JointWorkspaceBinding = JointOperationFixture.body(
            fixture.history.identity,
            fixture.history.policySha256,
            journalId,
            'c'.repeat(64),
            'e'.repeat(64),
        );
        const authorization: ConnectorAuthorization = {
            kind: ConnectorAuthorizationKind.Joint,
            binding: JointWorkspaceProof.sign(fixture.history.identity.key, binding),
        };
        const permit: ConnectorFilePermit = JointOperationFixture.filePermit(
            fixture,
            authorization,
        );
        await writeFile(join(fixture.history.files.root, 'destination'), 'OLD', { mode: 0o600 });
        // Trusted test setup performs the original native write directly; it does not claim a fresh compound device grant.
        const seeded: Awaited<ReturnType<typeof fixture.seed>> = await fixture.seed(permit, true);
        expect(seeded.response?.ok).toBe(true);
        const before: Buffer = await readFile(join(fixture.history.state, 'file-journal'));
        const policy: string = await readFile(fixture.history.files.policy, 'utf8');
        await writeFile(
            fixture.history.files.policy,
            policy.replace('"revision":"1"', '"revision":"2"'),
            { mode: 0o600 },
        );
        await using client: ConnectorClientFiles = await ConnectorClientFiles.load(
            fixture.history.identity,
        );
        expect(client.workspaceSource.profile.policySha256).not.toBe(fixture.history.policySha256);
        using capture: MockInstance<typeof ConnectorFilesystem.prototype.effectContext> = vi.spyOn(
            ConnectorFilesystem.prototype,
            'effectContext',
        );
        using cleanup: MockInstance<typeof ConnectorFilesystem.prototype.cleanupWrite> = vi.spyOn(
            ConnectorFilesystem.prototype,
            'cleanupWrite',
        );
        using effect: MockInstance<typeof ConnectorFilesystem.prototype.dispatchBound> = vi.spyOn(
            ConnectorFilesystem.prototype,
            'dispatchBound',
        );
        const result: Awaited<ReturnType<typeof client.execute>> = await client.execute(
            permit,
            permit.leaseId,
            permit.expiresAtMs + 10000n,
        );
        expect(result.response).toEqual(seeded.response);
        expect(result.admissionHash).toBe(permit.admissionHash);
        const replacement: ConnectorAuthorization = {
            kind: ConnectorAuthorizationKind.Joint,
            binding: JointWorkspaceProof.sign(fixture.history.identity.key, binding),
        };
        const changed: ConnectorFilePermit = JointOperationFixture.filePermit(fixture, replacement);
        expect(changed.admissionHash).toBe(permit.admissionHash);
        await expect(
            client.execute(changed, changed.leaseId, changed.expiresAtMs + 10000n),
        ).rejects.toThrow('authorization changed');
        expect(capture).not.toHaveBeenCalled();
        expect(cleanup).not.toHaveBeenCalled();
        expect(effect).not.toHaveBeenCalled();
        expect(await readFile(join(fixture.history.state, 'file-journal'))).toEqual(before);
        expect(await readFile(join(fixture.history.files.root, 'destination'), 'utf8')).toBe('NEW');
    },
);
