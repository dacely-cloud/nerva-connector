// SPDX-FileCopyrightText: 2026 Dacely <business@dacely.com>
// SPDX-License-Identifier: LicenseRef-Proprietary

import { resolve } from 'node:path';
import type { ConnectorClientIdentity } from '../runtime/ConnectorClientConfiguration.js';
import { ConnectorJournalCipher } from '../runtime/ConnectorJournalCipher.js';
import {
    ConnectorPrivateDirectory,
    ConnectorDirectoryPurpose,
} from '../runtime/ConnectorPrivateDirectory.js';
import type { ConnectorJournalRecord } from '../runtime/ConnectorJournalRecord.js';
import { KeyDerivationPurpose } from 'nerva-connector-protocol/identity/IdentityFormat.js';
import { ProtectedFiles } from '../local/ProtectedFiles.js';
import { ExecutionJobsCodec } from './ExecutionJobsCodec.js';
import { ExecutionInteractiveFields as Fields } from 'nerva-connector-protocol/execution/ExecutionInteractiveFields.js';
import { ExecutionInputJournalValidation } from './ExecutionInputJournalValidation.js';
import { ExecutionInputRecordCodec } from './ExecutionInputRecordCodec.js';
import {
    ExecutionInputJournalLimits as Limits,
    type ExecutionInputJournalScope,
    type ExecutionInputJournalRecordState,
} from './ExecutionInputJournalTypes.js';

/** A separate fixed encrypted cursor shares the installed lane directory without sharing its existing execution lock or AAD. */
export class ExecutionInputJournalStore implements AsyncDisposable {
    #closed: boolean = false;
    readonly #cipher: ConnectorJournalCipher<ExecutionInputJournalRecordState>;
    private constructor(
        public readonly directory: ConnectorPrivateDirectory,
        public readonly codec: ExecutionInputRecordCodec,
        cipher: ConnectorJournalCipher<ExecutionInputJournalRecordState>,
    ) {
        this.#cipher = cipher;
    }

    /** Existing private Linux directories are mandatory; this owner never creates per-job paths or enables another platform. */
    public static async open(
        directory: string,
        identity: ConnectorClientIdentity,
        raw: ExecutionInputJournalScope,
    ): Promise<ExecutionInputJournalStore> {
        if (process.platform !== 'linux' || resolve(ProtectedFiles.path(directory)) !== directory) {
            throw new Error(
                'Interactive cursor requires an installed canonical Linux lane directory',
            );
        }
        const value: Readonly<Record<string, unknown>> = Fields.record(raw, ['lane', 'journalId']);
        const scope: ExecutionInputJournalScope = Object.freeze({
            lane: ExecutionJobsCodec.lane(value['lane']),
            journalId: Fields.digest(value['journalId']),
        });
        const codec: ExecutionInputRecordCodec = new ExecutionInputRecordCodec(
            new ExecutionInputJournalValidation(identity, scope),
        );
        const context: Buffer = Buffer.from(
            JSON.stringify([
                'nerva-connector:execution-input-cursor',
                directory,
                identity.settings.enrollmentId,
                scope.lane,
                scope.journalId,
                identity.authority.authorityId,
                identity.authority.publicKey,
                identity.publicKey,
            ]),
        );
        const cipher: ConnectorJournalCipher<ExecutionInputJournalRecordState> =
            ConnectorJournalCipher.scoped(
                identity.key,
                {
                    purpose: KeyDerivationPurpose.RetainedExecutionInput,
                    salt: context,
                    aad: context,
                    limits: { plainBytes: Limits.plainBytes, recordBytes: Limits.recordBytes },
                },
                codec,
            );
        try {
            const owner: ConnectorPrivateDirectory = await ConnectorPrivateDirectory.open(
                directory,
                ConnectorDirectoryPurpose.ExecutionInput,
            );
            try {
                await owner.cleanPartial(Limits.basename, Limits.recordBytes);
                return new ExecutionInputJournalStore(owner, codec, cipher);
            } catch (caught: unknown) {
                await owner[Symbol.asyncDispose]();
                throw caught;
            }
        } catch (caught: unknown) {
            cipher[Symbol.dispose]();
            throw caught;
        } finally {
            context.fill(0);
        }
    }

    public async read(): Promise<ConnectorJournalRecord<ExecutionInputJournalRecordState>> {
        this.#active();
        const bytes: Buffer = await this.directory.read(Limits.basename, Limits.recordBytes);
        try {
            return this.#cipher.decode(bytes);
        } finally {
            bytes.fill(0);
        }
    }

    /** A retained source hash prevents a changed, removed or corrupt current file from being silently overwritten. */
    public async write(
        state: ExecutionInputJournalRecordState,
        expected: string | null,
    ): Promise<ConnectorJournalRecord<ExecutionInputJournalRecordState>> {
        this.#active();
        if (expected !== null && (await this.read()).sourceSha256 !== expected) {
            throw new Error('Interactive cursor source changed before publication');
        }
        const bytes: Buffer = this.#cipher.encode(state);
        try {
            await this.directory.write(
                Limits.basename,
                bytes,
                Limits.recordBytes,
                expected === null,
            );
            return this.#cipher.decode(bytes);
        } finally {
            bytes.fill(0);
        }
    }

    public async [Symbol.asyncDispose](): Promise<void> {
        if (!this.#closed) {
            this.#closed = true;
            this.#cipher[Symbol.dispose]();
            await this.directory[Symbol.asyncDispose]();
        }
    }

    #active(): void {
        if (this.#closed) {
            throw new Error('Interactive cursor storage is closed');
        }
    }
}
