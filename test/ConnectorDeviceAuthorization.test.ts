// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

import { JointOperationFixture } from './support/JointOperationFixture.js';
import { readFile, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, it, vi, type MockInstance, type Mock } from 'vitest';
import { CapturedEffectsFixture } from './support/CapturedEffectsFixture.js';
import { ExecutionFixture } from './support/ExecutionFixture.js';
import { ExecutionIdentity } from './support/ExecutionIdentity.js';
import { setup } from './support/ExecutionSetup.js';
import { ConnectorClientFiles } from '../src/runtime/ConnectorClientFiles.js';
import { ConnectorFilesystem } from '../src/runtime/ConnectorFilesystem.js';
import type { ConnectorJointAdmission } from '../src/runtime/ConnectorJointAdmission.js';
import type { ConnectorFilePermit } from 'nerva-connector-protocol/protocol/ConnectorFileJobs.js';
import {
    ConnectorAuthorizationKind,
    type ConnectorAuthorization,
} from 'nerva-connector-protocol/protocol/ConnectorAuthorization.js';
import { ConnectorAuthorizationProof } from 'nerva-connector-protocol/protocol/ConnectorAuthorizationProof.js';
import { JointWorkspaceProof } from 'nerva-connector-protocol/workspace/JointWorkspaceProof.js';
import type { JointWorkspaceBinding } from 'nerva-connector-protocol/workspace/JointWorkspaceBinding.js';
import { ExecutionConfiguration } from '../src/execution/ExecutionConfiguration.js';
import { ExecutionPairPreparation } from '../src/execution/ExecutionPairPreparation.js';
import { ExecutionClient } from '../src/execution/ExecutionClient.js';
import { ExecutionPolicy } from '../src/execution/ExecutionPolicy.js';
import type {
    ExecutionPermit,
    ExecutionCompletion,
} from 'nerva-connector-protocol/execution/ExecutionJobs.js';
import { ExecutionFailure } from 'nerva-connector-protocol/execution/ExecutionTypes.js';

const filesHelper: string | undefined = process.env['NERVA_CONNECTOR_FILES_HELPER'];
const execHelper: string | undefined = process.env['NERVA_CONNECTOR_EXEC_HELPER'];

it.skipIf(filesHelper === undefined)(
    'actual file ownership rejects malformed joint proof/scope/root/journal and missing or denying current admission before any capture, Started write or native effect',
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
        await using client: ConnectorClientFiles = await ConnectorClientFiles.load(
            fixture.history.identity,
        );
        const before: Buffer = await readFile(join(fixture.history.state, 'file-journal'));
        using capture: MockInstance<typeof ConnectorFilesystem.prototype.effectContext> = vi.spyOn(
            ConnectorFilesystem.prototype,
            'effectContext',
        );
        using native: MockInstance<typeof ConnectorFilesystem.prototype.dispatchBound> = vi.spyOn(
            ConnectorFilesystem.prototype,
            'dispatchBound',
        );
        const valid: ConnectorFilePermit = JointOperationFixture.filePermit(fixture, authorization);
        await expect(
            client.execute(valid, valid.leaseId, valid.expiresAtMs + 10000n),
        ).rejects.toThrow('Fresh joint file admission unavailable');
        const denied: Mock<(permit: ConnectorFilePermit) => Promise<void>> = vi.fn(
            (_permit: ConnectorFilePermit): Promise<void> =>
                Promise.reject(new Error('Current binding not ready')),
        );
        const owner: ConnectorJointAdmission = {
            file: denied,
            execution: (_permit: ExecutionPermit): Promise<void> =>
                Promise.reject(new Error('Current binding not ready')),
        };
        client.bindJointAdmission(owner);
        expect(() => client.bindJointAdmission(owner)).toThrow('already bound');
        await expect(
            client.execute(valid, valid.leaseId, valid.expiresAtMs + 10000n),
        ).rejects.toThrow('Current binding not ready');
        expect(denied).toHaveBeenCalledTimes(1);
        for (const changed of [
            { ...binding, environmentId: 'other-environment' },
            { ...binding, fileRootId: 'other-root' },
            { ...binding, fileJournalId: 'f'.repeat(64) },
        ]) {
            const candidate: ConnectorAuthorization = {
                kind: ConnectorAuthorizationKind.Joint,
                binding: JointWorkspaceProof.sign(fixture.history.identity.key, changed),
            };
            const permit: ConnectorFilePermit = JointOperationFixture.filePermit(
                fixture,
                candidate,
            );
            await expect(
                client.execute(permit, permit.leaseId, permit.expiresAtMs + 10000n),
            ).rejects.toThrow();
        }
        const signature: Buffer = Buffer.from(authorization.binding.signature, 'base64url');
        signature[0] = (signature[0] ?? 0) ^ 1;
        const malformed: ConnectorFilePermit = JointOperationFixture.filePermit(fixture, {
            ...authorization,
            binding: { ...authorization.binding, signature: signature.toString('base64url') },
        });
        await expect(
            client.execute(malformed, malformed.leaseId, malformed.expiresAtMs + 10000n),
        ).rejects.toThrow('proof denied');
        expect(denied).toHaveBeenCalledTimes(1);
        expect(capture).not.toHaveBeenCalled();
        expect(native).not.toHaveBeenCalled();
        expect(await readFile(join(fixture.history.state, 'file-journal'))).toEqual(before);
    },
);

it.skipIf(execHelper === undefined)(
    'actual command ownership requires fresh joint readiness before capture but a signed no-program cancellation and its terminal replay never wait for new activation',
    async (): Promise<void> => {
        if (execHelper === undefined) {
            throw new Error('Explicit native execution helper required');
        }
        await using fixture: ExecutionFixture = await ExecutionFixture.create(execHelper);
        const settings: Awaited<ReturnType<typeof setup>> = await setup(fixture);
        using authority: ExecutionIdentity = new ExecutionIdentity(fixture.directory, settings);
        await ExecutionPairPreparation.prepare(authority.identity, true);
        await using policy: ExecutionPolicy = await ExecutionConfiguration.loadPolicy(
            authority.identity,
            settings,
        );
        await using client: ExecutionClient = await ExecutionClient.load(
            authority.identity,
            settings,
            policy,
        );
        const binding: JointWorkspaceBinding = JointOperationFixture.body(
            authority.identity,
            'c'.repeat(64),
            'f'.repeat(64),
            policy.policySha256,
            client.journalId,
        );
        const authorization: ConnectorAuthorization = {
            kind: ConnectorAuthorizationKind.Joint,
            binding: JointWorkspaceProof.sign(authority.device, binding),
        };
        const lease: ReturnType<ExecutionIdentity['lease']> = authority.lease();
        const original: ExecutionPermit = authority.permit(client.profile, lease);
        const permit: ExecutionPermit = authority.sign({
            ...original,
            authorization,
            admissionHash: ConnectorAuthorizationProof.execution(
                original.requestHash,
                settings.lane,
                authorization,
            ),
        });
        const before: Buffer = await readFile(
            join(ExecutionConfiguration.journalDirectory(settings), 'execution-journal'),
        );
        using capture: MockInstance<typeof policy.effectContext> = vi.spyOn(
            policy,
            'effectContext',
        );
        using native: MockInstance<typeof policy.execute> = vi.spyOn(policy, 'execute');
        await expect(client.execute(permit, authority.session(lease))).rejects.toThrow(
            'Fresh joint command admission unavailable',
        );
        const denied: Mock<(permit: ExecutionPermit) => Promise<void>> = vi.fn(
            (_permit: ExecutionPermit): Promise<void> =>
                Promise.reject(new Error('Current binding not ready')),
        );
        const owner: ConnectorJointAdmission = {
            file: (_permit: ConnectorFilePermit): Promise<void> =>
                Promise.reject(new Error('Current binding not ready')),
            execution: denied,
        };
        client.bindJointAdmission(owner);
        expect(() => client.bindJointAdmission(owner)).toThrow('already bound');
        await expect(client.execute(permit, authority.session(lease))).rejects.toThrow(
            'Current binding not ready',
        );
        expect(denied).toHaveBeenCalledTimes(1);
        expect(capture).not.toHaveBeenCalled();
        expect(native).not.toHaveBeenCalled();
        expect(
            await readFile(
                join(ExecutionConfiguration.journalDirectory(settings), 'execution-journal'),
            ),
        ).toEqual(before);
        const cancelled: ExecutionCompletion = await client.cancel(
            authority.cancel(permit, lease),
            authority.session(lease),
        );
        expect(cancelled.response.failure).toBe(ExecutionFailure.Cancelled);
        expect(cancelled.admissionHash).toBe(permit.admissionHash);
        expect((await client.execute(permit, authority.session(lease))).response).toEqual(
            cancelled.response,
        );
        expect(denied).toHaveBeenCalledTimes(1);
        expect(capture).not.toHaveBeenCalled();
        expect(native).not.toHaveBeenCalled();
        await expect(lstat(join(fixture.workspace, 'effects'))).rejects.toMatchObject({
            code: 'ENOENT',
        });
    },
    15000,
);
