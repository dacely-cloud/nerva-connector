// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

import { createHash } from 'node:crypto';
import type { BigIntStats } from 'node:fs';
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, it, vi, type MockInstance } from 'vitest';
import { ConnectorCapabilityFixture } from './support/ConnectorCapabilityFixture.js';
import { InspectionFixture } from './support/InspectionFixture.js';
import {
    ConnectorInstallation,
    type ConnectorInstallationView,
} from '../src/install/ConnectorInstallation.js';
import {
    ConnectorCapabilityPlans,
    type ConnectorCapabilityRequest,
    type ConnectorCapabilityPlan,
} from '../src/install/ConnectorCapabilityPlan.js';
import {
    ConnectorFilePolicy,
    type ConnectorFilePolicyDefinition,
} from '../src/runtime/ConnectorFilePolicy.js';
import { ConnectorFilesystem } from '../src/runtime/ConnectorFilesystem.js';
import { ExecutionPolicy } from '../src/execution/ExecutionPolicy.js';
import type {
    ExecutionPolicyDefinition,
    ExecutionRootPolicy,
} from 'nerva-connector-protocol/execution/ExecutionPolicyTypes.js';
import { ConnectorReleaseFile } from '../src/install/ConnectorRelease.js';

/** Owned installation metadata excludes read-induced atime changes and never retains key contents. */
interface InstallationEntry {
    readonly path: string;
    readonly inode: bigint;
    readonly size: bigint;
    readonly mode: bigint;
    readonly modifiedAtNs: bigint;
}

/** Stable original policy bytes are returned without canonicalizing the user's setup intent. */
function encode(definition: ExecutionPolicyDefinition | ConnectorFilePolicyDefinition): string {
    return (
        JSON.stringify(definition, (_key: string, value: unknown): unknown =>
            typeof value === 'bigint' ? value.toString() : value,
        ) + '\n'
    );
}

/** All observed entries belong to this fixture; preflight must not create journals or rewrite installed files. */
async function snapshot(directory: string): Promise<readonly InstallationEntry[]> {
    const paths: string[] = (await readdir(directory, { recursive: true })).sort();
    return await Promise.all(
        paths.map(async (path: string): Promise<InstallationEntry> => {
            const status: BigIntStats = await stat(join(directory, path), { bigint: true });
            return {
                path,
                inode: status.ino,
                size: status.size,
                mode: status.mode,
                modifiedAtNs: status.mtimeNs,
            };
        }),
    );
}

/** One real signed installation and minimal verified execution runtime remain entirely task-owned. */
class CrossFixture implements AsyncDisposable {
    readonly #resources: AsyncDisposableStack;
    private constructor(
        public readonly files: ConnectorCapabilityFixture,
        public readonly runtime: InspectionFixture,
        public readonly installed: ConnectorInstallationView,
        public readonly request: ConnectorCapabilityRequest,
        public readonly definition: ExecutionPolicyDefinition,
        resources: AsyncDisposableStack,
    ) {
        this.#resources = resources;
    }

    /** No AppArmor installation, cgroup creation, socket or program execution is needed for preflight. */
    public static async create(): Promise<CrossFixture> {
        await using resources: AsyncDisposableStack = new AsyncDisposableStack();
        const files: ConnectorCapabilityFixture = resources.use(
            await ConnectorCapabilityFixture.create(),
        );
        const runtime: InspectionFixture = resources.use(await InspectionFixture.create());
        const installed: ConnectorInstallationView = await ConnectorInstallation.read(
            files.service.layout.installationDirectory,
            new AbortController().signal,
        );
        const helper: string = join(installed.directory, ConnectorReleaseFile.Execution);
        const definition: ExecutionPolicyDefinition = {
            ...runtime.executionDefinition,
            trampolineFile: helper,
            trampolineSha256: createHash('sha256')
                .update(await readFile(helper))
                .digest('hex'),
            roots: runtime.executionDefinition.roots.map(
                (root: ExecutionRootPolicy): ExecutionRootPolicy => ({
                    ...root,
                    path: files.workspace,
                }),
            ),
        };
        await writeFile(runtime.executionPolicy, encode(definition));
        const request: ConnectorCapabilityRequest = {
            installationDirectory: installed.directory,
            filesPolicyFile: files.policyFile,
            executionPolicyFile: runtime.executionPolicy,
        };
        const fixture: CrossFixture = new CrossFixture(
            files,
            runtime,
            installed,
            request,
            definition,
            resources.move(),
        );
        return fixture;
    }

    /** Only the two original temporary owners are removed after every opened policy owner has joined. */
    public async [Symbol.asyncDispose](): Promise<void> {
        await this.#resources[Symbol.asyncDispose]();
    }

    /** No setup installer is invoked: this is the production read-only preflight boundary itself. */
    public async read(): Promise<ConnectorCapabilityPlan> {
        return await ConnectorCapabilityPlans.read(
            this.files.requestFile,
            this.request,
            this.installed,
        );
    }
}

const helpers: boolean =
    process.platform === 'linux' &&
    process.env['NERVA_CONNECTOR_FILES_HELPER'] !== undefined &&
    process.env['NERVA_CONNECTOR_EXEC_HELPER'] !== undefined;

it.skipIf(!helpers)(
    'installer preflight preserves exact policy bytes and excludes every private staging root and descendant without changing installation',
    async (): Promise<void> => {
        await using fixture: CrossFixture = await CrossFixture.create();
        const original: ConnectorFilePolicyDefinition = await ConnectorFilePolicy.load(
            fixture.files.policyFile,
        );
        const secondRoot: string = join(fixture.files.service.release.directory, 'second-project');
        const secondStage: string = join(fixture.files.service.release.directory, 'second-stage');
        const nested: string = join(secondStage, 'nested');
        for (const path of [secondRoot, secondStage, nested]) {
            await mkdir(path, { mode: 0o700 });
        }
        const definition: ConnectorFilePolicyDefinition = {
            ...original,
            roots: [
                ...original.roots,
                { id: 'second', path: secondRoot, stagingPath: secondStage },
            ],
        };
        const files: string = encode(definition);
        await writeFile(fixture.files.policyFile, files);
        const commands: Buffer = await readFile(fixture.runtime.executionPolicy);
        const before: readonly InstallationEntry[] = await snapshot(fixture.installed.directory);
        const plan: ConnectorCapabilityPlan = await fixture.read();
        expect(plan.files?.bytes.equals(Buffer.from(files))).toBe(true);
        expect(plan.execution?.bytes.equals(commands)).toBe(true);
        const fileOwner: MockInstance<typeof ConnectorFilesystem.load> = vi.spyOn(
            ConnectorFilesystem,
            'load',
        );
        try {
            for (const path of [definition.roots[0]?.stagingPath, secondStage, nested]) {
                if (path === undefined || path === null) {
                    throw new Error('Explicit fixture staging reference required');
                }
                await writeFile(
                    fixture.runtime.executionPolicy,
                    encode({
                        ...fixture.definition,
                        roots: fixture.definition.roots.map(
                            (root: ExecutionRootPolicy): ExecutionRootPolicy => ({ ...root, path }),
                        ),
                    }),
                );
                await expect(fixture.read()).rejects.toThrow('overlaps protected');
                expect(fileOwner).not.toHaveBeenCalled();
                expect(await snapshot(fixture.installed.directory)).toEqual(before);
            }
        } finally {
            fileOwner.mockRestore();
        }
        await writeFile(fixture.runtime.executionPolicy, commands);
        expect((await fixture.read()).files?.bytes.equals(Buffer.from(files))).toBe(true);
        expect(await snapshot(fixture.installed.directory)).toEqual(before);
    },
);

it.skipIf(!helpers)(
    'preflight refuses policy sources changed only during native owner validation and never retags the retained originals',
    async (): Promise<void> => {
        await using fixture: CrossFixture = await CrossFixture.create();
        const files: Buffer = await readFile(fixture.files.policyFile);
        const commands: Buffer = await readFile(fixture.runtime.executionPolicy);
        const before: readonly InstallationEntry[] = await snapshot(fixture.installed.directory);
        const loadFiles: typeof ConnectorFilesystem.load =
            ConnectorFilesystem.load.bind(ConnectorFilesystem);
        const fileSpy: MockInstance<typeof ConnectorFilesystem.load> = vi.spyOn(
            ConnectorFilesystem,
            'load',
        );
        fileSpy.mockImplementation(
            async (path: string, privatePaths: readonly string[]): Promise<ConnectorFilesystem> => {
                const definition: ConnectorFilePolicyDefinition =
                    await ConnectorFilePolicy.load(path);
                await writeFile(
                    path,
                    encode({ ...definition, revision: definition.revision + 1n }),
                );
                try {
                    return await loadFiles(path, privatePaths);
                } finally {
                    await writeFile(path, files);
                }
            },
        );
        try {
            await expect(fixture.read()).rejects.toThrow('File policy changed');
        } finally {
            fileSpy.mockRestore();
        }
        const loadExecution: typeof ExecutionPolicy.load =
            ExecutionPolicy.load.bind(ExecutionPolicy);
        const executionSpy: MockInstance<typeof ExecutionPolicy.load> = vi.spyOn(
            ExecutionPolicy,
            'load',
        );
        executionSpy.mockImplementation(
            async (path: string, privatePaths: readonly string[]): Promise<ExecutionPolicy> => {
                await writeFile(path, Buffer.concat([commands, Buffer.from('\n')]));
                try {
                    return await loadExecution(path, privatePaths);
                } finally {
                    await writeFile(path, commands);
                }
            },
        );
        try {
            await expect(fixture.read()).rejects.toThrow('Execution policy changed');
        } finally {
            executionSpy.mockRestore();
        }
        expect(await snapshot(fixture.installed.directory)).toEqual(before);
        expect((await readFile(fixture.files.policyFile)).equals(files)).toBe(true);
        expect((await readFile(fixture.runtime.executionPolicy)).equals(commands)).toBe(true);
    },
);
