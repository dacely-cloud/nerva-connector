// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

import { ConnectorJournalLimits } from '../../src/runtime/ConnectorJournalLimits.js';
import { constants, type BigIntStats } from 'node:fs';
import { readdir, realpath, lstat, readFile, open, type FileHandle } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { Boundary } from 'nerva-connector-protocol/protocol/Boundary.js';
import { ProtectedFiles } from '../../src/local/ProtectedFiles.js';
import { SigningKey } from '../../src/identity/SigningKey.js';
import { IdentityLengths } from 'nerva-connector-protocol/identity/IdentityFormat.js';
import { ConnectorEnrollmentCodec } from 'nerva-connector-protocol/protocol/ConnectorEnrollmentCodec.js';
import { ConnectorFileMode } from 'nerva-connector-protocol/protocol/ConnectorFiles.js';
import { ConnectorNativeExecutable } from '../../src/runtime/ConnectorNativeExecutable.js';
import { ConnectorJournalCipher } from '../../src/runtime/ConnectorJournalCipher.js';
import {
    ConnectorJournalState,
    type ConnectorJournalSnapshot,
} from '../../src/runtime/ConnectorJournalState.js';
import { ConnectorEffectKind } from '../../src/runtime/ConnectorEffectContext.js';
import { ExecutionJournalCodec } from '../../src/execution/ExecutionJournalCodec.js';
import { type ExecutionRequest } from 'nerva-connector-protocol/execution/ExecutionJobs.js';
import { ExecutionLane } from 'nerva-connector-protocol/execution/ExecutionLane.js';
import { ExecutionPolicyCodec } from '../../src/execution/ExecutionPolicyCodec.js';
import type {
    ExecutionPolicyDefinition,
    ExecutionRootPolicy,
} from 'nerva-connector-protocol/execution/ExecutionPolicyTypes.js';
import type { ExecutionOutput } from 'nerva-connector-protocol/execution/ExecutionOutput.js';
import {
    ExecutionWorkspaceAccess,
    type ExecutionResult,
    type ExecutionTermination,
    type ExecutionFailure,
    type ExecutionSetupFailure,
} from 'nerva-connector-protocol/execution/ExecutionTypes.js';
import { WorkspaceIdentityProcess } from '../../src/workspace/WorkspaceIdentityProcess.js';
import type {
    WorkspaceIdentityResult,
    WorkspaceIdentityFailure,
} from '../../src/workspace/WorkspaceIdentity.js';

/** This inspector only reads retained fixture state and runs the already-reviewed descriptor-only native capture modes. */
enum InspectorStage {
    Input = 'input',
    Locate = 'locate',
    Policy = 'policy',
    Key = 'key',
    Journal = 'journal',
    Helper = 'helper',
    Workspace = 'workspace',
    Cgroup = 'current-cgroup',
    Complete = 'complete',
}
/** Capture failures never print native diagnostics or private identities. */
enum InspectorCapture {
    NotRun = 'not-run',
    Success = 'success',
    Failed = 'failed',
}
/** The controller supplies one failed fixture parent, never a key path or arbitrary command. */
interface InspectorSettings {
    readonly directory: string;
    readonly helper: string;
}
/** All output is fixed structural metadata; no identities, paths, content or underlying exceptions are projected. */
interface InspectorReport {
    complete: boolean;
    stage: InspectorStage;
    policyValid: boolean;
    journalValid: boolean;
    pending: boolean | null;
    kind: ConnectorEffectKind | null;
    groupConfirmed: boolean;
    progress: boolean;
    response: boolean;
    termination: ExecutionTermination | null;
    failure: ExecutionFailure | null;
    setupFailure: ExecutionSetupFailure | null;
    workspace: InspectorCapture;
    workspaceFailure: WorkspaceIdentityFailure | null;
    cgroup: InspectorCapture;
}
/** Assertions cannot include private data in the public failure projection. */
function requireInspector(condition: boolean): void {
    if (!condition) {
        throw new Error('Retained fixture inspection refused');
    }
}
/** Exact bounded operator input is decoded before opening any fixture data. */
async function settings(): Promise<InspectorSettings> {
    requireInspector(process.argv.length === 2 && process.getuid?.() === 0);
    const chunks: Buffer[] = [];
    let size: number = 0;
    const timer: NodeJS.Timeout = setTimeout((): void => {
        process.stdin.destroy(new Error('Inspector input deadline'));
    }, 3000);
    try {
        for await (const part of process.stdin) {
            const bytes: unknown = part;
            if (!Buffer.isBuffer(bytes)) {
                throw new Error('Invalid inspector bytes');
            }
            size += bytes.byteLength;
            requireInspector(size <= 12288);
            chunks.push(bytes);
        }
    } finally {
        clearTimeout(timer);
    }
    const raw: unknown = JSON.parse(
        new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, size)),
    );
    const value: Readonly<Record<string, unknown>> = Boundary.record(raw, ['directory', 'helper']);
    const directory: string = ProtectedFiles.path(value['directory']);
    const helper: string = ProtectedFiles.path(value['helper']);
    for (const path of [directory, helper]) {
        requireInspector(
            resolve(path) === path &&
                Buffer.byteLength(path) <= 4096 &&
                (await realpath(path)) === path,
        );
    }
    await ProtectedFiles.directory(directory);
    const info: BigIntStats = await lstat(directory, { bigint: true });
    requireInspector(info.isDirectory() && info.uid === 0n && (info.mode & 0o777n) === 0o700n);
    return { directory, helper };
}
/** Readonly decoding does not open the journal's mutation lock, repair its contents, or load an enforcing policy owner. */
async function inspect(): Promise<InspectorReport> {
    const report: InspectorReport = {
        complete: false,
        stage: InspectorStage.Input,
        policyValid: false,
        journalValid: false,
        pending: null,
        kind: null,
        groupConfirmed: false,
        progress: false,
        response: false,
        termination: null,
        failure: null,
        setupFailure: null,
        workspace: InspectorCapture.NotRun,
        workspaceFailure: null,
        cgroup: InspectorCapture.NotRun,
    };
    try {
        const input: InspectorSettings = await settings();
        report.stage = InspectorStage.Locate;
        const entries: readonly string[] = await readdir(input.directory);
        requireInspector(entries.length <= 32);
        const candidates: readonly string[] = entries.filter((name: string): boolean =>
            /^\.nerva-exec-qualification-[A-Za-z0-9]+$/u.test(name),
        );
        requireInspector(candidates.length === 1);
        const name: string | undefined = candidates[0];
        if (name === undefined) {
            throw new Error('Unique fixture required');
        }
        const fixture: string = join(input.directory, name);
        await ProtectedFiles.directory(fixture);
        const lane: string = join(fixture, 'durable-capture-before-effect');
        await ProtectedFiles.directory(lane);
        report.stage = InspectorStage.Policy;
        const definition: ExecutionPolicyDefinition = ExecutionPolicyCodec.policy(
            JSON.parse(
                (
                    await ProtectedFiles.readPrivate(join(fixture, 'execution-policy.json'), 65536)
                ).toString('utf8'),
            ),
        );
        const root: ExecutionRootPolicy | undefined = definition.roots.find(
            (value: ExecutionRootPolicy): boolean => value.id === 'project',
        );
        requireInspector(
            definition.roots.length === 1 &&
                root?.path === join(fixture, 'workspace') &&
                definition.runtimeDirectory === join(fixture, 'runtime'),
        );
        if (root === undefined) {
            throw new Error('Fixture root missing');
        }
        report.policyValid = true;
        report.stage = InspectorStage.Key;
        const raw: unknown = JSON.parse(
            (await ProtectedFiles.readPrivate(join(lane, 'device.json'), 16384)).toString('utf8'),
        );
        const configuration: Readonly<Record<string, unknown>> = Boundary.record(raw, [
            'authorityId',
            'authorityPublicKeyFile',
            'environmentId',
            'enrollmentId',
            'slot',
            'endpoints',
            'privateKeyFile',
            'serverCaFile',
            'files',
            'execution',
        ]);
        requireInspector(
            configuration['privateKeyFile'] === join(lane, 'device-key.json') &&
                configuration['authorityPublicKeyFile'] === join(lane, 'authority.json'),
        );
        const enrollment: string = ConnectorEnrollmentCodec.id(configuration['enrollmentId']);
        const secret: Buffer = await ProtectedFiles.readPrivate(
            join(lane, 'device-key.json'),
            IdentityLengths.privateRecord,
        );
        let decoded: SigningKey;
        try {
            decoded = SigningKey.decode(secret);
        } finally {
            secret.fill(0);
        }
        using key: SigningKey = decoded;
        report.stage = InspectorStage.Journal;
        const codec: ExecutionJournalCodec = new ExecutionJournalCodec(ExecutionLane.First);
        const directory: string = join(lane, 'state', ExecutionLane.First);
        using cipher: ConnectorJournalCipher<
            ConnectorJournalSnapshot<ExecutionRequest, ExecutionResult, ExecutionOutput>
        > = ConnectorJournalCipher.create(
            directory,
            enrollment,
            key,
            codec.purpose,
            new ConnectorJournalState(codec),
        );
        const snapshot: ConnectorJournalSnapshot<
            ExecutionRequest,
            ExecutionResult,
            ExecutionOutput
        > = cipher.decode(
            await ProtectedFiles.readPrivate(
                join(directory, 'execution-journal'),
                ConnectorJournalLimits.recordBytes,
            ),
        ).state;
        report.journalValid = true;
        report.pending = snapshot.pending !== null;
        report.kind = snapshot.pending?.effectContext.kind ?? null;
        report.groupConfirmed =
            snapshot.pending?.effectContext.kind === ConnectorEffectKind.CapturedExecution &&
            snapshot.pending.effectContext.group !== null;
        report.progress =
            snapshot.pending?.progress !== null && snapshot.pending?.progress !== undefined;
        report.response =
            snapshot.pending?.response !== null && snapshot.pending?.response !== undefined;
        report.termination = snapshot.pending?.response?.termination ?? null;
        report.failure = snapshot.pending?.response?.failure ?? null;
        report.setupFailure = snapshot.pending?.response?.setupFailure ?? null;
        report.stage = InspectorStage.Helper;
        await using helper: FileHandle = await ConnectorNativeExecutable.open(
            input.helper,
            'c6a62a61ca7312ede36ecfb53a657b56e30c39844f6f88fc9792f4a16509869f',
        );
        await using capture: WorkspaceIdentityProcess = new WorkspaceIdentityProcess();
        report.stage = InspectorStage.Workspace;
        await using workspace: FileHandle = await open(
            root.path,
            constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
        );
        const captured: WorkspaceIdentityResult = await capture.inspect({
            descriptor: workspace.fd,
            helperDescriptor: helper.fd,
            access:
                root.access === ExecutionWorkspaceAccess.ReadWrite
                    ? ConnectorFileMode.ReadWrite
                    : ConnectorFileMode.ReadOnly,
            signal: AbortSignal.timeout(3000),
        });
        report.workspace = captured.ok ? InspectorCapture.Success : InspectorCapture.Failed;
        report.workspaceFailure = captured.ok ? null : captured.error;
        report.stage = InspectorStage.Cgroup;
        const membership: string = await readFile('/proc/self/cgroup', 'utf8');
        requireInspector(Buffer.byteLength(membership) <= 4096);
        const match: RegExpExecArray | null = /^0::(\/[^\n]*)\n$/u.exec(membership);
        const relative: string | undefined = match?.[1];
        requireInspector(
            relative !== undefined && relative !== '/' && !relative.split('/').includes('..'),
        );
        if (relative === undefined) {
            throw new Error('Current group missing');
        }
        await using group: FileHandle = await open(
            '/sys/fs/cgroup' + relative,
            constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
        );
        try {
            await capture.cgroup({
                descriptor: group.fd,
                helperDescriptor: helper.fd,
                signal: AbortSignal.timeout(3000),
            });
            report.cgroup = InspectorCapture.Success;
        } catch {
            report.cgroup = InspectorCapture.Failed;
        }
        report.stage = InspectorStage.Complete;
        report.complete = true;
    } catch {
        report.complete = false;
    }
    return report;
}
const report: InspectorReport = await inspect();
process.stdout.write(JSON.stringify(report) + '\n');
process.exitCode = report.complete ? 0 : 1;
