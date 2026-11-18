// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

import { SignaturePurpose } from 'nerva-connector-protocol/identity/IdentityFormat.js';
import { JointWorkspaceFixture } from './JointWorkspaceFixture.js';
import { JointWorkspaceAssembly } from '../../src/workspace/JointWorkspaceAssembly.js';
import type { JointWorkspaceDescriptor } from 'nerva-connector-protocol/workspace/JointWorkspaceBinding.js';
import {
    ConnectorAuthorizationKind,
    type ConnectorAuthorization,
} from 'nerva-connector-protocol/protocol/ConnectorAuthorization.js';
import { ConnectorAuthorizationProof } from 'nerva-connector-protocol/protocol/ConnectorAuthorizationProof.js';
import {
    ConnectorFileFailure,
    type ConnectorFileRead,
} from 'nerva-connector-protocol/protocol/ConnectorFiles.js';
import { ConnectorFileAction } from 'nerva-connector-protocol/protocol/ConnectorFileTypes.js';
import type {
    ConnectorFileOperation,
    ConnectorFilePermit,
    ConnectorFileCompletion,
    ConnectorFileAcknowledgment,
    ConnectorFileAcknowledged,
} from 'nerva-connector-protocol/protocol/ConnectorFileJobs.js';
import { ConnectorFileJobsCodec } from 'nerva-connector-protocol/protocol/ConnectorFileJobsCodec.js';
import { ConnectorFileProof } from 'nerva-connector-protocol/protocol/ConnectorFileProof.js';
import { ExecutionJobsCodec } from '../../src/execution/ExecutionJobsCodec.js';
import {
    type ExecutionRequest,
    type ExecutionPermit,
    type ExecutionCancellation,
    type ExecutionCompletion,
    type ExecutionAcknowledgment,
    type ExecutionAcknowledged,
} from 'nerva-connector-protocol/execution/ExecutionJobs.js';
import { ExecutionLane } from 'nerva-connector-protocol/execution/ExecutionLane.js';
import { ExecutionTermination } from 'nerva-connector-protocol/execution/ExecutionTypes.js';
import { ExecutionProof } from 'nerva-connector-protocol/execution/ExecutionProof.js';
import type {
    ExecutionOutputUpdate,
    ExecutionOutputAck,
} from 'nerva-connector-protocol/execution/ExecutionOutput.js';

/** Generated public descriptor captures are synthetic protocol fixtures; no local grant, native command or backend admission is asserted. */
export class AuthorizedOperationFixture extends JointWorkspaceFixture {
    public readonly descriptor: JointWorkspaceDescriptor = JointWorkspaceAssembly.create(
        this.device,
        this.scope,
        9007199254740993n,
        this.sources(),
    );
    public readonly authorization: ConnectorAuthorization = Object.freeze({
        kind: ConnectorAuthorizationKind.Joint,
        binding: this.descriptor,
    });
    public readonly independent: ConnectorAuthorization = Object.freeze({
        kind: ConnectorAuthorizationKind.Independent,
    });
    public readonly fileRequest: ConnectorFileRead = AuthorizedOperationFixture.#read();
    public readonly executionRequest: ExecutionRequest = ExecutionJobsCodec.request({
        requestId: 'command-original',
        policySha256: 'b'.repeat(64),
        programId: 'tool',
        rootId: 'command-project',
        arguments: ['payload.bin'],
    });
    public readonly leaseId: string = Buffer.alloc(32).toString('base64url');
    public readonly dispatchId: string = Buffer.alloc(32, 1).toString('base64url');

    static #read(): ConnectorFileRead {
        const request: ConnectorFileOperation = ConnectorFileJobsCodec.operation({
            action: ConnectorFileAction.Read,
            requestId: 'read-original',
            policySha256: 'a'.repeat(64),
            rootId: 'file-project',
            path: 'payload.bin',
            offset: '9007199254740993',
            limit: 32768,
        });
        if (request.action !== ConnectorFileAction.Read) {
            throw new Error('Canonical read fixture required');
        }
        return request;
    }

    public filePermit(
        authorization: ConnectorAuthorization = this.authorization,
    ): ConnectorFilePermit {
        const requestHash: string = ConnectorFileProof.digest(
            ConnectorFileJobsCodec.encode(this.fileRequest),
        );
        const body: Omit<ConnectorFilePermit, 'signature'> = {
            authorityId: this.scope.authorityId,
            enrollmentId: this.scope.enrollmentId,
            leaseId: this.leaseId,
            jobId: 'file-original',
            sequence: 9007199254740993n,
            dispatchId: this.dispatchId,
            requestHash,
            admissionHash: ConnectorAuthorizationProof.file(requestHash, authorization),
            authorization,
            request: this.fileRequest,
            issuedAtMs: 1000n,
            expiresAtMs: 11000n,
        };
        return {
            ...body,
            signature: this.authority.sign(
                SignaturePurpose.OperationFilePermit,
                ConnectorFileProof.permit(body),
            ),
        };
    }

    public executionPermit(
        lane: ExecutionLane = ExecutionLane.First,
        authorization: ConnectorAuthorization = this.authorization,
    ): ExecutionPermit {
        const requestHash: string = ExecutionProof.requestHash(this.executionRequest);
        const body: Omit<ExecutionPermit, 'signature'> = {
            authorityId: this.scope.authorityId,
            environmentId: this.scope.environmentId,
            enrollmentId: this.scope.enrollmentId,
            leaseId: this.leaseId,
            lane,
            jobId: 'command-original',
            sequence: 9007199254740993n,
            dispatchId: this.dispatchId,
            requestHash,
            authorization,
            admissionHash: ConnectorAuthorizationProof.execution(requestHash, lane, authorization),
            request: this.executionRequest,
            issuedAtMs: 1000n,
            expiresAtMs: 11000n,
            executionDeadlineMs: 31000n,
        };
        return {
            ...body,
            signature: this.authority.sign(
                SignaturePurpose.OperationExecutionPermit,
                ExecutionProof.permit(body),
            ),
        };
    }

    public cancellation(permit: ExecutionPermit = this.executionPermit()): ExecutionCancellation {
        const body: Omit<ExecutionCancellation, 'signature'> = {
            authorityId: permit.authorityId,
            environmentId: permit.environmentId,
            enrollmentId: permit.enrollmentId,
            leaseId: permit.leaseId,
            lane: permit.lane,
            jobId: permit.jobId,
            sequence: permit.sequence,
            dispatchId: permit.dispatchId,
            requestHash: permit.requestHash,
            authorization: permit.authorization,
            admissionHash: permit.admissionHash,
            request: permit.request,
            issuedAtMs: permit.issuedAtMs,
            expiresAtMs: permit.expiresAtMs,
        };
        return {
            ...body,
            signature: this.authority.sign(
                SignaturePurpose.OperationExecutionCancellation,
                ExecutionProof.cancellation(body),
            ),
        };
    }

    public fileCompletion(
        permit: ConnectorFilePermit = this.filePermit(),
    ): ConnectorFileCompletion {
        const body: Omit<ConnectorFileCompletion, 'signature'> = {
            enrollmentId: permit.enrollmentId,
            leaseId: permit.leaseId,
            jobId: permit.jobId,
            sequence: permit.sequence,
            dispatchId: permit.dispatchId,
            requestHash: permit.requestHash,
            admissionHash: permit.admissionHash,
            response: { ok: false, error: ConnectorFileFailure.Unavailable },
            responseHash: '',
        };
        const original: Omit<ConnectorFileCompletion, 'signature'> = {
            ...body,
            responseHash: ConnectorFileProof.responseHash(body.response),
        };
        return {
            ...original,
            signature: this.device.sign(
                SignaturePurpose.OperationFileResult,
                ConnectorFileProof.completion(original),
            ),
        };
    }

    public fileAcknowledgment(
        completion: ConnectorFileCompletion = this.fileCompletion(),
    ): ConnectorFileAcknowledgment {
        const body: Omit<ConnectorFileAcknowledgment, 'signature'> = {
            authorityId: this.scope.authorityId,
            enrollmentId: completion.enrollmentId,
            leaseId: completion.leaseId,
            jobId: completion.jobId,
            sequence: completion.sequence,
            dispatchId: completion.dispatchId,
            requestHash: completion.requestHash,
            admissionHash: completion.admissionHash,
            responseHash: completion.responseHash,
        };
        return {
            ...body,
            signature: this.authority.sign(
                SignaturePurpose.OperationFileAcknowledgment,
                ConnectorFileProof.acknowledgment(body),
            ),
        };
    }

    public fileAcknowledged(
        completion: ConnectorFileCompletion = this.fileCompletion(),
    ): ConnectorFileAcknowledged {
        const body: Omit<ConnectorFileAcknowledged, 'signature'> = {
            enrollmentId: completion.enrollmentId,
            leaseId: completion.leaseId,
            jobId: completion.jobId,
            sequence: completion.sequence,
            dispatchId: completion.dispatchId,
            requestHash: completion.requestHash,
            admissionHash: completion.admissionHash,
            responseHash: completion.responseHash,
        };
        return {
            ...body,
            signature: this.device.sign(
                SignaturePurpose.OperationFileAcknowledged,
                ConnectorFileProof.acknowledged(body),
            ),
        };
    }

    public executionCompletion(
        permit: ExecutionPermit = this.executionPermit(),
    ): ExecutionCompletion {
        const body: Omit<ExecutionCompletion, 'signature'> = {
            environmentId: permit.environmentId,
            enrollmentId: permit.enrollmentId,
            leaseId: permit.leaseId,
            lane: permit.lane,
            jobId: permit.jobId,
            sequence: permit.sequence,
            dispatchId: permit.dispatchId,
            requestHash: permit.requestHash,
            admissionHash: permit.admissionHash,
            responseHash: '',
            response: {
                setupFailure: null,
                termination: ExecutionTermination.Exited,
                failure: null,
                exitCode: 0,
                stdoutBase64: 'AP8=',
                stderrBase64: '',
            },
        };
        const original: Omit<ExecutionCompletion, 'signature'> = {
            ...body,
            responseHash: ExecutionProof.responseHash(body.response),
        };
        return {
            ...original,
            signature: this.device.sign(
                SignaturePurpose.OperationExecutionResult,
                ExecutionProof.completion(original),
            ),
        };
    }

    public executionAcknowledgment(
        completion: ExecutionCompletion = this.executionCompletion(),
    ): ExecutionAcknowledgment {
        const body: Omit<ExecutionAcknowledgment, 'signature'> = {
            authorityId: this.scope.authorityId,
            environmentId: completion.environmentId,
            enrollmentId: completion.enrollmentId,
            leaseId: completion.leaseId,
            lane: completion.lane,
            jobId: completion.jobId,
            sequence: completion.sequence,
            dispatchId: completion.dispatchId,
            requestHash: completion.requestHash,
            admissionHash: completion.admissionHash,
            responseHash: completion.responseHash,
        };
        return {
            ...body,
            signature: this.authority.sign(
                SignaturePurpose.OperationExecutionAcknowledgment,
                ExecutionProof.acknowledgment(body),
            ),
        };
    }

    public executionAcknowledged(
        completion: ExecutionCompletion = this.executionCompletion(),
    ): ExecutionAcknowledged {
        const body: Omit<ExecutionAcknowledged, 'signature'> = {
            environmentId: completion.environmentId,
            enrollmentId: completion.enrollmentId,
            leaseId: completion.leaseId,
            lane: completion.lane,
            jobId: completion.jobId,
            sequence: completion.sequence,
            dispatchId: completion.dispatchId,
            requestHash: completion.requestHash,
            admissionHash: completion.admissionHash,
            responseHash: completion.responseHash,
        };
        return {
            ...body,
            signature: this.device.sign(
                SignaturePurpose.OperationExecutionAcknowledged,
                ExecutionProof.acknowledged(body),
            ),
        };
    }

    public output(permit: ExecutionPermit = this.executionPermit()): ExecutionOutputUpdate {
        const body: Omit<ExecutionOutputUpdate, 'signature'> = {
            environmentId: permit.environmentId,
            enrollmentId: permit.enrollmentId,
            leaseId: permit.leaseId,
            lane: permit.lane,
            jobId: permit.jobId,
            sequence: permit.sequence,
            dispatchId: permit.dispatchId,
            requestHash: permit.requestHash,
            admissionHash: permit.admissionHash,
            output: { stdoutBase64: 'AP8=', stderrBase64: '' },
            outputHash: ExecutionProof.outputHash({ stdoutBase64: 'AP8=', stderrBase64: '' }),
        };
        return {
            ...body,
            signature: this.device.sign(
                SignaturePurpose.OperationExecutionOutput,
                ExecutionProof.output(body),
            ),
        };
    }

    public outputAck(update: ExecutionOutputUpdate = this.output()): ExecutionOutputAck {
        const body: Omit<ExecutionOutputAck, 'signature'> = {
            authorityId: this.scope.authorityId,
            environmentId: update.environmentId,
            enrollmentId: update.enrollmentId,
            leaseId: update.leaseId,
            lane: update.lane,
            jobId: update.jobId,
            sequence: update.sequence,
            dispatchId: update.dispatchId,
            requestHash: update.requestHash,
            admissionHash: update.admissionHash,
            outputHash: update.outputHash,
        };
        return {
            ...body,
            signature: this.authority.sign(
                SignaturePurpose.OperationExecutionOutputAck,
                ExecutionProof.outputAck(body),
            ),
        };
    }
}
