// SPDX-FileCopyrightText: 2026 Dacely <business@dacely.com>
// SPDX-License-Identifier: LicenseRef-Proprietary

import { ConnectorFilesystem } from '../src/runtime/ConnectorFilesystem.js';
import type { ConnectorCapturedFileEffect } from '../src/runtime/ConnectorEffectContext.js';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, it, vi, type MockInstance } from 'vitest';
import { JointDeviceFixture } from './support/JointDeviceFixture.js';
import { JointWorkspaceProof } from 'nerva-connector-protocol/workspace/JointWorkspaceProof.js';
import { JointWorkspaceReceiptProof } from 'nerva-connector-protocol/workspace/JointWorkspaceReceiptProof.js';
import {
    ConnectorAuthorizationKind,
    type ConnectorAuthorization,
} from 'nerva-connector-protocol/protocol/ConnectorAuthorization.js';
import { ConnectorAuthorizationCodec } from 'nerva-connector-protocol/protocol/ConnectorAuthorizationCodec.js';
import { ConnectorAuthorizationProof } from 'nerva-connector-protocol/protocol/ConnectorAuthorizationProof.js';
import { ConnectorFileJobsCodec } from 'nerva-connector-protocol/protocol/ConnectorFileJobsCodec.js';
import { ConnectorFileProof } from 'nerva-connector-protocol/protocol/ConnectorFileProof.js';
import {
    ConnectorFileAction,
    ConnectorWriteMode,
} from 'nerva-connector-protocol/protocol/ConnectorFileTypes.js';
import type {
    ConnectorFileOperation,
    ConnectorFilePermit,
    ConnectorFileAcknowledgment,
} from 'nerva-connector-protocol/protocol/ConnectorFileJobs.js';
import {
    ConnectorFrameKind,
    type ConnectorClientFrame,
} from '../src/protocol/ConnectorTransport.js';
import type { ExecutionDeliveryLink } from '../src/execution/ExecutionDeliveryLink.js';
import type {
    ExecutionPermit,
    ExecutionCompletion,
} from 'nerva-connector-protocol/execution/ExecutionJobs.js';
import type { ExecutionOutputAck } from 'nerva-connector-protocol/execution/ExecutionOutput.js';
import { ExecutionProof } from 'nerva-connector-protocol/execution/ExecutionProof.js';
import { SignaturePurpose } from 'nerva-connector-protocol/identity/IdentityFormat.js';

const enabled: boolean =
    process.env['NERVA_CONNECTOR_FILES_HELPER'] !== undefined &&
    process.env['NERVA_CONNECTOR_EXEC_HELPER'] !== undefined;
it.skipIf(!enabled)(
    'the actual shared capability owner accepts body-equivalent operation signature B only after a current metadata receipt A, retains B before native effects, and authorizes another lane despite pending work',
    async (): Promise<void> => {
        await using fixture: JointDeviceFixture = await JointDeviceFixture.create();
        const authority: typeof fixture.authority = fixture.authority;
        const lease: ReturnType<typeof authority.lease> = authority.lease();
        const operation: ConnectorAuthorization = {
            kind: ConnectorAuthorizationKind.Joint,
            binding: JointWorkspaceProof.sign(authority.device, fixture.original.binding),
        };
        expect(operation.binding.signature).not.toBe(fixture.original.signature);
        const request: ConnectorFileOperation = ConnectorFileJobsCodec.operation({
            action: ConnectorFileAction.Write,
            requestId: 'joint-write',
            rootId: 'files',
            policySha256: fixture.files.workspaceSource.profile.policySha256,
            path: 'destination',
            mode: ConnectorWriteMode.Replace,
            dataBase64: Buffer.from('WRITTEN').toString('base64'),
        });
        const now: bigint = BigInt(Date.now());
        const original: Omit<ConnectorFilePermit, 'signature'> = {
            authorityId: authority.identity.authority.authorityId,
            enrollmentId: authority.identity.settings.enrollmentId,
            leaseId: lease.leaseId,
            jobId: 'joint-file',
            sequence: 1n,
            dispatchId: 'A'.repeat(43),
            requestHash: ConnectorFileProof.digest(ConnectorFileJobsCodec.encode(request)),
            request,
            authorization: operation,
            admissionHash: ConnectorAuthorizationProof.file(
                ConnectorFileProof.digest(ConnectorFileJobsCodec.encode(request)),
                operation,
            ),
            issuedAtMs: now,
            expiresAtMs: now + 10000n,
        };
        const permit: ConnectorFilePermit = {
            ...original,
            signature: ConnectorFileProof.sign(
                authority.authority,
                SignaturePurpose.OperationFilePermit,
                ConnectorFileProof.permit(original),
            ),
        };
        await writeFile(join(fixture.native.workspace, 'destination'), 'OLD', { mode: 0o600 });
        await expect(
            fixture.files.execute(permit, lease.leaseId, lease.expiresAtMs),
        ).rejects.toThrow('currently accepted');
        expect((await fixture.fileSnapshot()).pending).toBeNull();
        const completed: PromiseWithResolvers<ExecutionCompletion> =
            Promise.withResolvers<ExecutionCompletion>();
        const link: ExecutionDeliveryLink = {
            session: authority.session(lease),
            leaseId: lease.leaseId,
            close: (): void => {
                completed.reject(new Error('Current delivery closed'));
            },
            send: (frame: ConnectorClientFrame): void => {
                if (frame.kind === ConnectorFrameKind.JointWorkspacePublication) {
                    fixture.workspaces.receive(
                        {
                            kind: ConnectorFrameKind.JointWorkspaceActivated,
                            receipt: JointWorkspaceReceiptProof.sign(authority.authority, {
                                authorityId: authority.identity.authority.authorityId,
                                environmentId: authority.identity.settings.environmentId,
                                enrollmentId: authority.identity.settings.enrollmentId,
                                slot: 0,
                                leaseId: lease.leaseId,
                                bindingRevision: frame.publication.descriptor.binding.revision,
                                bindingSha256: JointWorkspaceProof.bindingSha256(
                                    frame.publication.descriptor.binding,
                                ),
                                publicationSha256: JointWorkspaceReceiptProof.publicationSha256(
                                    frame.publication,
                                ),
                                issuedAtMs: BigInt(Date.now()),
                            }),
                        },
                        link,
                    );
                } else if (frame.kind === ConnectorFrameKind.ExecutionOutput) {
                    const value: Omit<ExecutionOutputAck, 'signature'> = {
                        authorityId: authority.identity.authority.authorityId,
                        lane: frame.update.lane,
                        environmentId: frame.update.environmentId,
                        enrollmentId: frame.update.enrollmentId,
                        leaseId: frame.update.leaseId,
                        jobId: frame.update.jobId,
                        sequence: frame.update.sequence,
                        dispatchId: frame.update.dispatchId,
                        requestHash: frame.update.requestHash,
                        admissionHash: frame.update.admissionHash,
                        outputHash: frame.update.outputHash,
                    };
                    fixture.commands.receive(
                        {
                            kind: ConnectorFrameKind.ExecutionOutputAck,
                            acknowledgment: {
                                ...value,
                                signature: authority.authority.sign(
                                    SignaturePurpose.OperationExecutionOutputAck,
                                    ExecutionProof.outputAck(value),
                                ),
                            },
                        },
                        link,
                    );
                } else if (frame.kind === ConnectorFrameKind.ExecutionResult) {
                    completed.resolve(frame.completion);
                }
            },
        };
        fixture.commands.activate(link);
        fixture.workspaces.activate(link);
        await vi.waitFor((): void => expect(fixture.workspaces.ready).toBe(true));
        const result: Awaited<ReturnType<typeof fixture.files.execute>> =
            await fixture.files.execute(permit, lease.leaseId, lease.expiresAtMs);
        expect(result.response.ok).toBe(true);
        expect(result.admissionHash).toBe(permit.admissionHash);
        const snapshot: Awaited<ReturnType<typeof fixture.fileSnapshot>> =
            await fixture.fileSnapshot();
        expect(
            snapshot.pending?.authorization === undefined
                ? null
                : ConnectorAuthorizationCodec.encode(snapshot.pending.authorization),
        ).toBe(ConnectorAuthorizationCodec.encode(operation));
        expect(fixture.files.workspaceSource.quiescent).toBe(false);
        const independent: ExecutionPermit = authority.permit(
            fixture.commands.workspaceSource.profile,
            lease,
        );
        const command: ExecutionPermit = authority.sign({
            ...independent,
            authorization: operation,
            admissionHash: ConnectorAuthorizationProof.execution(
                independent.requestHash,
                independent.lane,
                operation,
            ),
        });
        const deadline: NodeJS.Timeout = setTimeout(
            (): void => completed.reject(new Error('Finite native command deadline')),
            5000,
        );
        try {
            fixture.commands.receive(
                { kind: ConnectorFrameKind.ExecutionPermit, permit: command },
                link,
            );
            const execution: ExecutionCompletion = await completed.promise;
            expect(execution.response.exitCode).toBe(0);
            expect(execution.admissionHash).toBe(command.admissionHash);
        } finally {
            clearTimeout(deadline);
        }
        expect(await readFile(join(fixture.native.workspace, 'effects'), 'utf8')).toBe('x');
        expect(await readFile(join(fixture.native.workspace, 'destination'), 'utf8')).toBe(
            'WRITTEN',
        );
        using clock: MockInstance<typeof Date.now> = vi
            .spyOn(Date, 'now')
            .mockReturnValue(Number(lease.expiresAtMs));
        await expect(fixture.workspaces.file(permit)).rejects.toThrow();
        clock.mockRestore();
        const ack: Omit<ConnectorFileAcknowledgment, 'signature'> = {
            authorityId: authority.identity.authority.authorityId,
            enrollmentId: result.enrollmentId,
            leaseId: result.leaseId,
            jobId: result.jobId,
            sequence: result.sequence,
            dispatchId: result.dispatchId,
            requestHash: result.requestHash,
            admissionHash: result.admissionHash,
            responseHash: result.responseHash,
        };
        await fixture.files.acknowledge(
            {
                ...ack,
                signature: ConnectorFileProof.sign(
                    authority.authority,
                    SignaturePurpose.OperationFileAcknowledgment,
                    ConnectorFileProof.acknowledgment(ack),
                ),
            },
            lease.leaseId,
        );
        const nextRequest: ConnectorFileOperation = ConnectorFileJobsCodec.operation({
            ...request,
            requestId: 'joint-write-2',
            dataBase64: Buffer.from('MUST_NOT_WRITE').toString('base64'),
        });
        const nextHash: string = ConnectorFileProof.digest(
            ConnectorFileJobsCodec.encode(nextRequest),
        );
        const nextUnsigned: Omit<ConnectorFilePermit, 'signature'> = {
            ...original,
            sequence: 2n,
            jobId: 'joint-file-2',
            request: nextRequest,
            requestHash: nextHash,
            admissionHash: ConnectorAuthorizationProof.file(nextHash, operation),
        };
        const next: ConnectorFilePermit = {
            ...nextUnsigned,
            signature: ConnectorFileProof.sign(
                authority.authority,
                SignaturePurpose.OperationFilePermit,
                ConnectorFileProof.permit(nextUnsigned),
            ),
        };
        const fileSettings: typeof authority.identity.settings.files =
            authority.identity.settings.files;
        if (fileSettings === null) {
            throw new Error('Actual original file journal required');
        }
        const before: Buffer = await readFile(join(fileSettings.stateDirectory, 'file-journal'));
        const filesystem: ConnectorFilesystem = fixture.files.workspaceSource.filesystem;
        const inspect: typeof filesystem.effectContext = filesystem.effectContext.bind(filesystem);
        using detach: MockInstance<typeof ConnectorFilesystem.prototype.effectContext> = vi
            .spyOn(ConnectorFilesystem.prototype, 'effectContext')
            .mockImplementationOnce(async (root: string): Promise<ConnectorCapturedFileEffect> => {
                const context: ConnectorCapturedFileEffect = await inspect(root);
                fixture.workspaces.detach(link);
                return context;
            });
        let denied: boolean = false;
        try {
            await fixture.files.execute(next, lease.leaseId, lease.expiresAtMs);
        } catch (caught: unknown) {
            denied = caught instanceof Error && caught.message.includes('currently accepted');
        }
        expect(denied).toBe(true);
        expect(detach).toHaveBeenCalledOnce();
        expect(await readFile(join(fileSettings.stateDirectory, 'file-journal'))).toEqual(before);
        expect(await readFile(join(fixture.native.workspace, 'destination'), 'utf8')).toBe(
            'WRITTEN',
        );
        fixture.workspaces.detach(link);
        await expect(fixture.workspaces.file(permit)).rejects.toThrow('currently accepted');
    },
    15000,
);
