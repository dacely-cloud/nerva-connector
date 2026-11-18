// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

import { ConnectorAuthorizationKind } from 'nerva-connector-protocol/protocol/ConnectorAuthorization.js';
import { ConnectorAuthorizationProof } from 'nerva-connector-protocol/protocol/ConnectorAuthorizationProof.js';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, chmod, stat } from 'node:fs/promises';
import { expect, it, vi, type MockInstance } from 'vitest';
import { SigningKey } from '../src/identity/SigningKey.js';
import {
    SignaturePurpose,
    SignatureSuite,
    KeyDerivationPurpose,
} from 'nerva-connector-protocol/identity/IdentityFormat.js';
import {
    ConnectorClientConfiguration,
    type ConnectorClientIdentity,
} from '../src/runtime/ConnectorClientConfiguration.js';
import { ConnectorClientFiles } from '../src/runtime/ConnectorClientFiles.js';
import { ConnectorOperationJournal } from '../src/runtime/ConnectorOperationJournal.js';
import { ConnectorFilesystem } from '../src/runtime/ConnectorFilesystem.js';
import { ConnectorFileJournalCodec } from '../src/runtime/ConnectorFileJournalCodec.js';
import { ConnectorFileProof } from 'nerva-connector-protocol/protocol/ConnectorFileProof.js';
import { ConnectorFileJobsCodec } from 'nerva-connector-protocol/protocol/ConnectorFileJobsCodec.js';
import { ConnectorUploadCodec } from 'nerva-connector-protocol/protocol/ConnectorUploadCodec.js';
import type {
    ConnectorFilePermit,
    ConnectorFileOperation,
    ConnectorFileCompletion,
} from 'nerva-connector-protocol/protocol/ConnectorFileJobs.js';
import {
    ConnectorFileMode,
    ConnectorFileFailure,
    ConnectorFilePermissionMode,
    type ConnectorFileResponse,
} from 'nerva-connector-protocol/protocol/ConnectorFiles.js';
import {
    ConnectorFileAction,
    ConnectorWriteMode,
} from 'nerva-connector-protocol/protocol/ConnectorFileTypes.js';

const helper: string | undefined = process.env['NERVA_CONNECTOR_FILES_HELPER'];

interface RecoveryCase {
    readonly action:
        | ConnectorFileAction.Write
        | ConnectorFileAction.Remove
        | ConnectorFileAction.Mkdir
        | ConnectorFileAction.Chmod
        | ConnectorFileAction.Rename
        | ConnectorFileAction.UploadBegin
        | ConnectorFileAction.UploadChunk
        | ConnectorFileAction.UploadStatus
        | ConnectorFileAction.UploadCommit
        | ConnectorFileAction.UploadAbort;
    readonly retainedResult: boolean;
}
const cases: readonly RecoveryCase[] = [false, true].flatMap(
    (retainedResult: boolean): readonly RecoveryCase[] => [
        { action: ConnectorFileAction.Write, retainedResult },
        { action: ConnectorFileAction.Remove, retainedResult },
        { action: ConnectorFileAction.Mkdir, retainedResult },
        { action: ConnectorFileAction.Chmod, retainedResult },
        { action: ConnectorFileAction.Rename, retainedResult },
        { action: ConnectorFileAction.UploadBegin, retainedResult },
        { action: ConnectorFileAction.UploadChunk, retainedResult },
        { action: ConnectorFileAction.UploadStatus, retainedResult },
        { action: ConnectorFileAction.UploadCommit, retainedResult },
        { action: ConnectorFileAction.UploadAbort, retainedResult },
    ],
);
it.skipIf(helper === undefined).each(cases)(
    'durable started $action recovers without another effect; retained result exists: $retainedResult',
    async ({ action, retainedResult }: RecoveryCase): Promise<void> => {
        if (helper === undefined) {
            throw new Error('Explicit native helper required');
        }
        const directory: string = await mkdtemp(join(homedir(), '.nerva-write-recovery-'));
        using device: SigningKey = SigningKey.generate();
        using authority: SigningKey = SigningKey.generate();
        using loaded: DisposableStack = new DisposableStack();
        try {
            const root: string = join(directory, 'project');
            const staging: string = join(directory, 'staging');
            const state: string = join(directory, 'state');
            for (const path of [root, staging, state]) {
                await mkdir(path, { mode: 0o700 });
            }
            const policy: string = join(directory, 'policy.json');
            const configuration: string = join(directory, 'device.json');
            const privateKey: string = join(directory, 'device-key.json');
            const pin: string = join(directory, 'authority.json');
            const secret: Buffer = device.encode();
            try {
                await writeFile(privateKey, secret, { mode: 0o600 });
            } finally {
                secret.fill(0);
            }
            await writeFile(
                pin,
                JSON.stringify({
                    suite: SignatureSuite.MlDsa44Ed25519,
                    publicKey: authority.publicKey,
                }),
                { mode: 0o600 },
            );
            await writeFile(
                policy,
                JSON.stringify({
                    mode: ConnectorFileMode.ReadWrite,
                    revision: '1',
                    helperFile: helper,
                    helperSha256: createHash('sha256')
                        .update(await readFile(helper))
                        .digest('hex'),
                    roots: [{ id: 'project', path: root, stagingPath: staging }],
                }),
                { mode: 0o600 },
            );
            await writeFile(
                configuration,
                JSON.stringify({
                    authorityId: 'authority',
                    authorityPublicKeyFile: pin,
                    enrollmentId: 'conn_' + 'a'.repeat(64),
                    environmentId: 'env_connector_' + 'a'.repeat(64),
                    slot: 0,
                    endpoints: ['wss://connector.example.invalid/v1/connector/tunnel'],
                    privateKeyFile: privateKey,
                    serverCaFile: null,
                    files: { policyFile: policy, stateDirectory: state },
                    execution: null,
                }),
                { mode: 0o600 },
            );
            const identity: ConnectorClientIdentity =
                await ConnectorClientConfiguration.load(configuration);
            loaded.use(identity.key);
            const exposedExecution: ConnectorClientIdentity = {
                ...identity,
                settings: {
                    ...identity.settings,
                    execution: {
                        policyFile: join(root, 'execution-policy.json'),
                        stateDirectory: join(root, 'execution-state'),
                    },
                },
            };
            await expect(ConnectorClientFiles.initialize(exposedExecution)).rejects.toThrow();
            expect(await readdir(state)).toEqual([]);
            await ConnectorClientFiles.initialize(identity);
            let permit: ConnectorFilePermit;
            let originalResponse: ConnectorFileResponse;
            let stagingId: string;
            if (action !== ConnectorFileAction.Mkdir) {
                await writeFile(join(root, 'result.txt'), 'before');
            }
            if (action === ConnectorFileAction.Rename) {
                await writeFile(join(root, 'moved.txt'), 'previous destination');
            }
            {
                await using filesystem: ConnectorFilesystem = await ConnectorFilesystem.load(
                    policy,
                    [configuration, privateKey, pin, state],
                );
                const uploadBytes: Buffer =
                    action === ConnectorFileAction.UploadChunk
                        ? Buffer.alloc(65536, 0xa5)
                        : Buffer.from('published-once');
                const uploadFields: Readonly<Record<string, string>> = {
                    uploadId: 'e'.repeat(64),
                    mode: ConnectorWriteMode.Replace,
                    sizeBytes: uploadBytes.byteLength.toString(),
                    sha256: createHash('sha256').update(uploadBytes).digest('hex'),
                };
                if (
                    ConnectorUploadCodec.isAction(action) &&
                    action !== ConnectorFileAction.UploadBegin
                ) {
                    const original: Readonly<Record<string, string>> = {
                        requestId: 'prepare-upload',
                        policySha256: filesystem.profile.policySha256,
                        rootId: 'project',
                        path: 'result.txt',
                        ...uploadFields,
                    };
                    expect(
                        (
                            await filesystem.dispatch(
                                JSON.stringify({
                                    ...original,
                                    action: ConnectorFileAction.UploadBegin,
                                }),
                                'a'.repeat(64),
                            )
                        ).ok,
                    ).toBe(true);
                    if (action !== ConnectorFileAction.UploadChunk) {
                        expect(
                            (
                                await filesystem.dispatch(
                                    JSON.stringify({
                                        ...original,
                                        action: ConnectorFileAction.UploadChunk,
                                        offset: '0',
                                        dataBase64: uploadBytes.toString('base64'),
                                    }),
                                    'a'.repeat(64),
                                )
                            ).ok,
                        ).toBe(true);
                    }
                }
                const rawRequest: unknown = JSON.parse(
                    JSON.stringify({
                        requestId: 'original-write',
                        policySha256: filesystem.profile.policySha256,
                        rootId: 'project',
                        path: 'result.txt',
                        ...(action === ConnectorFileAction.Write
                            ? {
                                  action: ConnectorFileAction.Write,
                                  mode: ConnectorWriteMode.Replace,
                                  dataBase64: Buffer.from('published-once').toString('base64'),
                              }
                            : action === ConnectorFileAction.Remove
                              ? { action: ConnectorFileAction.Remove, recursive: false }
                              : action === ConnectorFileAction.Chmod
                                ? {
                                      action: ConnectorFileAction.Chmod,
                                      mode: ConnectorFilePermissionMode.Executable,
                                  }
                                : action === ConnectorFileAction.Rename
                                  ? {
                                        action: ConnectorFileAction.Rename,
                                        destination: 'moved.txt',
                                        mode: ConnectorWriteMode.Replace,
                                    }
                                  : ConnectorUploadCodec.isAction(action)
                                    ? {
                                          action,
                                          ...uploadFields,
                                          ...(action === ConnectorFileAction.UploadChunk
                                              ? {
                                                    offset: '0',
                                                    dataBase64: uploadBytes.toString('base64'),
                                                }
                                              : {}),
                                      }
                                    : { action: ConnectorFileAction.Mkdir }),
                    }),
                );
                const request: ConnectorFileOperation =
                    ConnectorFileJobsCodec.operation(rawRequest);
                const now: bigint = BigInt(Date.now());
                const unsigned: Omit<ConnectorFilePermit, 'signature'> = {
                    authorityId: 'authority',
                    enrollmentId: identity.settings.enrollmentId,
                    leaseId: 'A'.repeat(43),
                    jobId: 'original-job',
                    sequence: 1n,
                    dispatchId: 'B'.repeat(42) + 'A',
                    requestHash: ConnectorFileProof.digest(ConnectorFileJobsCodec.encode(request)),
                    authorization: { kind: ConnectorAuthorizationKind.Independent },
                    admissionHash: ConnectorAuthorizationProof.file(
                        ConnectorFileProof.digest(ConnectorFileJobsCodec.encode(request)),
                        { kind: ConnectorAuthorizationKind.Independent },
                    ),
                    request,
                    issuedAtMs: now,
                    expiresAtMs: now + 10000n,
                };
                permit = {
                    ...unsigned,
                    signature: ConnectorFileProof.sign(
                        authority,
                        SignaturePurpose.OperationFilePermit,
                        ConnectorFileProof.permit(unsigned),
                    ),
                };
                const token: Buffer = identity.key.deriveKey(
                    KeyDerivationPurpose.WriteStaging,
                    Buffer.from(
                        JSON.stringify([permit.jobId, permit.dispatchId, permit.requestHash]),
                    ),
                );
                try {
                    stagingId = token.toString('hex');
                } finally {
                    token.fill(0);
                }
                await using journal: ConnectorOperationJournal<
                    ConnectorFileOperation,
                    ConnectorFileResponse
                > = await ConnectorOperationJournal.load(
                    state,
                    identity.settings.enrollmentId,
                    identity.key,
                    new ConnectorFileJournalCodec(),
                );
                expect(
                    (await journal.begin(permit, await filesystem.effectContext(request.rootId)))
                        .fresh,
                ).toBe(true);
                originalResponse = await filesystem.dispatch(
                    ConnectorFileJobsCodec.encode(request),
                    stagingId,
                );
                expect(originalResponse.ok).toBe(true);
                if (retainedResult) {
                    await journal.finish(permit, originalResponse);
                }
            }
            if (action === ConnectorFileAction.Write) {
                expect(await readFile(join(root, 'result.txt'), 'utf8')).toBe('published-once');
            } else if (action === ConnectorFileAction.Remove) {
                await expect(readFile(join(root, 'result.txt'))).rejects.toMatchObject({
                    code: 'ENOENT',
                });
            } else if (action === ConnectorFileAction.Chmod) {
                expect((await stat(join(root, 'result.txt'))).mode & 0o777).toBe(0o700);
                await chmod(join(root, 'result.txt'), 0o600);
            } else if (action === ConnectorFileAction.Rename) {
                await expect(readFile(join(root, 'result.txt'))).rejects.toMatchObject({
                    code: 'ENOENT',
                });
                expect(await readFile(join(root, 'moved.txt'), 'utf8')).toBe('before');
                await writeFile(join(root, 'moved.txt'), 'changed-destination-after-interruption');
            } else if (ConnectorUploadCodec.isAction(action)) {
                expect(await readFile(join(root, 'result.txt'), 'utf8')).toBe(
                    action === ConnectorFileAction.UploadCommit ? 'published-once' : 'before',
                );
            } else {
                expect(await readdir(join(root, 'result.txt'))).toEqual([]);
                await rm(join(root, 'result.txt'), { recursive: true });
            }
            await writeFile(join(root, 'result.txt'), 'changed-after-the-interruption');
            if (action === ConnectorFileAction.Write) {
                await writeFile(join(staging, 'write-' + stagingId), 'partial-original-staging', {
                    mode: 0o600,
                });
            }
            await writeFile(join(staging, 'unrelated'), 'must-remain', { mode: 0o600 });
            const effect: MockInstance<typeof ConnectorFilesystem.prototype.dispatch> = vi.spyOn(
                ConnectorFilesystem.prototype,
                'dispatch',
            );
            try {
                await using recovered: ConnectorClientFiles =
                    await ConnectorClientFiles.load(identity);
                const now: bigint = BigInt(Date.now());
                const renewed: Omit<ConnectorFilePermit, 'signature'> = {
                    ...permit,
                    leaseId: 'C'.repeat(42) + 'A',
                    issuedAtMs: now,
                    expiresAtMs: now + 10000n,
                };
                const current: ConnectorFilePermit = {
                    ...renewed,
                    signature: ConnectorFileProof.sign(
                        authority,
                        SignaturePurpose.OperationFilePermit,
                        ConnectorFileProof.permit(renewed),
                    ),
                };
                const result: ConnectorFileCompletion = await recovered.execute(
                    current,
                    current.leaseId,
                    current.expiresAtMs,
                );
                expect(result.response).toEqual(
                    retainedResult
                        ? originalResponse
                        : { ok: false, error: ConnectorFileFailure.Indeterminate },
                );
                expect(effect).not.toHaveBeenCalled();
                expect(
                    ConnectorFileProof.verify(
                        SigningKey,
                        device.publicKey,
                        SignaturePurpose.OperationFileResult,
                        ConnectorFileProof.completion(result),
                        result.signature,
                    ),
                ).toBe(true);
            } finally {
                effect.mockRestore();
            }
            expect(await readFile(join(root, 'result.txt'), 'utf8')).toBe(
                'changed-after-the-interruption',
            );
            if (action === ConnectorFileAction.Chmod) {
                expect((await stat(join(root, 'result.txt'))).mode & 0o777).toBe(0o600);
            }
            if (action === ConnectorFileAction.Rename) {
                expect(await readFile(join(root, 'moved.txt'), 'utf8')).toBe(
                    'changed-destination-after-interruption',
                );
            }
            if (
                action === ConnectorFileAction.UploadBegin ||
                action === ConnectorFileAction.UploadChunk ||
                action === ConnectorFileAction.UploadStatus
            ) {
                expect((await readdir(staging)).sort()).toEqual([
                    'unrelated',
                    'upload-data',
                    'upload-metadata',
                ]);
                expect(await readFile(join(staging, 'upload-data'))).toEqual(
                    action === ConnectorFileAction.UploadBegin
                        ? Buffer.alloc(0)
                        : action === ConnectorFileAction.UploadChunk
                          ? Buffer.alloc(65536, 0xa5)
                          : Buffer.from('published-once'),
                );
            } else if (action === ConnectorFileAction.Write && retainedResult) {
                expect((await readdir(staging)).sort()).toEqual([
                    'unrelated',
                    'write-' + stagingId,
                ]);
                expect(await readFile(join(staging, 'write-' + stagingId), 'utf8')).toBe(
                    'partial-original-staging',
                );
            } else {
                expect(await readdir(staging)).toEqual(['unrelated']);
            }
        } finally {
            await rm(directory, { recursive: true, force: true });
        }
    },
);
