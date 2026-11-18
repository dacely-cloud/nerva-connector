// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

import { createHash, randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { ExecutionInputJournalFixture } from './ExecutionInputJournalFixture.js';
import { ExecutionPipeFixture, ExecutionPipeProbe } from './ExecutionPipeFixture.js';
import { ConnectorOperationJournal } from '../../src/runtime/ConnectorOperationJournal.js';
import {
    ConnectorEffectKind,
    type ConnectorCapturedInteractiveExecutionEffect,
} from '../../src/runtime/ConnectorEffectContext.js';
import { ExecutionInteractiveOwnership } from '../../src/execution/ExecutionInteractiveOwnership.js';
import { ExecutionJournalCodec } from '../../src/execution/ExecutionJournalCodec.js';
import { ExecutionProof } from 'nerva-connector-protocol/execution/ExecutionProof.js';
import { ConnectorAuthorizationProof } from 'nerva-connector-protocol/protocol/ConnectorAuthorizationProof.js';
import { ExecutionAppArmorMode } from '../../src/execution/ExecutionAppArmorProfile.js';
import { ExecutionBootstrapInputKind } from '../../src/execution/ExecutionBootstrapInput.js';
import { ExecutionInteractiveTransport } from 'nerva-connector-protocol/execution/ExecutionInteractive.js';
import { ExecutionMachineMode } from 'nerva-connector-protocol/execution/ExecutionMachineInvocation.js';
import { ExecutionInteractiveLaunchCodec } from 'nerva-connector-protocol/execution/ExecutionInteractiveLaunchCodec.js';
import {
    ExecutionWorkspaceAccess,
    type ExecutionResult,
} from 'nerva-connector-protocol/execution/ExecutionTypes.js';
import type { ExecutionOutput } from 'nerva-connector-protocol/execution/ExecutionOutput.js';
import type {
    ExecutionRequest,
    ExecutionPermit,
    ExecutionCompletion,
} from 'nerva-connector-protocol/execution/ExecutionJobs.js';
import { SignaturePurpose } from 'nerva-connector-protocol/identity/IdentityFormat.js';
import type {
    ExecutionInteractiveInvocationRule,
    ExecutionInteractiveLaunch,
} from 'nerva-connector-protocol/execution/ExecutionInteractiveInvocation.js';
import type { ExecutionInteractiveNativeBinding } from '../../src/execution/ExecutionInteractiveOwnershipTypes.js';
import { ExecutionLaunchAdmission } from '../../src/execution/ExecutionLaunchAdmission.js';
import { ExecutionInputJournalPhase } from '../../src/execution/ExecutionInputJournalTypes.js';

/** Actual kernel capture/group/Ready and two encrypted journals are composed without bypassing the unpublished production policy gate. */
export class ExecutionInteractiveOwnershipFixture implements AsyncDisposable {
    readonly #resources: AsyncDisposableStack;
    private constructor(
        resources: AsyncDisposableStack,
        public readonly signed: ExecutionInputJournalFixture,
        public readonly native: ExecutionPipeFixture,
        public readonly main: ConnectorOperationJournal<
            ExecutionRequest,
            ExecutionResult,
            ExecutionOutput
        >,
        public readonly owner: ExecutionInteractiveOwnership,
        public readonly binding: ExecutionInteractiveNativeBinding,
        public readonly context: ConnectorCapturedInteractiveExecutionEffect,
        public readonly permit: ExecutionPermit,
        public readonly stop: AbortController,
        public readonly task: Promise<ExecutionResult>,
        public readonly joined: Promise<readonly PromiseSettledResult<ExecutionResult>[]>,
    ) {
        this.#resources = resources;
    }
    /** Only the test chooses its fixed probe grant; no account/API, installed policy or capability publication is claimed. */
    public static async create(
        helper: string,
        initial: string = '',
        action: ExecutionPipeProbe = ExecutionPipeProbe.Echo,
        timeoutMs: number = 3000,
    ): Promise<ExecutionInteractiveOwnershipFixture> {
        await using resources: AsyncDisposableStack = new AsyncDisposableStack();
        const signed: ExecutionInputJournalFixture = resources.use(
            await ExecutionInputJournalFixture.create(),
        );
        const native: ExecutionPipeFixture = resources.use(
            await ExecutionPipeFixture.create(helper),
        );
        const base: ExecutionPermit = signed.permit(signed.admission());
        const rule: ExecutionInteractiveInvocationRule = {
            ...signed.rule(),
            invocation: {
                ...signed.rule().invocation,
                shell: null,
                commands: [{ alias: 'probe', executableIndex: 0 }],
                maximumScriptBytes: 0,
            },
        };
        const nowMs: bigint = BigInt(Date.now());
        const launch: ExecutionInteractiveLaunch = {
            transport: ExecutionInteractiveTransport.Pipe,
            invocation: {
                mode: ExecutionMachineMode.Argv,
                command: 'probe',
                argv: [action],
                cwd: 'nested',
                environment: [{ name: 'APP_MODE', value: 'fixture' }],
                stdin: initial,
                timeoutMs,
            },
            executionDeadlineMs: nowMs + BigInt(timeoutMs),
            dimensions: null,
        };
        const request: ExecutionRequest = {
            ...base.request,
            arguments: [ExecutionInteractiveLaunchCodec.encode(rule, launch)],
        };
        const requestHash: string = ExecutionProof.requestHash(request);
        const { signature: _signature, ...original }: ExecutionPermit = base;
        const body: Omit<ExecutionPermit, 'signature'> = {
            ...original,
            request,
            requestHash,
            admissionHash: ConnectorAuthorizationProof.execution(
                requestHash,
                base.lane,
                base.authorization,
            ),
            issuedAtMs: nowMs,
            expiresAtMs: nowMs + 1000n,
            executionDeadlineMs: launch.executionDeadlineMs,
        };
        const permit: ExecutionPermit = {
            ...body,
            signature: signed.peer.authority.sign(
                SignaturePurpose.OperationExecutionPermit,
                ExecutionProof.permit(body),
            ),
        };
        const codec: ExecutionJournalCodec = new ExecutionJournalCodec(permit.lane);
        await ConnectorOperationJournal.initialize(
            signed.directory,
            signed.peer.identity.settings.enrollmentId,
            signed.peer.identity.key,
            codec,
        );
        const main: ConnectorOperationJournal<ExecutionRequest, ExecutionResult, ExecutionOutput> =
            resources.use(
                await ConnectorOperationJournal.load(
                    signed.directory,
                    signed.peer.identity.settings.enrollmentId,
                    signed.peer.identity.key,
                    codec,
                ),
            );
        const admission: Awaited<ReturnType<ExecutionPipeFixture['native']['admission']>> =
            await native.native.admission();
        const context: ConnectorCapturedInteractiveExecutionEffect = {
            kind: ConnectorEffectKind.CapturedInteractiveExecution,
            incarnation: randomBytes(32).toString('hex'),
            policySha256: permit.request.policySha256,
            rootId: permit.request.rootId,
            root: admission.workspaceIdentity,
            cgroupRoot: native.native.delegation,
            cgroupHelperFile: native.native.helperFile,
            cgroupHelperSha256: createHash('sha256')
                .update(await readFile(native.native.helperFile))
                .digest('hex'),
            delegation: admission.delegationIdentity,
            group: null,
        };
        await main.begin(permit, context);
        const owner: ExecutionInteractiveOwnership = resources.use(
            await ExecutionInteractiveOwnership.open(
                signed.peer.identity,
                {
                    policyFile: '/qualification-only/no-policy-publication',
                    stateDirectory: signed.root,
                    lane: permit.lane,
                },
                main,
                (): void => {},
            ),
        );
        const stop: AbortController = new AbortController();
        const launchAdmission: ExecutionLaunchAdmission = new ExecutionLaunchAdmission(
            permit,
            signed.session,
            main,
            stop.signal,
        );
        launchAdmission.assert();
        const binding: ExecutionInteractiveNativeBinding = await owner.prepare(
            permit,
            signed.session,
            { rule, launch },
            context,
            (): void => stop.abort(),
        );
        const configuration: Awaited<ReturnType<ExecutionPipeFixture['native']['configuration']>> =
            await native.native.configuration(
                action,
                ExecutionWorkspaceAccess.ReadWrite,
                ExecutionAppArmorMode.Pipe,
            );
        launchAdmission.assert();
        const nativeTask: Promise<ExecutionResult> = native.native.sandbox.execute(
            ExecutionProof.cgroupId(main.id, permit),
            {
                ...configuration,
                admissionExpiresAtMs: launchAdmission.expiresAtMs,
                input: {
                    kind: ExecutionBootstrapInputKind.Pipe,
                    executionDeadlineMs: launch.executionDeadlineMs,
                    cwd: launch.invocation.cwd,
                    environment: launch.invocation.environment,
                    stdin: launch.invocation.stdin,
                    incarnation: binding.incarnation,
                    guardianProfile: configuration.apparmorProfile.replace(
                        'nerva-connector-exec-',
                        'nerva-connector-guard-',
                    ),
                    maximumInputBytes: rule.maximumInputBytes,
                    maximumControls: rule.maximumControls,
                },
            },
            native.native.limits,
            timeoutMs,
            stop.signal,
            {
                ...admission,
                expiresAtMs: launchAdmission.expiresAtMs,
                assertLaunch: (): void => launchAdmission.assert(),
                commit: async (
                    group: Parameters<typeof main.bindExecutionGroup>[1],
                ): Promise<void> => {
                    if (owner.journal.recordState().phase !== ExecutionInputJournalPhase.Prepared) {
                        throw new Error('Actual group bind preceded durable preparation');
                    }
                    await main.bindExecutionGroup(permit, group);
                },
            },
            null,
            binding.pipe,
        );
        const observed: Promise<readonly PromiseSettledResult<ExecutionResult>[]> =
            Promise.allSettled([nativeTask]);
        const task: Promise<ExecutionResult> = (async (): Promise<ExecutionResult> => {
            try {
                await binding.ready();
                const result: ExecutionResult = await nativeTask;
                await binding.completed();
                return await main.finish(permit, result);
            } catch (caught: unknown) {
                stop.abort();
                await observed;
                throw caught;
            }
        })();
        const joined: Promise<readonly PromiseSettledResult<ExecutionResult>[]> =
            Promise.allSettled([task]);
        resources.defer(async (): Promise<void> => {
            stop.abort();
            await joined;
        });
        await binding.ready();
        return new ExecutionInteractiveOwnershipFixture(
            resources.move(),
            signed,
            native,
            main,
            owner,
            binding,
            context,
            permit,
            stop,
            task,
            joined,
        );
    }
    /** The device signs only the actual retained native result under this exact current original. */
    public completion(result: ExecutionResult): ExecutionCompletion {
        const body: Omit<ExecutionCompletion, 'signature'> = {
            lane: this.permit.lane,
            environmentId: this.permit.environmentId,
            enrollmentId: this.permit.enrollmentId,
            leaseId: this.permit.leaseId,
            jobId: this.permit.jobId,
            sequence: this.permit.sequence,
            dispatchId: this.permit.dispatchId,
            requestHash: this.permit.requestHash,
            admissionHash: this.permit.admissionHash,
            responseHash: ExecutionProof.responseHash(result),
            response: result,
        };
        return {
            ...body,
            signature: this.signed.peer.device.sign(
                SignaturePurpose.OperationExecutionResult,
                ExecutionProof.completion(body),
            ),
        };
    }
    /** Fixture cleanup stops native descendants before releasing either journal, key or physical capability. */
    public async [Symbol.asyncDispose](): Promise<void> {
        await this.#resources[Symbol.asyncDispose]();
    }
}
