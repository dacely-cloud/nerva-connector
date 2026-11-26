// SPDX-FileCopyrightText: 2026 Dacely <business@dacely.com>
// SPDX-License-Identifier: LicenseRef-Proprietary

import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { ConnectorFilesystem } from '../../src/runtime/ConnectorFilesystem.js';
import {
    ConnectorFileMode,
    type ConnectorFileResponse,
} from 'nerva-connector-protocol/protocol/ConnectorFiles.js';
import { ConnectorFileAction } from 'nerva-connector-protocol/protocol/ConnectorFileTypes.js';

const helper: string | undefined = process.env['NERVA_CONNECTOR_FILES_HELPER'];

/** Owns the real native helper policy and task-scoped private root/staging directories. */
export class FilesystemFixture implements AsyncDisposable {
    private constructor(
        public readonly directory: string,
        public readonly root: string,
        public readonly policy: string,
    ) {}
    /** The actual explicit release ELF and its digest are used, never a shell-script stand-in. */
    public static async create(
        mode: ConnectorFileMode = ConnectorFileMode.ReadOnly,
        parent: string = homedir(),
    ): Promise<FilesystemFixture> {
        if (helper === undefined) {
            throw new Error('Explicit native connector helper required');
        }
        const directory: string = await mkdtemp(join(parent, '.nerva-file-test-'));
        try {
            const root: string = join(directory, 'project');
            await mkdir(root, { mode: 0o700 });
            const stagingPath: string = join(directory, 'staging');
            if (mode === ConnectorFileMode.ReadWrite) {
                await mkdir(stagingPath, { mode: 0o700 });
            }
            const policy: string = join(directory, 'policy.json');
            await writeFile(
                policy,
                JSON.stringify({
                    mode,
                    revision: '1',
                    helperFile: helper,
                    helperSha256: createHash('sha256')
                        .update(await readFile(helper))
                        .digest('hex'),
                    roots: [
                        {
                            id: 'project',
                            path: root,
                            ...(mode === ConnectorFileMode.ReadWrite ? { stagingPath } : {}),
                        },
                    ],
                }),
                { mode: 0o600 },
            );
            return new FilesystemFixture(directory, root, policy);
        } catch (caught: unknown) {
            await rm(directory, { recursive: true, force: true });
            throw caught;
        }
    }
    /** Requests name only the configured root alias and exact local policy. */
    public async call(
        service: ConnectorFilesystem,
        action: ConnectorFileAction,
        path: string,
        additions: Readonly<Record<string, string | number | boolean>> = {},
        stagingId?: string,
    ): Promise<ConnectorFileResponse> {
        return await service.dispatch(
            JSON.stringify({
                action,
                requestId: crypto.randomUUID(),
                rootId: 'project',
                policySha256: service.profile.policySha256,
                path,
                ...additions,
            }),
            stagingId ?? (action === ConnectorFileAction.Remove ? 'a'.repeat(64) : undefined),
        );
    }
    /** Task-owned files are removed after all children and pinned handles are closed. */
    public async [Symbol.asyncDispose](): Promise<void> {
        await rm(this.directory, { recursive: true, force: true });
    }
}
