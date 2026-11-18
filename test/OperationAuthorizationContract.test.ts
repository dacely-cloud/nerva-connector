// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

import { expect, it } from 'vitest';
import { SigningKey } from '../src/identity/SigningKey.js';
import { SignaturePurpose } from 'nerva-connector-protocol/identity/IdentityFormat.js';
import { Boundary } from 'nerva-connector-protocol/protocol/Boundary.js';
import {
    ConnectorAuthorizationKind,
    type ConnectorAuthorization,
} from 'nerva-connector-protocol/protocol/ConnectorAuthorization.js';
import { ConnectorAuthorizationProof } from 'nerva-connector-protocol/protocol/ConnectorAuthorizationProof.js';
import { ConnectorFileJobsCodec } from 'nerva-connector-protocol/protocol/ConnectorFileJobsCodec.js';
import type {
    ConnectorFilePermit,
    ConnectorFileCompletion,
    ConnectorFileAcknowledgment,
    ConnectorFileAcknowledged,
} from 'nerva-connector-protocol/protocol/ConnectorFileJobs.js';
import { ConnectorFileProof } from 'nerva-connector-protocol/protocol/ConnectorFileProof.js';
import { ExecutionJobsCodec } from '../src/execution/ExecutionJobsCodec.js';
import {
    type ExecutionPermit,
    type ExecutionCancellation,
    type ExecutionCompletion,
    type ExecutionAcknowledgment,
    type ExecutionAcknowledged,
} from 'nerva-connector-protocol/execution/ExecutionJobs.js';
import { ExecutionLane } from 'nerva-connector-protocol/execution/ExecutionLane.js';
import { ExecutionProof } from 'nerva-connector-protocol/execution/ExecutionProof.js';
import { JointWorkspaceProof } from 'nerva-connector-protocol/workspace/JointWorkspaceProof.js';
import { AuthorizedOperationFixture } from './support/AuthorizedOperationFixture.js';

type AuthorizedWireValue =
    | ConnectorFilePermit
    | ConnectorFileCompletion
    | ConnectorFileAcknowledgment
    | ConnectorFileAcknowledged
    | ExecutionPermit
    | ExecutionCancellation
    | ExecutionCompletion
    | ExecutionAcknowledgment
    | ExecutionAcknowledged;
interface AuthorizedWireCase {
    readonly value: AuthorizedWireValue;
    readonly decode: (raw: unknown) => AuthorizedWireValue;
}

/** External wire values are immediately narrowed; request serialization is deliberately outside authorization metadata. */
class AuthorizedWire {
    public static record(value: AuthorizedWireValue): Readonly<Record<string, unknown>> {
        const raw: unknown = JSON.parse(
            JSON.stringify(value, (_key: string, entry: unknown): unknown =>
                typeof entry === 'bigint' ? entry.toString() : entry,
            ),
        );
        return Boundary.record(raw, Object.keys(value));
    }
}

it('preserves frozen original request bytes/hashes while binding explicit independent or joint authority outside them', (): void => {
    using fixture: AuthorizedOperationFixture = new AuthorizedOperationFixture();
    const file: ConnectorFilePermit = fixture.filePermit();
    const execution: ExecutionPermit = fixture.executionPermit();
    expect(file.requestHash).toBe(
        '4b39ce30309534c66c506e97406a5adacd53f804cf65ae3ff658c4ad7437c8d2',
    );
    expect(execution.requestHash).toBe(
        '65d28dcf75b2184b46a5326a71a3b32e3177736961b3c9bf90bbcc48122ac23f',
    );
    const independentFile: ConnectorFilePermit = fixture.filePermit(fixture.independent);
    const independentExecution: ExecutionPermit = fixture.executionPermit(
        ExecutionLane.First,
        fixture.independent,
    );
    expect(independentFile.requestHash).toBe(file.requestHash);
    expect(independentExecution.requestHash).toBe(execution.requestHash);
    expect(independentFile.admissionHash).not.toBe(file.admissionHash);
    expect(independentExecution.admissionHash).not.toBe(execution.admissionHash);
    expect(ConnectorFileJobsCodec.encode(independentFile.request)).toBe(
        ConnectorFileJobsCodec.encode(file.request),
    );
    expect(ExecutionJobsCodec.encode(independentExecution.request)).toBe(
        ExecutionJobsCodec.encode(execution.request),
    );
    expect(fixture.executionPermit(ExecutionLane.Second).admissionHash).not.toBe(
        execution.admissionHash,
    );
    expect(ConnectorAuthorizationProof.file(execution.requestHash, fixture.authorization)).not.toBe(
        execution.admissionHash,
    );
});

it('normal permits and cancellations require both explicit full authorization and a canonical admission commitment', (): void => {
    using fixture: AuthorizedOperationFixture = new AuthorizedOperationFixture();
    const values: readonly AuthorizedWireCase[] = [
        {
            value: fixture.filePermit(),
            decode: (raw: unknown): ConnectorFilePermit => ConnectorFileJobsCodec.permit(raw),
        },
        {
            value: fixture.executionPermit(),
            decode: (raw: unknown): ExecutionPermit => ExecutionJobsCodec.permit(raw),
        },
        {
            value: fixture.cancellation(),
            decode: (raw: unknown): ExecutionCancellation => ExecutionJobsCodec.cancellation(raw),
        },
    ];
    for (const current of values) {
        const raw: Readonly<Record<string, unknown>> = AuthorizedWire.record(current.value);
        expect(current.decode(raw)).toEqual(current.value);
        for (const field of ['authorization', 'admissionHash']) {
            const missing: Record<string, unknown> = { ...raw };
            Reflect.deleteProperty(missing, field);
            expect((): AuthorizedWireValue => current.decode(missing)).toThrow();
        }
        for (const admissionHash of ['', 'A'.repeat(64), 'f'.repeat(63)]) {
            expect((): AuthorizedWireValue => current.decode({ ...raw, admissionHash })).toThrow();
        }
        expect((): AuthorizedWireValue => current.decode({ ...raw, authorization: {} })).toThrow();
    }
});

it('all terminal result, acknowledgment and compaction envelopes require admissionHash without repeating full authorization', (): void => {
    using fixture: AuthorizedOperationFixture = new AuthorizedOperationFixture();
    const values: readonly AuthorizedWireCase[] = [
        {
            value: fixture.fileCompletion(),
            decode: (raw: unknown): ConnectorFileCompletion =>
                ConnectorFileJobsCodec.completion(raw, fixture.fileRequest),
        },
        {
            value: fixture.fileAcknowledgment(),
            decode: (raw: unknown): ConnectorFileAcknowledgment =>
                ConnectorFileJobsCodec.acknowledgment(raw),
        },
        {
            value: fixture.fileAcknowledged(),
            decode: (raw: unknown): ConnectorFileAcknowledged =>
                ConnectorFileJobsCodec.acknowledged(raw),
        },
        {
            value: fixture.executionCompletion(),
            decode: (raw: unknown): ExecutionCompletion => ExecutionJobsCodec.completion(raw),
        },
        {
            value: fixture.executionAcknowledgment(),
            decode: (raw: unknown): ExecutionAcknowledgment =>
                ExecutionJobsCodec.acknowledgment(raw),
        },
        {
            value: fixture.executionAcknowledged(),
            decode: (raw: unknown): ExecutionAcknowledged => ExecutionJobsCodec.acknowledged(raw),
        },
    ];
    for (const current of values) {
        const raw: Readonly<Record<string, unknown>> = AuthorizedWire.record(current.value);
        expect(current.decode(raw)).toEqual(current.value);
        const missing: Record<string, unknown> = { ...raw };
        Reflect.deleteProperty(missing, 'admissionHash');
        expect((): AuthorizedWireValue => current.decode(missing)).toThrow();
        expect((): AuthorizedWireValue =>
            current.decode({ ...raw, authorization: fixture.authorization }),
        ).toThrow();
    }
});

it('the stable semantic admission hash cannot authorize swapping a separately valid randomized descriptor proof inside a signed permit or cancellation', (): void => {
    using fixture: AuthorizedOperationFixture = new AuthorizedOperationFixture();
    const authorization: ConnectorAuthorization = {
        kind: ConnectorAuthorizationKind.Joint,
        binding: JointWorkspaceProof.sign(fixture.device, fixture.descriptor.binding),
    };
    expect(authorization.binding.signature).not.toBe(fixture.descriptor.signature);
    expect(JointWorkspaceProof.verify(SigningKey, fixture.expected, authorization.binding)).toBe(
        true,
    );
    const file: ConnectorFilePermit = fixture.filePermit();
    expect(ConnectorAuthorizationProof.file(file.requestHash, authorization)).toBe(
        file.admissionHash,
    );
    expect(
        SigningKey.verify(
            SignaturePurpose.OperationFilePermit,
            fixture.authority.publicKey,
            ConnectorFileProof.permit(file),
            file.signature,
        ),
    ).toBe(true);
    expect(
        SigningKey.verify(
            SignaturePurpose.OperationFilePermit,
            fixture.authority.publicKey,
            ConnectorFileProof.permit({ ...file, authorization }),
            file.signature,
        ),
    ).toBe(false);
    for (const lane of Object.values(ExecutionLane)) {
        const permit: ExecutionPermit = fixture.executionPermit(lane);
        const cancellation: ExecutionCancellation = fixture.cancellation(permit);
        expect(ConnectorAuthorizationProof.execution(permit.requestHash, lane, authorization)).toBe(
            permit.admissionHash,
        );
        expect(
            SigningKey.verify(
                SignaturePurpose.OperationExecutionPermit,
                fixture.authority.publicKey,
                ExecutionProof.permit(permit),
                permit.signature,
            ),
        ).toBe(true);
        expect(
            SigningKey.verify(
                SignaturePurpose.OperationExecutionPermit,
                fixture.authority.publicKey,
                ExecutionProof.permit({ ...permit, authorization }),
                permit.signature,
            ),
        ).toBe(false);
        expect(
            SigningKey.verify(
                SignaturePurpose.OperationExecutionCancellation,
                fixture.authority.publicKey,
                ExecutionProof.cancellation(cancellation),
                cancellation.signature,
            ),
        ).toBe(true);
        expect(
            SigningKey.verify(
                SignaturePurpose.OperationExecutionCancellation,
                fixture.authority.publicKey,
                ExecutionProof.cancellation({ ...cancellation, authorization }),
                cancellation.signature,
            ),
        ).toBe(false);
    }
});

it('new semantic purposes and every downstream proof bind admissionHash while profiles keep their unchanged purpose', (): void => {
    using fixture: AuthorizedOperationFixture = new AuthorizedOperationFixture();
    const completion: ConnectorFileCompletion = fixture.fileCompletion();
    expect(
        SigningKey.verify(
            SignaturePurpose.OperationFileResult,
            fixture.device.publicKey,
            ConnectorFileProof.completion(completion),
            completion.signature,
        ),
    ).toBe(true);
    expect(
        SigningKey.verify(
            SignaturePurpose.OperationFileResult,
            fixture.device.publicKey,
            ConnectorFileProof.completion({ ...completion, admissionHash: 'f'.repeat(64) }),
            completion.signature,
        ),
    ).toBe(false);
    const command: ExecutionCompletion = fixture.executionCompletion();
    expect(
        SigningKey.verify(
            SignaturePurpose.OperationExecutionResult,
            fixture.device.publicKey,
            ExecutionProof.completion(command),
            command.signature,
        ),
    ).toBe(true);
    expect(
        SigningKey.verify(
            SignaturePurpose.OperationExecutionResult,
            fixture.device.publicKey,
            ExecutionProof.completion({ ...command, admissionHash: 'f'.repeat(64) }),
            command.signature,
        ),
    ).toBe(false);
    for (const old of [
        'authority:files:permit',
        'device:files:result',
        'authority:execution:permit',
        'authority:execution:cancel',
        'device:execution:output',
    ]) {
        expect(
            Object.values(SignaturePurpose).some(
                (purpose: SignaturePurpose): boolean => purpose.valueOf() === old,
            ),
        ).toBe(false);
    }
    expect(SignaturePurpose.FileProfile).toBe('device:files:profile');
    expect(SignaturePurpose.ExecutionProfile).toBe('device:execution:profile');
});
