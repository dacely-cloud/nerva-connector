// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

import { constants } from 'node:fs';
import {
    ExecutionEffectTrace,
    ExecutionFreshPhase,
    type ExecutionFreshTrace,
} from './ExecutionEffectTrace.js';
import {
    mkdir,
    open,
    readFile,
    rename,
    rm,
    rmdir,
    writeFile,
    type FileHandle,
} from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { ExecutionInvocation } from 'nerva-connector-protocol/execution/ExecutionPolicyTypes.js';
import type { ExecutionEffectAdmission } from '../../src/execution/ExecutionEffectAdmission.js';
import type {
    ExecutionOutput,
    ExecutionOutputSink,
} from 'nerva-connector-protocol/execution/ExecutionOutput.js';
import {
    ExecutionFailure,
    type ExecutionResult,
} from 'nerva-connector-protocol/execution/ExecutionTypes.js';
import type {
    ExecutionPermit,
    ExecutionCompletion,
    ExecutionRequest,
} from 'nerva-connector-protocol/execution/ExecutionJobs.js';
import type { ExecutionCgroupIdentity } from '../../src/execution/ExecutionCgroupIdentity.js';
import { ExecutionCgroupIdentityCodec } from '../../src/execution/ExecutionCgroupIdentityCodec.js';
import { ExecutionProof } from 'nerva-connector-protocol/execution/ExecutionProof.js';
import { ExecutionPolicy } from '../../src/execution/ExecutionPolicy.js';
import {
    ConnectorEffectKind,
    type ConnectorCapturedExecutionEffect,
    type ConnectorEffectContext,
} from '../../src/runtime/ConnectorEffectContext.js';
import { ConnectorOperationJournal } from '../../src/runtime/ConnectorOperationJournal.js';
import type { ConnectorJournalSnapshot } from '../../src/runtime/ConnectorJournalState.js';
import { ConnectorNativeExecutable } from '../../src/runtime/ConnectorNativeExecutable.js';
import { WorkspaceIdentityProcess } from '../../src/workspace/WorkspaceIdentityProcess.js';
import {
    ExecutionEffectQualificationState,
    type ExecutionEffectLane,
} from './ExecutionEffectQualificationState.js';
import { ExecutionEffectQualificationCanary } from './ExecutionEffectQualificationCanary.js';
import {
    ExecutionEffectCase,
    ExecutionEffectPayload,
    requireEffect,
} from './ExecutionEffectQualificationTypes.js';

/** All mutations are confined to one controller-owned fixture and reversible pathname test occupants. */
export class ExecutionEffectQualificationCases {
    #trace: ExecutionFreshTrace | null = null;
    /** Passive diagnostic metadata belongs only to the fresh case, never any private command data. */
    public get trace(): ExecutionFreshTrace | null {
        return this.#trace;
    }
    /** Runtime bytes and captured policy are shared; every original has a separate private journal. */
    public constructor(public readonly state: ExecutionEffectQualificationState) {}

    /** No case can silently substitute another original, policy, lane or root. */
    public async run(label: ExecutionEffectCase): Promise<void> {
        const lane: ExecutionEffectLane = this.state.lane(label);
        const permit: ExecutionPermit = await this.state.permit(
            lane,
            label === ExecutionEffectCase.Recovery
                ? ExecutionEffectPayload.OutputHold
                : ExecutionEffectPayload.Effect,
        );
        await writeFile(join(this.state.fixture.workspace, 'effects'), '', { mode: 0o600 });
        if (label === ExecutionEffectCase.Fresh) {
            await this.#fresh(lane, permit);
        } else if (label === ExecutionEffectCase.Recovery) {
            await this.#prefix(lane, permit);
        } else if (label === ExecutionEffectCase.Pinned) {
            await this.#pinned(lane, permit);
        } else if (label === ExecutionEffectCase.Terminal) {
            await this.#terminal(lane, permit);
        } else {
            await this.#canary(lane, permit, label);
        }
    }

    async #id(lane: ExecutionEffectLane, permit: ExecutionPermit): Promise<string> {
        return ExecutionProof.cgroupId((await this.state.read(lane)).journalId, permit);
    }

    async #fresh(lane: ExecutionEffectLane, permit: ExecutionPermit): Promise<void> {
        using trace: ExecutionEffectTrace = new ExecutionEffectTrace();
        trace.phase = ExecutionFreshPhase.Dispatch;
        const policy: ExecutionPolicy = this.state.policy;
        const original: typeof policy.execute = policy.execute.bind(policy);
        let observed: boolean = false;
        policy.execute = async (
            request: ExecutionInvocation,
            id: string,
            signal: AbortSignal,
            admission: ExecutionEffectAdmission,
            output: ExecutionOutputSink | null,
        ): Promise<ExecutionResult> => {
            try {
                return await original(
                    request,
                    id,
                    signal,
                    {
                        ...admission,
                        context: admission.context,
                        commit: async (group: ExecutionCgroupIdentity): Promise<void> => {
                            trace.phase = ExecutionFreshPhase.JournalCommit;
                            await admission.commit(group);
                            trace.phase = ExecutionFreshPhase.JournalDecode;
                            const snapshot: ConnectorJournalSnapshot<
                                ExecutionRequest,
                                ExecutionResult,
                                ExecutionOutput
                            > = await this.state.read(lane);
                            const context: ConnectorEffectContext | undefined =
                                snapshot.pending?.effectContext;
                            requireEffect(
                                context?.kind === ConnectorEffectKind.CapturedExecution &&
                                    context.group !== null &&
                                    ExecutionCgroupIdentityCodec.same(context.group, group),
                            );
                            requireEffect(
                                snapshot.pending?.response === null &&
                                    snapshot.pending.progress === null,
                            );
                            trace.phase = ExecutionFreshPhase.Group;
                            requireEffect(
                                (await readFile(
                                    join(
                                        this.state.fixture.delegation,
                                        'exec-' + id,
                                        'cgroup.procs',
                                    ),
                                    'utf8',
                                )) === '',
                            );
                            trace.phase = ExecutionFreshPhase.Root;
                            requireEffect(
                                (await readFile(
                                    join(this.state.fixture.workspace, 'effects'),
                                    'utf8',
                                )) === '',
                            );
                            observed = true;
                            trace.phase = ExecutionFreshPhase.Observed;
                        },
                    },
                    output,
                );
            } catch (caught: unknown) {
                trace.failure(caught);
                throw caught;
            }
        };
        try {
            const result: ExecutionCompletion = await this.state.execute(lane, permit);
            trace.phase = ExecutionFreshPhase.Returned;
            requireEffect(observed && result.response.exitCode === 0);
            const snapshot: ConnectorJournalSnapshot<
                ExecutionRequest,
                ExecutionResult,
                ExecutionOutput
            > = await this.state.read(lane);
            requireEffect(
                snapshot.pending?.effectContext.kind === ConnectorEffectKind.CapturedExecution &&
                    snapshot.pending.effectContext.group !== null &&
                    snapshot.pending.response?.exitCode === 0,
            );
            requireEffect(
                (await readFile(join(this.state.fixture.workspace, 'effects'), 'utf8')) === 'x',
            );
        } catch (caught: unknown) {
            trace.failure(caught);
            throw caught;
        } finally {
            this.#trace = trace.snapshot();
            policy.execute = original;
        }
    }

    async #prefix(lane: ExecutionEffectLane, permit: ExecutionPermit): Promise<void> {
        const context: ConnectorCapturedExecutionEffect =
            await this.state.policy.effectContext('project');
        const id: string = await this.#id(lane, permit);
        const cancel: AbortController = new AbortController();
        let prefix: ExecutionOutput | null = null;
        {
            await using journal: ConnectorOperationJournal<
                ExecutionRequest,
                ExecutionResult,
                ExecutionOutput
            > = await this.state.journal(lane);
            await journal.begin(permit, context);
            const result: ExecutionResult = await this.state.policy.execute(
                {
                    policySha256: permit.request.policySha256,
                    programId: permit.request.programId,
                    rootId: permit.request.rootId,
                    arguments: permit.request.arguments,
                },
                id,
                cancel.signal,
                {
                    context,
                    expiresAtMs: permit.expiresAtMs,
                    assertLaunch: (): void => {
                        if (BigInt(Date.now()) >= permit.expiresAtMs) {
                            throw new Error('Fixture start expired');
                        }
                    },
                    commit: async (group: ExecutionCgroupIdentity): Promise<void> => {
                        await journal.bindExecutionGroup(permit, group);
                    },
                },
                {
                    retain: async (output: ExecutionOutput): Promise<void> => {
                        await journal.retain(permit, output);
                        prefix = output;
                        if (
                            Buffer.from(output.stdoutBase64, 'base64').byteLength === 4096 &&
                            output.stderrBase64 === 'AP5F'
                        ) {
                            cancel.abort();
                        }
                    },
                },
            );
            requireEffect(result.failure === ExecutionFailure.Cancelled && prefix !== null);
        }
        const saved: ConnectorJournalSnapshot<ExecutionRequest, ExecutionResult, ExecutionOutput> =
            await this.state.read(lane);
        requireEffect(
            saved.pending?.response === null &&
                saved.pending.progress !== null &&
                saved.pending.effectContext.kind === ConnectorEffectKind.CapturedExecution &&
                saved.pending.effectContext.group !== null,
        );
        const expected: ExecutionOutput | null | undefined = saved.pending?.progress;
        requireEffect(
            expected !== null &&
                expected !== undefined &&
                Buffer.from(expected.stdoutBase64, 'base64').byteLength === 4096 &&
                expected.stderrBase64 === 'AP5F',
        );
        const response: ExecutionCompletion = await this.state.execute(lane, permit);
        requireEffect(
            response.response.failure === ExecutionFailure.Interrupted &&
                response.response.stdoutBase64 === expected?.stdoutBase64 &&
                response.response.stderrBase64 === expected.stderrBase64,
        );
        requireEffect(
            (await readFile(join(this.state.fixture.workspace, 'effects'), 'utf8')) === 'x',
        );
    }

    async #workspace(work: (retained: string) => Promise<void>): Promise<void> {
        const path: string = this.state.fixture.workspace;
        const retained: string = path + '-original';
        await rename(path, retained);
        await mkdir(path, { mode: 0o755 });
        await writeFile(join(path, 'effects'), 'FOREIGN ROOT', { mode: 0o600 });
        try {
            await work(retained);
        } finally {
            await rm(path, { recursive: true });
            await rename(retained, path);
        }
    }

    async #pinned(lane: ExecutionEffectLane, permit: ExecutionPermit): Promise<void> {
        await this.state.policy.effectContext('project');
        await this.#workspace(async (retained: string): Promise<void> => {
            const result: ExecutionCompletion = await this.state.execute(lane, permit);
            requireEffect(result.response.exitCode === 0);
            requireEffect((await readFile(join(retained, 'effects'), 'utf8')) === 'x');
            requireEffect(
                (await readFile(join(this.state.fixture.workspace, 'effects'), 'utf8')) ===
                    'FOREIGN ROOT',
            );
        });
    }

    async #terminal(lane: ExecutionEffectLane, permit: ExecutionPermit): Promise<void> {
        const original: ExecutionCompletion = await this.state.execute(lane, permit);
        requireEffect(original.response.exitCode === 0);
        const context: ConnectorCapturedExecutionEffect =
            await this.state.policy.effectContext('project');
        const id: string = await this.#id(lane, permit);
        await using foreign: ExecutionEffectQualificationCanary =
            await ExecutionEffectQualificationCanary.create(context, id);
        await foreign.start(
            this.state.interpreter,
            join(lane.settings.stateDirectory, 'foreign-effects'),
            join(lane.settings.stateDirectory, 'heartbeat'),
        );
        const cipher: Buffer = await this.state.cipher(lane);
        await this.#workspace(async (retained: string): Promise<void> => {
            const response: ExecutionCompletion = await this.state.execute(lane, permit);
            requireEffect(
                response.responseHash === original.responseHash &&
                    (await this.state.cipher(lane)).equals(cipher),
            );
            await foreign.alive();
            requireEffect((await readFile(join(retained, 'effects'), 'utf8')) === 'x');
            requireEffect(
                (await readFile(join(this.state.fixture.workspace, 'effects'), 'utf8')) ===
                    'FOREIGN ROOT',
            );
        });
    }

    async #canary(
        lane: ExecutionEffectLane,
        permit: ExecutionPermit,
        label: ExecutionEffectCase,
    ): Promise<void> {
        const base: ConnectorCapturedExecutionEffect =
            await this.state.policy.effectContext('project');
        const id: string = await this.#id(lane, permit);
        await using resources: AsyncDisposableStack = new AsyncDisposableStack();
        const original: ExecutionEffectQualificationCanary = resources.use(
            await ExecutionEffectQualificationCanary.create(base, id),
        );
        const bootId: string = randomUUID();
        const captured: ConnectorCapturedExecutionEffect =
            label === ExecutionEffectCase.Boot
                ? { ...base, delegation: { ...base.delegation, bootId } }
                : base;
        {
            await using journal: ConnectorOperationJournal<
                ExecutionRequest,
                ExecutionResult,
                ExecutionOutput
            > = await this.state.journal(lane);
            await journal.begin(permit, captured);
            if (label !== ExecutionEffectCase.Uncommitted) {
                await journal.bindExecutionGroup(
                    permit,
                    label === ExecutionEffectCase.Boot
                        ? { ...original.identity, bootId }
                        : original.identity,
                );
            }
            const prefix: ExecutionOutput = await original.start(
                this.state.interpreter,
                join(lane.settings.stateDirectory, 'original-effects'),
                join(lane.settings.stateDirectory, 'original-heartbeat'),
            );
            if (label !== ExecutionEffectCase.Uncommitted) {
                await journal.retain(permit, prefix);
            }
        }
        if (label === ExecutionEffectCase.Cleanup) {
            await this.#workspace(async (retained: string): Promise<void> => {
                const response: ExecutionCompletion = await this.state.execute(lane, permit);
                requireEffect(
                    response.response.failure === ExecutionFailure.Interrupted &&
                        response.response.stdoutBase64 === '77u/AP8=' &&
                        response.response.stderrBase64 === 'AP5F',
                );
                await original.killed();
                requireEffect((await readFile(join(retained, 'effects'), 'utf8')) === '');
                requireEffect(
                    (await readFile(join(this.state.fixture.workspace, 'effects'), 'utf8')) ===
                        'FOREIGN ROOT',
                );
                requireEffect(
                    (await readFile(
                        join(lane.settings.stateDirectory, 'original-effects'),
                        'utf8',
                    )) === 'x',
                );
            });
            return;
        }
        const cipher: Buffer = await this.state.cipher(lane);
        let foreign: ExecutionEffectQualificationCanary = original;
        try {
            if (
                label === ExecutionEffectCase.Reincarnated ||
                label === ExecutionEffectCase.Parent
            ) {
                await original[Symbol.asyncDispose]();
                let next: ConnectorCapturedExecutionEffect = base;
                if (label === ExecutionEffectCase.Parent) {
                    await rmdir(this.state.fixture.delegation);
                    await mkdir(this.state.fixture.delegation);
                    await writeFile(
                        join(this.state.fixture.delegation, 'cgroup.subtree_control'),
                        '+cpu +memory +pids',
                    );
                    const helper: FileHandle = resources.use(
                        await ConnectorNativeExecutable.open(
                            base.cgroupHelperFile,
                            base.cgroupHelperSha256,
                        ),
                    );
                    const capture: WorkspaceIdentityProcess = resources.use(
                        new WorkspaceIdentityProcess(),
                    );
                    const parent: FileHandle = resources.use(
                        await open(
                            this.state.fixture.delegation,
                            constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
                        ),
                    );
                    next = {
                        ...base,
                        delegation: await capture.cgroup({
                            descriptor: parent.fd,
                            helperDescriptor: helper.fd,
                            signal: AbortSignal.timeout(3000),
                        }),
                    };
                }
                foreign = resources.use(await ExecutionEffectQualificationCanary.create(next, id));
                await foreign.start(
                    this.state.interpreter,
                    join(lane.settings.stateDirectory, 'foreign-effects'),
                    join(lane.settings.stateDirectory, 'foreign-heartbeat'),
                );
            }
            let refused: boolean = false;
            try {
                await this.state.execute(lane, permit);
            } catch {
                refused = true;
            }
            requireEffect(refused && (await this.state.cipher(lane)).equals(cipher));
            await foreign.alive();
            requireEffect(
                (await readFile(join(this.state.fixture.workspace, 'effects'), 'utf8')) === '',
            );
            requireEffect(
                (await readFile(join(lane.settings.stateDirectory, 'original-effects'), 'utf8')) ===
                    'x',
            );
        } finally {
            await resources[Symbol.asyncDispose]();
        }
    }
}
