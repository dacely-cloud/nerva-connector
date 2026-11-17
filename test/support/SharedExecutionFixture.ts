// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { InspectionFixture } from './InspectionFixture.js';
import { SigningKey } from '../../src/identity/SigningKey.js';
import { SignatureSuite } from 'nerva-connector-protocol/identity/IdentityFormat.js';
import type { ConnectorClientIdentity } from '../../src/runtime/ConnectorClientConfiguration.js';
import { ConnectorOperationJournal } from '../../src/runtime/ConnectorOperationJournal.js';
import { ExecutionJournalCodec } from '../../src/execution/ExecutionJournalCodec.js';
import { ExecutionLane } from 'nerva-connector-protocol/execution/ExecutionLane.js';
import type { ExecutionClientSettings } from '../../src/execution/ExecutionClientSettings.js';

/** Real pinned policy and encrypted lanes qualify ownership/startup only; no MAC assertion or program execution is claimed. */
export class SharedExecutionFixture implements AsyncDisposable {
    private constructor(
        public readonly native: InspectionFixture,
        public readonly identity: ConnectorClientIdentity,
    ) {}

    /** Reuses the existing native qualification fixture without cgroup writes, dependency copies or remote hosts. */
    public static async create(): Promise<SharedExecutionFixture> {
        const native: InspectionFixture = await InspectionFixture.create();
        const key: SigningKey = SigningKey.generate();
        try {
            const privateDirectory: string = join(native.directory, 'identity');
            const stateDirectory: string = join(native.directory, 'execution-state');
            await mkdir(privateDirectory, { mode: 0o700 });
            await mkdir(stateDirectory, { mode: 0o700 });
            const privateKeyFile: string = join(privateDirectory, 'device-key.json');
            const bytes: Buffer = key.encode();
            try {
                await writeFile(privateKeyFile, bytes, { mode: 0o600 });
            } finally {
                bytes.fill(0);
            }
            const authorityPublicKeyFile: string = join(privateDirectory, 'authority.json');
            await writeFile(
                authorityPublicKeyFile,
                JSON.stringify({ suite: SignatureSuite.MlDsa44Ed25519, publicKey: key.publicKey }),
                { mode: 0o600 },
            );
            const identity: ConnectorClientIdentity = {
                configurationFile: join(native.directory, 'runtime.json'),
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
                    files: null,
                    execution: { policyFile: native.executionPolicy, stateDirectory },
                },
            };
            await writeFile(identity.configurationFile, JSON.stringify(identity.settings), {
                mode: 0o600,
            });
            for (const lane of Object.values(ExecutionLane)) {
                const directory: string = join(stateDirectory, lane);
                await mkdir(directory, { mode: 0o700 });
                await ConnectorOperationJournal.initialize(
                    directory,
                    identity.settings.enrollmentId,
                    key,
                    new ExecutionJournalCodec(lane),
                );
            }
            return new SharedExecutionFixture(native, identity);
        } catch (caught: unknown) {
            key[Symbol.dispose]();
            await native[Symbol.asyncDispose]();
            throw caught;
        }
    }

    /** Both clients select one installation policy and independently retained lane. */
    public settings(lane: ExecutionLane): ExecutionClientSettings {
        const settings: typeof this.identity.settings.execution = this.identity.settings.execution;
        if (settings === null) {
            throw new Error('Explicit fixture installation required');
        }
        return { ...settings, lane };
    }

    /** Callers must dispose every lane and borrowed policy before releasing this identity and its task-owned files. */
    public async [Symbol.asyncDispose](): Promise<void> {
        this.identity.key[Symbol.dispose]();
        await this.native[Symbol.asyncDispose]();
    }
}
