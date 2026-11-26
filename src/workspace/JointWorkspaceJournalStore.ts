// SPDX-FileCopyrightText: 2026 Dacely <business@dacely.com>
// SPDX-License-Identifier: LicenseRef-Proprietary

import { resolve } from 'node:path';
import type { SigningKey } from '../identity/SigningKey.js';
import { KeyDerivationPurpose } from 'nerva-connector-protocol/identity/IdentityFormat.js';
import { ConnectorJournalCipher } from '../runtime/ConnectorJournalCipher.js';
import {
    ConnectorPrivateDirectory,
    ConnectorDirectoryPurpose,
} from '../runtime/ConnectorPrivateDirectory.js';
import { ProtectedFiles } from '../local/ProtectedFiles.js';
import type { JointWorkspaceDescriptor } from 'nerva-connector-protocol/workspace/JointWorkspaceBinding.js';
import { JointWorkspaceArchiveCodec } from './JointWorkspaceArchiveCodec.js';
import { JointWorkspaceJournalContext } from './JointWorkspaceJournalContext.js';
import { JointWorkspaceJournalState } from './JointWorkspaceJournalState.js';
import {
    JointWorkspaceJournalLimits,
    type JointWorkspaceJournalSnapshot,
} from './JointWorkspaceJournalTypes.js';

/** One pinned private directory owns all immutable archives and atomic head publication under a dedicated installation lock. */
export class JointWorkspaceJournalStore implements AsyncDisposable {
    static readonly #head: string = 'workspace-head';
    readonly #cipher: ConnectorJournalCipher<JointWorkspaceJournalSnapshot>;
    #closed: boolean = false;
    readonly #key: SigningKey;
    readonly #context: JointWorkspaceJournalContext;
    readonly #owner: ConnectorPrivateDirectory;

    private constructor(
        public readonly directory: string,
        key: SigningKey,
        context: JointWorkspaceJournalContext,
        owner: ConnectorPrivateDirectory,
    ) {
        this.#key = key;
        this.#context = context;
        this.#owner = owner;
        this.#cipher = ConnectorJournalCipher.scoped(
            key,
            {
                purpose: KeyDerivationPurpose.RetainedWorkspaces,
                salt: Buffer.from(context.digest),
                aad: Buffer.from(
                    JSON.stringify(['nerva-connector:workspace-head:1', context.digest, directory]),
                ),
                limits: {
                    plainBytes: JointWorkspaceJournalLimits.headPlainBytes,
                    recordBytes: JointWorkspaceJournalLimits.headRecordBytes,
                },
            },
            new JointWorkspaceJournalState(context),
        );
    }

    /** Existing Linux installation state is required; this method never creates a directory or journal. */
    public static async open(
        directory: string,
        key: SigningKey,
        context: JointWorkspaceJournalContext,
    ): Promise<JointWorkspaceJournalStore> {
        if (process.platform !== 'linux' || resolve(ProtectedFiles.path(directory)) !== directory) {
            throw new Error(
                'Joint workspace history requires a canonical private Linux installation directory',
            );
        }
        const owner: ConnectorPrivateDirectory = await ConnectorPrivateDirectory.open(
            directory,
            ConnectorDirectoryPurpose.Workspaces,
        );
        try {
            return new JointWorkspaceJournalStore(directory, key, context, owner);
        } catch (caught: unknown) {
            await owner[Symbol.asyncDispose]();
            throw caught;
        }
    }

    /** A missing head or uncommitted initial partial never becomes empty state. */
    public async initialize(snapshot: JointWorkspaceJournalSnapshot): Promise<void> {
        this.#active();
        if (!(await this.#owner.empty())) {
            throw new Error(
                'Joint workspace initialization requires empty state; keep original history',
            );
        }
        await this.write(snapshot, true);
    }

    public async read(): Promise<JointWorkspaceJournalSnapshot> {
        this.#active();
        const bytes: Buffer = await this.#owner.read(
            JointWorkspaceJournalStore.#head,
            JointWorkspaceJournalLimits.headRecordBytes,
        );
        try {
            const snapshot: JointWorkspaceJournalSnapshot = this.#cipher.decode(bytes).state;
            // A valid final head is authoritative; unique signed descriptors remain in separate immutable leaves.
            await this.#owner.cleanPartial(
                JointWorkspaceJournalStore.#head,
                JointWorkspaceJournalLimits.headRecordBytes,
            );
            return snapshot;
        } finally {
            bytes.fill(0);
        }
    }

    public async write(
        snapshot: JointWorkspaceJournalSnapshot,
        initialize: boolean = false,
    ): Promise<void> {
        this.#active();
        const bytes: Buffer = this.#cipher.encode(snapshot);
        try {
            await this.#owner.write(
                JointWorkspaceJournalStore.#head,
                bytes,
                JointWorkspaceJournalLimits.headRecordBytes,
                initialize,
            );
        } finally {
            bytes.fill(0);
        }
    }

    public async archiveExists(revision: bigint): Promise<boolean> {
        this.#active();
        return await this.#owner.exists(this.#name(revision));
    }

    /** A stranded archive partial is preserved rather than mistaken for a capture that never happened. */
    public async archivePartialExists(revision: bigint): Promise<boolean> {
        this.#active();
        return await this.#owner.exists(this.#name(revision) + '.partial');
    }

    public async archive(revision: bigint): Promise<JointWorkspaceDescriptor> {
        this.#active();
        using cipher: ConnectorJournalCipher<JointWorkspaceDescriptor> =
            this.#archiveCipher(revision);
        const bytes: Buffer = await this.#owner.read(
            this.#name(revision),
            JointWorkspaceJournalLimits.archiveRecordBytes,
        );
        try {
            const descriptor: JointWorkspaceDescriptor = cipher.decode(bytes).state;
            if (descriptor.binding.revision !== revision) {
                throw new Error('Joint workspace archive revision changed');
            }
            return descriptor;
        } finally {
            bytes.fill(0);
        }
    }

    /** The no-overwrite primitive preserves the original full signed descriptor and syncs it before head finalization. */
    public async retain(descriptor: JointWorkspaceDescriptor): Promise<void> {
        this.#active();
        const revision: bigint = descriptor.binding.revision;
        using cipher: ConnectorJournalCipher<JointWorkspaceDescriptor> =
            this.#archiveCipher(revision);
        const bytes: Buffer = cipher.encode(descriptor);
        try {
            await this.#owner.write(
                this.#name(revision),
                bytes,
                JointWorkspaceJournalLimits.archiveRecordBytes,
                true,
            );
        } finally {
            bytes.fill(0);
        }
    }

    public async [Symbol.asyncDispose](): Promise<void> {
        if (!this.#closed) {
            this.#closed = true;
            this.#cipher[Symbol.dispose]();
            await this.#owner[Symbol.asyncDispose]();
        }
    }

    #archiveCipher(revision: bigint): ConnectorJournalCipher<JointWorkspaceDescriptor> {
        this.#name(revision);
        return ConnectorJournalCipher.scoped(
            this.#key,
            {
                purpose: KeyDerivationPurpose.RetainedWorkspaces,
                salt: Buffer.from(this.#context.digest),
                aad: Buffer.from(
                    JSON.stringify([
                        'nerva-connector:workspace-archive:1',
                        this.#context.digest,
                        this.directory,
                        revision.toString(),
                    ]),
                ),
                limits: {
                    plainBytes: JointWorkspaceJournalLimits.archivePlainBytes,
                    recordBytes: JointWorkspaceJournalLimits.archiveRecordBytes,
                },
            },
            new JointWorkspaceArchiveCodec(this.#context),
        );
    }

    #name(revision: bigint): string {
        if (
            typeof revision !== 'bigint' ||
            revision < 1n ||
            revision > BigInt(JointWorkspaceJournalLimits.revisions)
        ) {
            throw new Error('Invalid joint workspace archive revision');
        }
        return 'workspace-binding-' + revision.toString();
    }

    #active(): void {
        if (this.#closed) {
            throw new Error('Joint workspace history ownership is closed');
        }
    }
}
