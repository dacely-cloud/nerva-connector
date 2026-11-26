// SPDX-FileCopyrightText: 2026 Dacely <business@dacely.com>
// SPDX-License-Identifier: LicenseRef-Proprietary

import { SigningKey } from '../../src/identity/SigningKey.js';
import {
    ConnectorFileMode,
    ConnectorFileLimits,
} from 'nerva-connector-protocol/protocol/ConnectorFiles.js';
import { ExecutionWorkspaceAccess } from 'nerva-connector-protocol/execution/ExecutionTypes.js';
import type { WorkspaceIdentity } from '../../src/workspace/WorkspaceIdentity.js';
import type { JointWorkspaceSources } from '../../src/workspace/JointWorkspaceAssembly.js';
import type {
    JointWorkspacePhysicalScope,
    JointWorkspaceScope,
} from 'nerva-connector-protocol/workspace/JointWorkspaceBinding.js';

/** Synthetic private captures qualify protocol correlation/crypto only; actual native capture is independently tested by the owner. */
export class JointWorkspaceFixture implements Disposable {
    public readonly device: SigningKey = SigningKey.generate();
    public readonly authority: SigningKey = SigningKey.generate();
    public readonly identity: WorkspaceIdentity = {
        filesystemUuid: '1'.repeat(32),
        device: 9007199254740993n,
        inode: 42n,
        handleType: 1,
        handle: '2'.repeat(16),
    };

    /** All identities are test-only generated keys, never production controller or enrollment material. */
    public get scope(): JointWorkspacePhysicalScope {
        return {
            authorityId: 'test-joint-authority',
            environmentId: 'test-joint-environment',
            enrollmentId: 'conn_' + 'a'.repeat(64),
            devicePublicKey: this.device.publicKey,
            authorityPublicKey: this.authority.publicKey,
        };
    }

    /** Receiver-selected complete public scope excludes local-only derivation inputs. */
    public get expected(): JointWorkspaceScope {
        const scope: JointWorkspacePhysicalScope = this.scope;
        return {
            authorityId: scope.authorityId,
            environmentId: scope.environmentId,
            enrollmentId: scope.enrollmentId,
            devicePublicKey: scope.devicePublicKey,
        };
    }

    /** Different aliases deliberately share equal captured physical identity. */
    public sources(access: ConnectorFileMode = ConnectorFileMode.ReadWrite): JointWorkspaceSources {
        return {
            fileProfile: {
                mode: access,
                revision: 1n,
                policySha256: 'a'.repeat(64),
                roots: ['file-project'],
                maximumReadBytes: ConnectorFileLimits.readBytes,
                maximumWriteBytes:
                    access === ConnectorFileMode.ReadWrite ? ConnectorFileLimits.writeBytes : 0,
            },
            executionProfile: {
                revision: 2n,
                policySha256: 'b'.repeat(64),
                roots: [
                    {
                        id: 'command-project',
                        access:
                            access === ConnectorFileMode.ReadWrite
                                ? ExecutionWorkspaceAccess.ReadWrite
                                : ExecutionWorkspaceAccess.ReadOnly,
                    },
                ],
                programs: [{ id: 'tool', rootIds: ['command-project'], arguments: [] }],
                resources: { memoryBytes: 33554432n, maximumTasks: 2, cpuQuotaMicros: 1000 },
                timeoutMs: 1000,
                maximumAddressBytes: 67108864n,
                maximumFileBytes: 4096n,
            },
            file: { rootId: 'file-project', access, identity: this.identity },
            execution: { rootId: 'command-project', access, identity: { ...this.identity } },
            fileJournalId: 'c'.repeat(64),
            executionJournals: { first: 'd'.repeat(64), second: 'e'.repeat(64) },
        };
    }

    /** Private test secrets are discarded after every fixture scope. */
    public [Symbol.dispose](): void {
        this.device[Symbol.dispose]();
        this.authority[Symbol.dispose]();
    }
}
