// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

import { randomBytes } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { SignaturePurpose } from 'nerva-connector-protocol/identity/IdentityFormat.js';
import {
    ConnectorAuthorizationKind,
    type ConnectorAuthorization,
} from 'nerva-connector-protocol/protocol/ConnectorAuthorization.js';
import { ConnectorAuthorizationProof } from 'nerva-connector-protocol/protocol/ConnectorAuthorizationProof.js';
import type { ConnectorDeviceLease } from 'nerva-connector-protocol/protocol/ConnectorDevice.js';
import type {
    ConnectorFileOperation,
    ConnectorFilePermit,
} from 'nerva-connector-protocol/protocol/ConnectorFileJobs.js';
import { ConnectorFileJobsCodec } from 'nerva-connector-protocol/protocol/ConnectorFileJobsCodec.js';
import { ConnectorFileMode } from 'nerva-connector-protocol/protocol/ConnectorFiles.js';
import { ConnectorFileAction } from 'nerva-connector-protocol/protocol/ConnectorFileTypes.js';
import type { ConnectorActivitySink } from '../../src/runtime/ConnectorActivity.js';
import { ConnectorClientFiles } from '../../src/runtime/ConnectorClientFiles.js';
import type { ConnectorClientIdentity } from '../../src/runtime/ConnectorClientConfiguration.js';
import { ConnectorFilePolicy } from '../../src/runtime/ConnectorFilePolicy.js';
import { ConnectorFileProof } from 'nerva-connector-protocol/protocol/ConnectorFileProof.js';
import { ConnectorSessionFixture } from './ConnectorSessionFixture.js';
import { FilesystemFixture } from './FilesystemFixture.js';

/** The lease-independent part of a file permit: one exact original that every delivery re-signs unchanged. */
export type ConnectorFileOriginal = Omit<
    ConnectorFilePermit,
    'leaseId' | 'issuedAtMs' | 'expiresAtMs' | 'signature'
>;

/** A read-only file lane owner with generated keys, private roots and the real native helper, for socket-level tests. */
export class ConnectorFileLaneFixture implements AsyncDisposable {
    readonly #owners: Set<ConnectorClientFiles> = new Set();
    private constructor(
        public readonly peer: ConnectorSessionFixture,
        public readonly files: FilesystemFixture,
        public readonly identity: ConnectorClientIdentity,
        public readonly policySha256: string,
    ) {}

    /** Initializes an empty encrypted file journal under a task-owned folder beneath trusted home ancestry. */
    public static async create(): Promise<ConnectorFileLaneFixture> {
        const files: FilesystemFixture = await FilesystemFixture.create(ConnectorFileMode.ReadOnly);
        const peer: ConnectorSessionFixture = new ConnectorSessionFixture();
        try {
            const state: string = join(files.directory, 'files-state');
            const keys: string = join(files.directory, 'identity');
            await mkdir(state, { mode: 0o700 });
            await mkdir(keys, { mode: 0o700 });
            const identity: ConnectorClientIdentity = {
                ...peer.identity,
                configurationFile: join(files.directory, 'device.json'),
                settings: {
                    ...peer.identity.settings,
                    privateKeyFile: join(keys, 'device-key.json'),
                    authorityPublicKeyFile: join(keys, 'authority.json'),
                    files: { policyFile: files.policy, stateDirectory: state },
                },
            };
            await ConnectorClientFiles.initialize(identity);
            return new ConnectorFileLaneFixture(
                peer,
                files,
                identity,
                ConnectorFilePolicy.commitment(await ConnectorFilePolicy.load(files.policy)),
            );
        } catch (caught: unknown) {
            peer[Symbol.dispose]();
            await files[Symbol.asyncDispose]();
            throw caught;
        }
    }

    /**
     * Opens the file owner a connection serves; fixture disposal joins it.
     *
     * @param activity - Observes each fresh native dispatch
     */
    public async open(activity: ConnectorActivitySink): Promise<ConnectorClientFiles> {
        const owner: ConnectorClientFiles = await ConnectorClientFiles.load(
            this.identity,
            activity,
        );
        this.#owners.add(owner);
        return owner;
    }

    /**
     * One independently authorized read of a root file as the first journal sequence.
     *
     * @param path - The file to read, relative to the configured root
     * @returns A fresh original with its own dispatch identity
     */
    public original(path: string): ConnectorFileOriginal {
        const request: ConnectorFileOperation = ConnectorFileJobsCodec.operation(
            JSON.parse(
                ConnectorFileJobsCodec.encode({
                    action: ConnectorFileAction.Read,
                    requestId: randomBytes(16).toString('hex'),
                    rootId: 'project',
                    policySha256: this.policySha256,
                    path,
                    offset: 0n,
                    limit: 64,
                }),
            ),
        );
        const authorization: ConnectorAuthorization = {
            kind: ConnectorAuthorizationKind.Independent,
        };
        const requestHash: string = ConnectorFileProof.digest(
            ConnectorFileJobsCodec.encode(request),
        );
        return {
            authorityId: this.identity.authority.authorityId,
            enrollmentId: this.identity.settings.enrollmentId,
            jobId: 'file-job-1',
            sequence: 1n,
            dispatchId: randomBytes(32).toString('base64url'),
            requestHash,
            authorization,
            admissionHash: ConnectorAuthorizationProof.file(requestHash, authorization),
            request,
        };
    }

    /**
     * Re-signs an unchanged original for one lease, as the backend does on every delivery.
     *
     * @param original - The retained original
     * @param lease - The lease the delivery is bound to
     * @returns A short-lived permit no later than the lease
     */
    public deliver(
        original: ConnectorFileOriginal,
        lease: ConnectorDeviceLease,
    ): ConnectorFilePermit {
        const now: bigint = BigInt(Date.now());
        const limit: bigint = now + 10000n;
        const unsigned: Omit<ConnectorFilePermit, 'signature'> = {
            ...original,
            leaseId: lease.leaseId,
            issuedAtMs: now,
            expiresAtMs: limit < lease.expiresAtMs ? limit : lease.expiresAtMs,
        };
        return {
            ...unsigned,
            signature: ConnectorFileProof.sign(
                this.peer.authority,
                SignaturePurpose.OperationFilePermit,
                ConnectorFileProof.permit(unsigned),
            ),
        };
    }

    /** Joins every opened owner, then removes the task-owned folder and erases the generated keys. */
    public async [Symbol.asyncDispose](): Promise<void> {
        try {
            await Promise.allSettled(
                [...this.#owners].map((owner: ConnectorClientFiles): Promise<void> =>
                    owner[Symbol.asyncDispose](),
                ),
            );
        } finally {
            this.peer[Symbol.dispose]();
            await this.files[Symbol.asyncDispose]();
        }
    }
}
