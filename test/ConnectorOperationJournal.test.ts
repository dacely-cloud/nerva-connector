// SPDX-FileCopyrightText: 2026 Dacely <business@dacely.com>
// SPDX-License-Identifier: LicenseRef-Proprietary

import {
    ConnectorAuthorizationKind,
    type ConnectorAuthorization,
} from 'nerva-connector-protocol/protocol/ConnectorAuthorization.js';
import { ConnectorAuthorizationProof } from 'nerva-connector-protocol/protocol/ConnectorAuthorizationProof.js';
import { JournalEffectFixture } from './support/JournalEffectFixture.js';
import { SigningKey } from '../src/identity/SigningKey.js';
import { IdentityLengths } from 'nerva-connector-protocol/identity/IdentityFormat.js';
import { mkdtemp, readFile, rm, writeFile, copyFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { it, expect } from 'vitest';
import {
    ConnectorOperationJournal,
    type ConnectorJournalClaim,
} from '../src/runtime/ConnectorOperationJournal.js';
import { ConnectorFileJournalCodec } from '../src/runtime/ConnectorFileJournalCodec.js';
import type { ExecutionOutput } from 'nerva-connector-protocol/execution/ExecutionOutput.js';
import { ExecutionJournalCodec } from '../src/execution/ExecutionJournalCodec.js';
import { ExecutionLane } from 'nerva-connector-protocol/execution/ExecutionLane.js';
import type { ExecutionRequest } from 'nerva-connector-protocol/execution/ExecutionJobs.js';
import type { ExecutionResult } from 'nerva-connector-protocol/execution/ExecutionTypes.js';
import { ConnectorFileProof } from 'nerva-connector-protocol/protocol/ConnectorFileProof.js';
import { ConnectorFileJobsCodec } from 'nerva-connector-protocol/protocol/ConnectorFileJobsCodec.js';
import type {
    ConnectorFileOperation,
    ConnectorFilePermit,
    ConnectorFileAcknowledgment,
} from 'nerva-connector-protocol/protocol/ConnectorFileJobs.js';
import {
    ConnectorFileFailure,
    type ConnectorFileResponse,
} from 'nerva-connector-protocol/protocol/ConnectorFiles.js';
import { ConnectorFileKind } from 'nerva-connector-protocol/protocol/ConnectorFileTypes.js';
import { ConnectorFileAction } from 'nerva-connector-protocol/protocol/ConnectorFileTypes.js';

class JournalFixture implements AsyncDisposable {
    public readonly enrollmentId: string = 'conn_' + 'a'.repeat(64);
    public readonly key: SigningKey = SigningKey.generate();
    private constructor(public readonly directory: string) {}
    public static async create(): Promise<JournalFixture> {
        return new JournalFixture(await mkdtemp(join(homedir(), '.nerva-journal-test-')));
    }
    public permit(sequence: bigint = 1n): ConnectorFilePermit {
        const request: ConnectorFileOperation = {
            action: ConnectorFileAction.Read,
            requestId: 'read-' + sequence.toString(),
            rootId: 'project',
            policySha256: 'a'.repeat(64),
            path: 'README.md',
            offset: 0n,
            limit: 32768,
        };
        const authorization: ConnectorAuthorization = {
            kind: ConnectorAuthorizationKind.Independent,
        };
        const requestHash: string = ConnectorFileProof.digest(
            ConnectorFileJobsCodec.encode(
                ConnectorFileJobsCodec.operation(
                    JSON.parse(ConnectorFileJobsCodec.encode(request)),
                ),
            ),
        );
        return {
            authorityId: 'authority',
            enrollmentId: this.enrollmentId,
            leaseId: 'A'.repeat(43),
            jobId: 'job-' + sequence.toString(),
            sequence,
            dispatchId: 'B'.repeat(42) + 'A',
            requestHash,
            authorization,
            admissionHash: ConnectorAuthorizationProof.file(requestHash, authorization),
            request,
            issuedAtMs: 1000n,
            expiresAtMs: 11000n,
            signature: Buffer.alloc(IdentityLengths.signature).toString('base64url'),
        };
    }
    public ack(
        permit: ConnectorFilePermit,
        response: ConnectorFileResponse,
    ): ConnectorFileAcknowledgment {
        return {
            authorityId: permit.authorityId,
            enrollmentId: permit.enrollmentId,
            leaseId: permit.leaseId,
            jobId: permit.jobId,
            sequence: permit.sequence,
            dispatchId: permit.dispatchId,
            requestHash: permit.requestHash,
            admissionHash: permit.admissionHash,
            responseHash: ConnectorFileProof.responseHash(response),
            signature: Buffer.alloc(IdentityLengths.signature).toString('base64url'),
        };
    }
    public async initialize(): Promise<void> {
        await ConnectorOperationJournal.initialize(
            this.directory,
            this.enrollmentId,
            this.key,
            new ConnectorFileJournalCodec(),
        );
    }
    public async load(
        key: SigningKey = this.key,
    ): Promise<ConnectorOperationJournal<ConnectorFileOperation, ConnectorFileResponse>> {
        return await ConnectorOperationJournal.load(
            this.directory,
            this.enrollmentId,
            key,
            new ConnectorFileJournalCodec(),
        );
    }
    public async [Symbol.asyncDispose](): Promise<void> {
        this.key[Symbol.dispose]();
        await rm(this.directory, { recursive: true, force: true });
    }
}

it('existing-only startup, no-overwrite initialization and exclusive process ownership cannot reset a device counter', async (): Promise<void> => {
    await using fixture: JournalFixture = await JournalFixture.create();
    await expect(fixture.load()).rejects.toThrow();
    await fixture.initialize();
    await expect(fixture.initialize()).rejects.toThrow();
    await using journal: ConnectorOperationJournal<ConnectorFileOperation, ConnectorFileResponse> =
        await fixture.load();
    await expect(fixture.load()).rejects.toThrow();
    expect(
        (await journal.begin(fixture.permit(), JournalEffectFixture.file(fixture.permit().request)))
            .fresh,
    ).toBe(true);
    expect(
        (await journal.begin(fixture.permit(), JournalEffectFixture.file(fixture.permit().request)))
            .fresh,
    ).toBe(false);
    await expect(
        journal.begin(
            { ...fixture.permit(), sequence: 2n },
            JournalEffectFixture.file(fixture.permit().request),
        ),
    ).rejects.toThrow();
});

it('file ciphertext and execution history use separate keys, basenames and exclusive ownership', async (): Promise<void> => {
    await using fixture: JournalFixture = await JournalFixture.create();
    await fixture.initialize();
    await ConnectorOperationJournal.initialize(
        fixture.directory,
        fixture.enrollmentId,
        fixture.key,
        new ExecutionJournalCodec(ExecutionLane.First),
    );
    {
        await using files: ConnectorOperationJournal<
            ConnectorFileOperation,
            ConnectorFileResponse
        > = await fixture.load();
        await using execution: ConnectorOperationJournal<
            ExecutionRequest,
            ExecutionResult,
            ExecutionOutput
        > = await ConnectorOperationJournal.load(
            fixture.directory,
            fixture.enrollmentId,
            fixture.key,
            new ExecutionJournalCodec(ExecutionLane.First),
        );
        expect(execution.id).not.toBe(files.id);
        await expect(
            ConnectorOperationJournal.load(
                fixture.directory,
                fixture.enrollmentId,
                fixture.key,
                new ExecutionJournalCodec(ExecutionLane.First),
            ),
        ).rejects.toThrow();
    }
    await copyFile(
        join(fixture.directory, 'file-journal'),
        join(fixture.directory, 'execution-journal'),
    );
    await expect(
        ConnectorOperationJournal.load(
            fixture.directory,
            fixture.enrollmentId,
            fixture.key,
            new ExecutionJournalCodec(ExecutionLane.First),
        ),
    ).rejects.toThrow();
    await using files: ConnectorOperationJournal<ConnectorFileOperation, ConnectorFileResponse> =
        await fixture.load();
    expect(
        (await files.begin(fixture.permit(), JournalEffectFixture.file(fixture.permit().request)))
            .fresh,
    ).toBe(true);
});

it('execution lane ciphertext cannot be adopted under the other lane even with the same device, enrollment and directory', async (): Promise<void> => {
    await using fixture: JournalFixture = await JournalFixture.create();
    await ConnectorOperationJournal.initialize(
        fixture.directory,
        fixture.enrollmentId,
        fixture.key,
        new ExecutionJournalCodec(ExecutionLane.First),
    );
    await expect(
        ConnectorOperationJournal.load(
            fixture.directory,
            fixture.enrollmentId,
            fixture.key,
            new ExecutionJournalCodec(ExecutionLane.Second),
        ),
    ).rejects.toThrow();
    await using original: ConnectorOperationJournal<
        ExecutionRequest,
        ExecutionResult,
        ExecutionOutput
    > = await ConnectorOperationJournal.load(
        fixture.directory,
        fixture.enrollmentId,
        fixture.key,
        new ExecutionJournalCodec(ExecutionLane.First),
    );
    expect(original.id).toMatch(/^[a-f0-9]{64}$/u);
});

it('an original result survives reopen encrypted and a signed acknowledgment compacts it before the next sequence', async (): Promise<void> => {
    await using fixture: JournalFixture = await JournalFixture.create();
    await fixture.initialize();
    const permit: ConnectorFilePermit = fixture.permit();
    const response: ConnectorFileResponse = {
        ok: true,
        result: {
            action: ConnectorFileAction.Read,
            requestId: permit.request.requestId,
            offset: 0n,
            dataBase64: Buffer.from('sensitive-original-content').toString('base64'),
            metadata: {
                kind: ConnectorFileKind.File,
                sizeBytes: 26n,
                modifiedAtNs: 9007199254740993n,
                mode: 0o600,
            },
        },
    };
    {
        await using journal: ConnectorOperationJournal<
            ConnectorFileOperation,
            ConnectorFileResponse
        > = await fixture.load();
        await journal.begin(permit, JournalEffectFixture.file(permit.request));
        await journal.finish(permit, response);
    }
    const encrypted: string = await readFile(join(fixture.directory, 'file-journal'), 'utf8');
    expect(encrypted).not.toContain('sensitive-original-content');
    expect(encrypted).not.toContain('c2Vuc2l0aXZlLW9yaWdpbmFsLWNvbnRlbnQ=');
    expect(encrypted).not.toContain('README.md');
    {
        await using journal: ConnectorOperationJournal<
            ConnectorFileOperation,
            ConnectorFileResponse
        > = await fixture.load();
        const replacement: ConnectorFilePermit = { ...permit, leaseId: 'C'.repeat(42) + 'A' };
        const replay: ConnectorJournalClaim<ConnectorFileOperation, ConnectorFileResponse> =
            await journal.begin(replacement, JournalEffectFixture.file(replacement.request));
        expect(replay.fresh).toBe(false);
        expect(replay.pending.response).toEqual(response);
        const acknowledgment: ConnectorFileAcknowledgment = fixture.ack(permit, response);
        await journal.acknowledge(acknowledgment);
        const replacementAck: ConnectorFileAcknowledgment = {
            ...acknowledgment,
            leaseId: 'C'.repeat(42) + 'A',
        };
        await journal.acknowledge(replacementAck);
        await expect(
            journal.begin(permit, JournalEffectFixture.file(permit.request)),
        ).rejects.toThrow();
    }
    {
        await using journal: ConnectorOperationJournal<
            ConnectorFileOperation,
            ConnectorFileResponse
        > = await fixture.load();
        await journal.acknowledge(fixture.ack(permit, response));
        expect(
            (
                await journal.begin(
                    fixture.permit(2n),
                    JournalEffectFixture.file(fixture.permit(2n).request),
                )
            ).fresh,
        ).toBe(true);
    }
});

it('interrupted Started state survives restart without permitting another read or premature acknowledgment', async (): Promise<void> => {
    await using fixture: JournalFixture = await JournalFixture.create();
    await fixture.initialize();
    const permit: ConnectorFilePermit = fixture.permit();
    {
        await using journal: ConnectorOperationJournal<
            ConnectorFileOperation,
            ConnectorFileResponse
        > = await fixture.load();
        await journal.begin(permit, JournalEffectFixture.file(permit.request));
    }
    await using recovered: ConnectorOperationJournal<
        ConnectorFileOperation,
        ConnectorFileResponse
    > = await fixture.load();
    const replay: ConnectorJournalClaim<ConnectorFileOperation, ConnectorFileResponse> =
        await recovered.begin(permit, JournalEffectFixture.file(permit.request));
    expect(replay.fresh).toBe(false);
    expect(replay.pending.response).toBeNull();
    const response: ConnectorFileResponse = { ok: false, error: ConnectorFileFailure.Unavailable };
    await expect(recovered.acknowledge(fixture.ack(permit, response))).rejects.toThrow();
    await recovered.finish(permit, response);
    await recovered.acknowledge(fixture.ack(permit, response));
});

it('tampering, another identity key and changed original metadata cannot produce a trusted retained result', async (): Promise<void> => {
    await using fixture: JournalFixture = await JournalFixture.create();
    await fixture.initialize();
    using another: SigningKey = SigningKey.generate();
    await expect(fixture.load(another)).rejects.toThrow();
    {
        await using journal: ConnectorOperationJournal<
            ConnectorFileOperation,
            ConnectorFileResponse
        > = await fixture.load();
        const permit: ConnectorFilePermit = fixture.permit();
        await journal.begin(permit, JournalEffectFixture.file(permit.request));
        await expect(
            journal.begin(
                { ...permit, dispatchId: 'D'.repeat(42) + 'A' },
                JournalEffectFixture.file(permit.request),
            ),
        ).rejects.toThrow();
        await expect(
            journal.begin(
                { ...permit, request: { ...permit.request, path: 'secret' } },
                JournalEffectFixture.file(permit.request),
            ),
        ).rejects.toThrow();
        const response: ConnectorFileResponse = { ok: false, error: ConnectorFileFailure.Denied };
        await journal.finish(permit, response);
        await expect(
            journal.finish(permit, { ok: false, error: ConnectorFileFailure.Unavailable }),
        ).rejects.toThrow();
        await expect(
            journal.acknowledge({ ...fixture.ack(permit, response), responseHash: 'b'.repeat(64) }),
        ).rejects.toThrow();
    }
    const path: string = join(fixture.directory, 'file-journal');
    const original: string = await readFile(path, 'utf8');
    await writeFile(path, original.replace('"data":"', '"data":"A'), { mode: 0o600 });
    await expect(fixture.load()).rejects.toThrow();
});
