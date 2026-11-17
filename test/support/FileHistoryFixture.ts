// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
    ConnectorAuthorizationKind,
    type ConnectorAuthorization,
} from 'nerva-connector-protocol/protocol/ConnectorAuthorization.js';
import { ConnectorAuthorizationProof } from '../../src/protocol/ConnectorAuthorizationProof.js';
import { SigningKey } from '../../src/identity/SigningKey.js';
import {
    KeyDerivationPurpose,
    SignatureSuite,
} from 'nerva-connector-protocol/identity/IdentityFormat.js';
import { Boundary } from 'nerva-connector-protocol/protocol/Boundary.js';
import type { ConnectorClientIdentity } from '../../src/runtime/ConnectorClientConfiguration.js';
import type { ConnectorJournalPending } from '../../src/runtime/ConnectorJournalState.js';
import { ConnectorHistoryMigration } from '../../src/runtime/ConnectorHistoryMigration.js';
import { ConnectorJournalStore } from '../../src/runtime/ConnectorJournalStore.js';
import {
    OriginalJournalFixtureCodec,
    type OriginalJournalFixtureSnapshot,
} from './OriginalJournalFixtureCodec.js';
import { ConnectorOperationJournal } from '../../src/runtime/ConnectorOperationJournal.js';
import { ConnectorFileJournalCodec } from '../../src/runtime/ConnectorFileJournalCodec.js';
import { ConnectorFilePolicy } from '../../src/runtime/ConnectorFilePolicy.js';
import type {
    ConnectorFileOperation,
    ConnectorFilePermit,
} from 'nerva-connector-protocol/protocol/ConnectorFileJobs.js';
import { ConnectorFileJobsCodec } from 'nerva-connector-protocol/protocol/ConnectorFileJobsCodec.js';
import { ConnectorFileProof } from '../../src/runtime/ConnectorFileProof.js';
import {
    ConnectorFileMode,
    type ConnectorFileResponse,
} from 'nerva-connector-protocol/protocol/ConnectorFiles.js';
import {
    ConnectorFileAction,
    ConnectorWriteMode,
} from 'nerva-connector-protocol/protocol/ConnectorFileTypes.js';
import { FilesystemFixture } from './FilesystemFixture.js';
import { RuntimeMigrationApprovalFixture } from './RuntimeMigrationApprovalFixture.js';
import type { ConnectorMigrationApproval } from 'nerva-connector-protocol/protocol/ConnectorAdmissionMigration.js';

/** Owns real encrypted original history and native file grants, without a cloud peer or runtime process. */
export class FileHistoryFixture implements AsyncDisposable {
    #originalSourceSha256: string | null = null;

    /** The original encrypted bytes are hashed before the real migration touches them. */
    public get originalSourceSha256(): string {
        if (this.#originalSourceSha256 === null) {
            throw new Error('No original fixture history was written');
        }
        return this.#originalSourceSha256;
    }
    private constructor(
        public readonly files: FilesystemFixture,
        public readonly identity: ConnectorClientIdentity,
        public readonly state: string,
        public readonly policySha256: string,
    ) {}

    /** Explicit fixture setup initializes once; production preparation must never initialize. */
    public static async create(
        mode: ConnectorFileMode = ConnectorFileMode.ReadWrite,
        initialize: boolean = true,
        helperFile: string | null = null,
        parent: string = homedir(),
    ): Promise<FileHistoryFixture> {
        const files: FilesystemFixture = await FilesystemFixture.create(mode, parent);
        const key: SigningKey = SigningKey.generate();
        try {
            if (helperFile !== null) {
                const raw: unknown = JSON.parse(await readFile(files.policy, 'utf8'));
                const policy: Readonly<Record<string, unknown>> = Boundary.record(raw, [
                    'mode',
                    'revision',
                    'helperFile',
                    'helperSha256',
                    'roots',
                ]);
                await writeFile(
                    files.policy,
                    JSON.stringify({
                        ...policy,
                        helperFile,
                        helperSha256: createHash('sha256')
                            .update(await readFile(helperFile))
                            .digest('hex'),
                    }),
                    { mode: 0o600 },
                );
            }
            const state: string = join(files.directory, 'files-history');
            const privateState: string = join(files.directory, 'identity');
            await mkdir(state, { mode: 0o700 });
            await mkdir(privateState, { mode: 0o700 });
            const privateKeyFile: string = join(privateState, 'device-key.json');
            const encoded: Buffer = key.encode();
            try {
                await writeFile(privateKeyFile, encoded, { mode: 0o600 });
            } finally {
                encoded.fill(0);
            }
            const authorityPublicKeyFile: string = join(privateState, 'authority.json');
            await writeFile(
                authorityPublicKeyFile,
                JSON.stringify({ suite: SignatureSuite.MlDsa44Ed25519, publicKey: key.publicKey }),
                {
                    mode: 0o600,
                },
            );
            const configurationFile: string = join(files.directory, 'runtime.json');
            const identity: ConnectorClientIdentity = {
                configurationFile,
                key,
                publicKey: key.publicKey,
                ca: undefined,
                authority: { authorityId: 'authority', publicKey: key.publicKey },
                settings: {
                    authorityId: 'authority',
                    authorityPublicKeyFile,
                    environmentId: 'environment',
                    enrollmentId: 'conn_' + 'a'.repeat(64),
                    slot: 0,
                    endpoints: ['wss://unused.invalid/v1/connector/tunnel'],
                    privateKeyFile,
                    serverCaFile: null,
                    files: { policyFile: files.policy, stateDirectory: state },
                    execution: null,
                },
            };
            await writeFile(configurationFile, JSON.stringify(identity.settings), { mode: 0o600 });
            const fixture: FileHistoryFixture = new FileHistoryFixture(
                files,
                identity,
                state,
                ConnectorFilePolicy.commitment(await ConnectorFilePolicy.load(files.policy)),
            );
            if (initialize) {
                await ConnectorOperationJournal.initialize(
                    state,
                    identity.settings.enrollmentId,
                    key,
                    new ConnectorFileJournalCodec(),
                );
            }
            return fixture;
        } catch (caught: unknown) {
            key[Symbol.dispose]();
            await files[Symbol.asyncDispose]();
            throw caught;
        }
    }

    /** Publicly shaped originals use the exact existing wire hash, not a new preparation protocol. */
    public permit(
        action: ConnectorFileAction.Read | ConnectorFileAction.Write = ConnectorFileAction.Write,
    ): ConnectorFilePermit {
        const request: ConnectorFileOperation =
            action === ConnectorFileAction.Read
                ? {
                      action,
                      requestId: 'read',
                      rootId: 'project',
                      policySha256: this.policySha256,
                      path: 'destination',
                      offset: 0n,
                      limit: 8,
                  }
                : {
                      action,
                      requestId: 'write',
                      rootId: 'project',
                      policySha256: this.policySha256,
                      path: 'destination',
                      mode: ConnectorWriteMode.Replace,
                      dataBase64: Buffer.from('NEW').toString('base64'),
                  };
        return this.operation(request);
    }

    /** The test does not grant execution; a canonical permit identifies only the retained file original. */
    public operation(request: ConnectorFileOperation): ConnectorFilePermit {
        const raw: unknown = JSON.parse(ConnectorFileJobsCodec.encode(request));
        const normalized: ConnectorFileOperation = ConnectorFileJobsCodec.operation(raw);
        const authorization: ConnectorAuthorization = {
            kind: ConnectorAuthorizationKind.Independent,
        };
        const requestHash: string = ConnectorFileProof.digest(
            ConnectorFileJobsCodec.encode(normalized),
        );
        return {
            authorityId: this.identity.authority.authorityId,
            enrollmentId: this.identity.settings.enrollmentId,
            leaseId: 'A'.repeat(43),
            jobId: 'original-job',
            sequence: 1n,
            dispatchId: 'B'.repeat(42) + 'A',
            requestHash,
            authorization,
            admissionHash: ConnectorAuthorizationProof.file(requestHash, authorization),
            request: normalized,
            issuedAtMs: 1n,
            expiresAtMs: 2n,
            signature: '',
        };
    }

    /** Reading the real journal also verifies that preparation released its exclusive kernel lock. */
    public async journal(): Promise<
        ConnectorOperationJournal<ConnectorFileOperation, ConnectorFileResponse>
    > {
        return await ConnectorOperationJournal.load(
            this.state,
            this.identity.settings.enrollmentId,
            this.identity.key,
            new ConnectorFileJournalCodec(),
        );
    }

    /** Fixture-only local history setup never acknowledges or dispatches on behalf of preparation. */
    public async retainOriginal(
        original: ConnectorFilePermit,
        response: ConnectorFileResponse | null = null,
    ): Promise<void> {
        {
            const codec: ConnectorFileJournalCodec = new ConnectorFileJournalCodec();
            await using store: ConnectorJournalStore<
                OriginalJournalFixtureSnapshot<ConnectorFileOperation, ConnectorFileResponse>
            > = await ConnectorJournalStore.open(
                this.state,
                this.identity.settings.enrollmentId,
                this.identity.key,
                codec.purpose,
                new OriginalJournalFixtureCodec(codec),
            );
            const empty: OriginalJournalFixtureSnapshot<
                ConnectorFileOperation,
                ConnectorFileResponse
            > = await store.read();
            if (empty.pending !== null || empty.acknowledgedSequence !== 0n) {
                throw new Error('Original-history fixture requires its fresh idle journal');
            }
            await store.write(
                {
                    ...empty,
                    pending: {
                        jobId: original.jobId,
                        sequence: original.sequence,
                        dispatchId: original.dispatchId,
                        requestHash: original.requestHash,
                        request: original.request,
                        response,
                        progress: null,
                    },
                },
                false,
            );
        }
        this.#originalSourceSha256 = createHash('sha256')
            .update(await readFile(join(this.state, 'file-journal')))
            .digest('hex');
    }

    /** Existing-history preparation uses the actual explicit migration before normal runtime decoding. */
    public async retain(
        original: ConnectorFilePermit,
        response: ConnectorFileResponse | null = null,
    ): Promise<void> {
        await this.retainOriginal(original, response);
        const approval: ConnectorMigrationApproval = await RuntimeMigrationApprovalFixture.prepare(
            this.identity,
        );
        await ConnectorHistoryMigration.run(
            this.identity.configurationFile,
            new AbortController().signal,
            approval,
        );
    }

    /** Reload also proves the previous preparation released its exclusive journal owner. */
    public async pending(): Promise<ConnectorJournalPending<
        ConnectorFileOperation,
        ConnectorFileResponse
    > | null> {
        await using journal: ConnectorOperationJournal<
            ConnectorFileOperation,
            ConnectorFileResponse
        > = await this.journal();
        return journal.pending;
    }

    /** Match the established write staging derivation; raw requests never become filenames. */
    public staged(permit: ConnectorFilePermit): string {
        const material: Buffer = Buffer.from(
            JSON.stringify([permit.jobId, permit.dispatchId, permit.requestHash]),
        );
        const token: Buffer = this.identity.key.deriveKey(
            KeyDerivationPurpose.WriteStaging,
            material,
        );
        try {
            return join(this.files.directory, 'staging', 'write-' + token.toString('hex'));
        } finally {
            token.fill(0);
            material.fill(0);
        }
    }

    /** Keys and task-owned files are released only after every journal/native owner is disposed by the caller. */
    public async [Symbol.asyncDispose](): Promise<void> {
        this.identity.key[Symbol.dispose]();
        await this.files[Symbol.asyncDispose]();
    }
}
