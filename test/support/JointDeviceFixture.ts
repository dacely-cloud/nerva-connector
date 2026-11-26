// SPDX-FileCopyrightText: 2026 Dacely <business@dacely.com>
// SPDX-License-Identifier: LicenseRef-Proprietary

import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ExecutionFixture } from './ExecutionFixture.js';
import { ExecutionIdentity } from './ExecutionIdentity.js';
import { setup } from './ExecutionSetup.js';
import { ConnectorFileMode } from 'nerva-connector-protocol/protocol/ConnectorFiles.js';
import { SignatureSuite } from 'nerva-connector-protocol/identity/IdentityFormat.js';
import { ConnectorClientFiles } from '../../src/runtime/ConnectorClientFiles.js';
import { ConnectorClientExecution } from '../../src/runtime/ConnectorClientExecution.js';
import { ConnectorClientWorkspaces } from '../../src/runtime/ConnectorClientWorkspaces.js';
import { ExecutionPairPreparation } from '../../src/execution/ExecutionPairPreparation.js';
import { JointWorkspaceInstallation } from '../../src/workspace/JointWorkspaceInstallation.js';
import { JointWorkspaceJournal } from '../../src/workspace/JointWorkspaceJournal.js';
import { JointWorkspaceConfiguration } from '../../src/workspace/JointWorkspaceConfiguration.js';
import type { JointWorkspaceDescriptor } from 'nerva-connector-protocol/workspace/JointWorkspaceBinding.js';
import { ConnectorJournalCipher } from '../../src/runtime/ConnectorJournalCipher.js';
import {
    ConnectorJournalState,
    type ConnectorJournalSnapshot,
} from '../../src/runtime/ConnectorJournalState.js';
import { ConnectorFileJournalCodec } from '../../src/runtime/ConnectorFileJournalCodec.js';
import type { ConnectorFileOperation } from 'nerva-connector-protocol/protocol/ConnectorFileJobs.js';
import type { ConnectorFileResponse } from 'nerva-connector-protocol/protocol/ConnectorFiles.js';

/** Real Linux delegation, enforcing AppArmor, same-root file/command capabilities and actual native metadata capture share one generated identity. */
export class JointDeviceFixture implements AsyncDisposable {
    readonly #resources: AsyncDisposableStack;
    private constructor(
        public readonly native: ExecutionFixture,
        public readonly authority: ExecutionIdentity,
        public readonly files: ConnectorClientFiles,
        public readonly commands: ConnectorClientExecution,
        public readonly workspaces: ConnectorClientWorkspaces,
        public readonly original: JointWorkspaceDescriptor,
        resources: AsyncDisposableStack,
    ) {
        this.#resources = resources;
    }

    /** No confinement assertion, current-ready state or native identity is mocked; only the fixture's backend signing authority is generated locally. */
    public static async create(): Promise<JointDeviceFixture> {
        const helper: string | undefined = process.env['NERVA_CONNECTOR_EXEC_HELPER'];
        const fileHelper: string | undefined = process.env['NERVA_CONNECTOR_FILES_HELPER'];
        if (helper === undefined || fileHelper === undefined) {
            throw new Error('Explicit native helpers required');
        }
        await using resources: AsyncDisposableStack = new AsyncDisposableStack();
        const native: ExecutionFixture = resources.use(await ExecutionFixture.create(helper));
        const execution: Awaited<ReturnType<typeof setup>> = await setup(native);
        const fileState: string = join(native.directory, 'file-state');
        const stagingPath: string = join(native.directory, 'file-staging');
        await mkdir(fileState, { mode: 0o700 });
        await mkdir(stagingPath, { mode: 0o700 });
        const filePolicy: string = join(native.directory, 'files-policy.json');
        await writeFile(
            filePolicy,
            JSON.stringify({
                mode: ConnectorFileMode.ReadWrite,
                revision: '1',
                helperFile: fileHelper,
                helperSha256: createHash('sha256')
                    .update(await readFile(fileHelper))
                    .digest('hex'),
                roots: [{ id: 'files', path: native.workspace, stagingPath }],
            }),
            { mode: 0o600 },
        );
        const authority: ExecutionIdentity = resources.use(
            new ExecutionIdentity(native.directory, execution, {
                policyFile: filePolicy,
                stateDirectory: fileState,
            }),
        );
        const identity: typeof authority.identity = authority.identity;
        const bytes: Buffer = identity.key.encode();
        try {
            await writeFile(identity.settings.privateKeyFile, bytes, { mode: 0o600 });
        } finally {
            bytes.fill(0);
        }
        await writeFile(
            identity.settings.authorityPublicKeyFile,
            JSON.stringify({
                suite: SignatureSuite.MlDsa44Ed25519,
                publicKey: authority.authority.publicKey,
            }),
            { mode: 0o600 },
        );
        await writeFile(identity.configurationFile, JSON.stringify(identity.settings), {
            mode: 0o600,
        });
        await ConnectorClientFiles.initialize(identity);
        await ExecutionPairPreparation.prepare(identity, true);
        const request: string = join(native.directory, 'requested-bindings.json');
        await writeFile(
            request,
            JointWorkspaceConfiguration.encode({
                roots: [{ fileRootId: 'files', executionRootId: 'project' }],
            }),
            { mode: 0o600 },
        );
        await JointWorkspaceInstallation.initialize(
            identity.configurationFile,
            request,
            AbortSignal.timeout(10000),
        );
        const files: ConnectorClientFiles = resources.use(
            await ConnectorClientFiles.load(identity),
        );
        const commands: ConnectorClientExecution = resources.use(
            await ConnectorClientExecution.load(identity),
        );
        const paths: ReturnType<typeof JointWorkspaceConfiguration.paths> =
            JointWorkspaceConfiguration.paths(identity.settings.privateKeyFile);
        let original: JointWorkspaceDescriptor;
        {
            await using journal: JointWorkspaceJournal = await JointWorkspaceJournal.open(
                paths.stateDirectory,
                identity.key,
                {
                    scope: {
                        authorityId: identity.authority.authorityId,
                        authorityPublicKey: identity.authority.publicKey,
                        environmentId: identity.settings.environmentId,
                        enrollmentId: identity.settings.enrollmentId,
                        devicePublicKey: identity.publicKey,
                    },
                    fileJournalId: files.workspaceSource.journalId,
                    executionJournals: commands.workspaceSource.journals,
                },
                AbortSignal.timeout(5000),
            );
            const value: JointWorkspaceDescriptor | null = await journal.current(
                'files',
                'project',
                AbortSignal.timeout(5000),
            );
            if (value === null) {
                throw new Error('Actual captured workspace binding required');
            }
            original = value;
        }
        const workspaces: ConnectorClientWorkspaces | null = await ConnectorClientWorkspaces.load(
            identity,
            files,
            commands,
            AbortSignal.timeout(10000),
        );
        if (workspaces === null) {
            throw new Error('Actual installed workspace owner required');
        }
        resources.use(workspaces);
        files.bindJointAdmission(workspaces);
        commands.bindJointAdmission(workspaces);
        return new JointDeviceFixture(
            native,
            authority,
            files,
            commands,
            workspaces,
            original,
            resources.move(),
        );
    }

    /** Independent decoding observes the real Started record without taking its owner's journal lock or mutating borrowed ciphertext. */
    public async fileSnapshot(): Promise<
        ConnectorJournalSnapshot<ConnectorFileOperation, ConnectorFileResponse>
    > {
        const settings: typeof this.authority.identity.settings.files =
            this.authority.identity.settings.files;
        if (settings === null) {
            throw new Error('Actual file journal required');
        }
        const codec: ConnectorFileJournalCodec = new ConnectorFileJournalCodec();
        using cipher: ConnectorJournalCipher<
            ConnectorJournalSnapshot<ConnectorFileOperation, ConnectorFileResponse>
        > = ConnectorJournalCipher.create(
            settings.stateDirectory,
            this.authority.identity.settings.enrollmentId,
            this.authority.device,
            codec.purpose,
            new ConnectorJournalState(codec),
        );
        return cipher.decode(await readFile(join(settings.stateDirectory, 'file-journal'))).state;
    }

    /** Delivery and native tasks join before borrowed capabilities, generated keys and exact enforcing profiles are released. */
    public async [Symbol.asyncDispose](): Promise<void> {
        await this.#resources[Symbol.asyncDispose]();
    }
}
