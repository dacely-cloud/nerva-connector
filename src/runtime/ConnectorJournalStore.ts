// SPDX-FileCopyrightText: 2026 Dacely <business@dacely.com>
// SPDX-License-Identifier: LicenseRef-Proprietary

import { ConnectorJournalLimits } from './ConnectorJournalLimits.js';
import { ConnectorJournalCipher } from './ConnectorJournalCipher.js';
import type { ConnectorJournalRecord } from './ConnectorJournalRecord.js';
import type { SigningKey } from '../identity/SigningKey.js';
import { join, resolve } from 'node:path';
import {
    ConnectorPrivateDirectory,
    ConnectorDirectoryPurpose,
} from './ConnectorPrivateDirectory.js';
import { ProtectedFiles } from '../local/ProtectedFiles.js';
import {
    ConnectorOperationPurpose,
    type ConnectorStorageCodec,
} from './ConnectorOperationCodec.js';

/** Explicit migration preserves unresolved original partial files for review instead of cleaning them during inspection. */
export enum ConnectorJournalOpenIntent {
    Runtime = 'runtime',
    Migration = 'migration',
}

/** The Linux kernel owns the process lock; an encrypted atomic file owns durable retained results. */
export class ConnectorJournalStore<TState> implements AsyncDisposable {
    readonly #cipher: ConnectorJournalCipher<TState>;
    readonly #directory: ConnectorPrivateDirectory;
    #closed: boolean = false;
    private constructor(
        public readonly file: string,
        cipher: ConnectorJournalCipher<TState>,
        directory: ConnectorPrivateDirectory,
        public readonly purpose: ConnectorOperationPurpose,
        public readonly codec: ConnectorStorageCodec<TState>,
    ) {
        this.#cipher = cipher;
        this.#directory = directory;
    }

    /** No directory or journal is silently created; explicit installation supplies an owner-private canonical directory. */
    public static async open<TState>(
        directory: string,
        enrollmentId: string,
        key: SigningKey,
        purpose: ConnectorOperationPurpose,
        codec: ConnectorStorageCodec<TState>,
        intent: ConnectorJournalOpenIntent = ConnectorJournalOpenIntent.Runtime,
    ): Promise<ConnectorJournalStore<TState>> {
        if (process.platform !== 'linux' || resolve(ProtectedFiles.path(directory)) !== directory) {
            throw new Error('Unsupported connector journal identity or platform');
        }
        const cipher: ConnectorJournalCipher<TState> = ConnectorJournalCipher.create(
            directory,
            enrollmentId,
            key,
            purpose,
            codec,
        );
        const basename: string =
            purpose === ConnectorOperationPurpose.Files ? 'file-journal' : 'execution-journal';
        let owner: ConnectorPrivateDirectory | null = null;
        try {
            owner = await ConnectorPrivateDirectory.open(
                directory,
                purpose === ConnectorOperationPurpose.Files
                    ? ConnectorDirectoryPurpose.Files
                    : ConnectorDirectoryPurpose.Execution,
            );
            if (intent === ConnectorJournalOpenIntent.Migration) {
                if (await owner.exists(basename + '.partial')) {
                    throw new Error(
                        'Retained migration source has an unresolved partial; preserve it for review',
                    );
                }
            } else if (intent === ConnectorJournalOpenIntent.Runtime) {
                await owner.cleanPartial(basename, ConnectorJournalLimits.recordBytes);
            } else {
                throw new Error('Invalid retained journal open intent');
            }
            return new ConnectorJournalStore(
                join(directory, basename),
                cipher,
                owner,
                purpose,
                codec,
            );
        } catch (caught: unknown) {
            cipher[Symbol.dispose]();
            await owner?.[Symbol.asyncDispose]();
            throw caught;
        }
    }

    /** Missing, tampered or undecodable encrypted state is fatal; reconnect never initializes a counter. */
    public async read(): Promise<TState> {
        return (await this.readRecord()).state;
    }

    /** Explicit migration can bind authenticated decoded state to its unchanged encrypted source bytes. */
    public async readRecord(): Promise<ConnectorJournalRecord<TState>> {
        this.#active();
        const bytes: Buffer = await this.#directory.read(
            this.#basename(),
            ConnectorJournalLimits.recordBytes,
        );
        try {
            return this.#cipher.decode(bytes);
        } finally {
            bytes.fill(0);
        }
    }

    /** Explicit initialization uses no-overwrite linking; normal writes atomically replace and sync the existing journal. */
    public async write(snapshot: TState, initialize: boolean): Promise<void> {
        this.#active();
        const bytes: Buffer = this.#cipher.encode(snapshot);
        try {
            await this.#directory.write(
                this.#basename(),
                bytes,
                ConnectorJournalLimits.recordBytes,
                initialize,
            );
        } finally {
            bytes.fill(0);
        }
    }

    /** Keys are zeroed and the kernel lock released only after the journal owner has joined its writes. */
    public async [Symbol.asyncDispose](): Promise<void> {
        if (this.#closed) {
            return;
        }
        this.#closed = true;
        this.#cipher[Symbol.dispose]();
        await this.#directory[Symbol.asyncDispose]();
    }
    #basename(): string {
        return this.purpose === ConnectorOperationPurpose.Files
            ? 'file-journal'
            : 'execution-journal';
    }
    #active(): void {
        if (this.#closed) {
            throw new Error('Connector journal ownership is closed');
        }
    }
}
