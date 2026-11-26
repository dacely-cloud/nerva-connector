// SPDX-FileCopyrightText: 2026 Dacely <business@dacely.com>
// SPDX-License-Identifier: LicenseRef-Proprietary

import { constants } from 'node:fs';
import { createHash } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { ConnectorFileMode } from 'nerva-connector-protocol/protocol/ConnectorFiles.js';
import { ExecutionWorkspaceAccess } from 'nerva-connector-protocol/execution/ExecutionTypes.js';
import type { ExecutionPolicyDefinition } from 'nerva-connector-protocol/execution/ExecutionPolicyTypes.js';

/** Explicit files policy grants one folder without configuring any remote account or journal. */
interface InspectionFilePolicy {
    readonly mode: ConnectorFileMode;
    readonly revision: string;
    readonly helperFile: string;
    readonly helperSha256: string;
    readonly roots: readonly InspectionFileRoot[];
}

/** Private write staging is present only for a deliberately writable file grant. */
interface InspectionFileRoot {
    readonly id: string;
    readonly path: string;
    readonly stagingPath?: string;
}

/** Read-only policy loading needs neither a delegated cgroup nor installed AppArmor rules. */
export class InspectionFixture implements AsyncDisposable {
    /** Different aliases deliberately test physical identity rather than string equality. */
    public readonly fileRootId: string = 'files-project';
    /** The command grant names its folder independently of the file grant. */
    public readonly executionRootId: string = 'commands-project';

    private constructor(
        public readonly directory: string,
        public readonly root: string,
        public readonly differentRoot: string,
        public readonly filePolicy: string,
        public readonly executionPolicy: string,
        public readonly executionDefinition: ExecutionPolicyDefinition,
    ) {}

    /** Only locally selected real helpers are admitted; the fixture never runs the granted program. */
    public static async create(
        fileMode: ConnectorFileMode = ConnectorFileMode.ReadOnly,
        executionAccess: ExecutionWorkspaceAccess = ExecutionWorkspaceAccess.ReadOnly,
        sameRoot: boolean = true,
    ): Promise<InspectionFixture> {
        const files: string | undefined = process.env['NERVA_CONNECTOR_FILES_HELPER'];
        const execution: string | undefined = process.env['NERVA_CONNECTOR_EXEC_HELPER'];
        if (files === undefined || execution === undefined) {
            throw new Error('Explicit source-built file and execution helpers required');
        }
        const directory: string = await mkdtemp(join(homedir(), '.nerva-inspection-test-'));
        try {
            const root: string = join(directory, 'project');
            const differentRoot: string = join(directory, 'different-project');
            const runtime: string = join(directory, 'runtime');
            const cgroup: string = join(directory, 'inactive-cgroup-reference');
            const staging: string = join(directory, 'staging');
            for (const path of [
                root,
                differentRoot,
                cgroup,
                staging,
                runtime,
                ...['workspace', 'proc', 'dev', 'tmp', 'nerva-limits', 'usr/bin'].map(
                    (name: string): string => join(runtime, name),
                ),
            ]) {
                await mkdir(path, { recursive: true, mode: 0o700 });
            }
            const program: string = join(runtime, 'usr/bin/true');
            await copyFile('/usr/bin/true', program, constants.COPYFILE_EXCL);
            const digest: (path: string) => Promise<string> = async (
                path: string,
            ): Promise<string> =>
                createHash('sha256')
                    .update(await readFile(path))
                    .digest('hex');
            const filePolicy: string = join(directory, 'files-policy.json');
            const definition: InspectionFilePolicy = {
                mode: fileMode,
                revision: '1',
                helperFile: files,
                helperSha256: await digest(files),
                roots: [
                    {
                        id: 'files-project',
                        path: root,
                        ...(fileMode === ConnectorFileMode.ReadWrite
                            ? { stagingPath: staging }
                            : {}),
                    },
                ],
            };
            await writeFile(filePolicy, JSON.stringify(definition), { mode: 0o600 });
            const executionDefinition: ExecutionPolicyDefinition = {
                installationId: crypto.randomUUID().replaceAll('-', ''),
                revision: 1n,
                trampolineFile: execution,
                trampolineSha256: await digest(execution),
                bubblewrapFile: '/usr/bin/bwrap',
                bubblewrapSha256: await digest('/usr/bin/bwrap'),
                runtimeDirectory: runtime,
                cgroupRoot: cgroup,
                roots: [
                    {
                        id: 'commands-project',
                        path: sameRoot ? root : differentRoot,
                        access: executionAccess,
                    },
                ],
                programs: [
                    {
                        id: 'probe',
                        rootIds: ['commands-project'],
                        path: '/usr/bin/true',
                        sha256: await digest(program),
                        arguments: [],
                        children: [],
                    },
                ],
                resources: { memoryBytes: 33554432n, maximumTasks: 2, cpuQuotaMicros: 1000 },
                timeoutMs: 1000,
                maximumAddressBytes: 67108864n,
                maximumFileBytes: 0n,
            };
            const executionPolicy: string = join(directory, 'execution-policy.json');
            await writeFile(
                executionPolicy,
                JSON.stringify(executionDefinition, (_key: string, value: unknown): unknown =>
                    typeof value === 'bigint' ? value.toString() : value,
                ),
                { mode: 0o600 },
            );
            return new InspectionFixture(
                directory,
                root,
                differentRoot,
                filePolicy,
                executionPolicy,
                executionDefinition,
            );
        } catch (caught: unknown) {
            await rm(directory, { recursive: true, force: true });
            throw caught;
        }
    }

    /** Policy owners must close borrowed handles before the task-owned test data is removed. */
    public async [Symbol.asyncDispose](): Promise<void> {
        await rm(this.directory, { recursive: true, force: true });
    }
}
