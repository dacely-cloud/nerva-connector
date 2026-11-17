// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

import { SigningKey } from '../../src/identity/SigningKey.js';
import { ConnectorFilesystem } from '../../src/runtime/ConnectorFilesystem.js';
import { ExecutionPolicy } from '../../src/execution/ExecutionPolicy.js';
import { ExecutionWorkspaceAccess } from '../../src/execution/ExecutionTypes.js';
import { ConnectorFileMode } from 'nerva-connector-protocol/protocol/ConnectorFiles.js';
import { JointWorkspaceCapture } from '../../src/workspace/JointWorkspaceCapture.js';
import type { JointWorkspaceCaptureRequest } from '../../src/workspace/JointWorkspaceCapture.js';
import type { JointWorkspaceScope } from 'nerva-connector-protocol/workspace/JointWorkspaceBinding.js';
import { InspectionFixture } from './InspectionFixture.js';

/** This fixture qualifies actual root capture; journal labels are synthetic inputs and make no backend activation claim. */
export class JointWorkspaceCaptureFixture implements AsyncDisposable {
    private constructor(
        public readonly resources: AsyncDisposableStack,
        public readonly source: InspectionFixture,
        public readonly files: ConnectorFilesystem,
        public readonly commands: ExecutionPolicy,
        public readonly owner: JointWorkspaceCapture,
        public readonly scope: JointWorkspaceScope,
        public readonly request: JointWorkspaceCaptureRequest,
    ) {}

    /** Only the actual explicit native helpers are used; no command or network connection is launched. */
    public static async create(
        fileMode: ConnectorFileMode = ConnectorFileMode.ReadOnly,
        commandAccess: ExecutionWorkspaceAccess = ExecutionWorkspaceAccess.ReadOnly,
        sameRoot: boolean = true,
    ): Promise<JointWorkspaceCaptureFixture> {
        await using resources: AsyncDisposableStack = new AsyncDisposableStack();
        const source: InspectionFixture = resources.use(
            await InspectionFixture.create(fileMode, commandAccess, sameRoot),
        );
        const key: SigningKey = resources.use(SigningKey.generate());
        const authority: SigningKey = resources.use(SigningKey.generate());
        const paths: readonly string[] = [source.filePolicy, source.executionPolicy];
        const files: ConnectorFilesystem = resources.use(
            await ConnectorFilesystem.load(source.filePolicy, paths),
        );
        const commands: ExecutionPolicy = resources.use(
            await ExecutionPolicy.load(source.executionPolicy, paths),
        );
        const scope: JointWorkspaceScope = {
            authorityId: 'capture-authority',
            environmentId: 'capture-environment',
            enrollmentId: 'conn_' + 'a'.repeat(64),
            devicePublicKey: key.publicKey,
        };
        const owner: JointWorkspaceCapture = resources.use(
            new JointWorkspaceCapture(
                key,
                { ...scope, authorityPublicKey: authority.publicKey },
                files,
                commands,
            ),
        );
        const request: JointWorkspaceCaptureRequest = {
            revision: 9007199254740993n,
            fileRootId: source.fileRootId,
            executionRootId: source.executionRootId,
            fileJournalId: 'a'.repeat(64),
            executionJournals: { first: 'b'.repeat(64), second: 'c'.repeat(64) },
            executionProfile: {
                revision: commands.definition.revision,
                policySha256: commands.policySha256,
                roots: [{ id: source.executionRootId, access: commandAccess }],
                programs: [{ id: 'probe', rootIds: [source.executionRootId], arguments: [] }],
                resources: commands.definition.resources,
                timeoutMs: commands.definition.timeoutMs,
                maximumAddressBytes: commands.definition.maximumAddressBytes,
                maximumFileBytes: commands.definition.maximumFileBytes,
            },
        };
        return new JointWorkspaceCaptureFixture(
            resources.move(),
            source,
            files,
            commands,
            owner,
            scope,
            request,
        );
    }

    /** Capture joins before either borrowed policy, fixture signing key or task-owned directory is released. */
    public async [Symbol.asyncDispose](): Promise<void> {
        await this.resources[Symbol.asyncDispose]();
    }
}
