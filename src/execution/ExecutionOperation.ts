// SPDX-FileCopyrightText: 2026 Dacely <business@dacely.com>
// SPDX-License-Identifier: LicenseRef-Proprietary

import { ConnectorAuthorizationKind } from 'nerva-connector-protocol/protocol/ConnectorAuthorization.js';
import { ConnectorAuthorizationCodec } from 'nerva-connector-protocol/protocol/ConnectorAuthorizationCodec.js';
import {
    ConnectorEffectKind,
    type ConnectorEffectContext,
} from '../runtime/ConnectorEffectContext.js';
import type { ExecutionCgroupIdentity } from './ExecutionCgroupIdentity.js';
import type { ConnectorOperationDispatch } from 'nerva-connector-protocol/protocol/ConnectorOperationDispatch.js';
import type {
    ConnectorOperationJournal,
    ConnectorJournalClaim,
} from '../runtime/ConnectorOperationJournal.js';
import type {
    ExecutionRequest,
    ExecutionPermit,
    ExecutionCancellation,
} from 'nerva-connector-protocol/execution/ExecutionJobs.js';
import type { ExecutionPolicy } from './ExecutionPolicy.js';
import type { ExecutionOutput } from 'nerva-connector-protocol/execution/ExecutionOutput.js';
import { ExecutionOutputRetentionError } from './ExecutionOutputRetentionError.js';
import { ExecutionCgroup } from './ExecutionCgroup.js';
import { ExecutionProof } from 'nerva-connector-protocol/execution/ExecutionProof.js';
import { ExecutionResultCodec } from './ExecutionResultCodec.js';
import {
    ExecutionFailure,
    ExecutionTermination,
    type ExecutionResult,
} from 'nerva-connector-protocol/execution/ExecutionTypes.js';
import { ExecutionLaunchAdmission } from './ExecutionLaunchAdmission.js';
import { randomBytes } from 'node:crypto';
import type { ConnectorClientSession } from '../runtime/ConnectorClientSession.js';
import type { ExecutionInteractiveOwnership } from './ExecutionInteractiveOwnership.js';
import type {
    ExecutionInteractiveNativeBinding,
    ExecutionInteractiveResolution,
} from './ExecutionInteractiveOwnershipTypes.js';
import type {
    ConnectorActivityHandle,
    ConnectorActivitySink,
} from '../runtime/ConnectorActivity.js';
import { ConnectorActivityLane } from '../runtime/ConnectorActivityLane.js';

/** One original command owns its abort signal and durable result independently of any transport connection. */
export class ExecutionOperation implements AsyncDisposable {
    #task: Promise<ExecutionResult> | null = null;
    #dispatch: ConnectorOperationDispatch<ExecutionRequest> | null = null;
    #stop: AbortController | null = null;
    #closed: boolean = false;
    #failed: boolean = false;

    /**
     * The signed client validates authority before entering this internal owner; it retains resource disposal ownership.
     *
     * @param activity - Receives each launched command and verified stop for the local activity screen; it never changes one
     */
    public constructor(
        public readonly policy: ExecutionPolicy,
        public readonly journal: ConnectorOperationJournal<
            ExecutionRequest,
            ExecutionResult,
            ExecutionOutput
        >,
        public readonly authorize: (permit: ExecutionPermit) => Promise<void>,
        public readonly interactive: ExecutionInteractiveOwnership,
        public readonly committed: () => void = (): void => {},
        public readonly activity: ConnectorActivitySink | null = null,
    ) {}

    /** Unproven kernel cleanup or durable state failure forbids further work. */
    public get failed(): boolean {
        return this.#failed || this.policy.failed || this.journal.failed || this.interactive.failed;
    }

    /** A verified start either joins the exact original or creates one durable Started record before native effects. */
    public async execute(
        permit: ExecutionPermit,
        session: ConnectorClientSession,
    ): Promise<ExecutionResult> {
        return await this.#join(permit, permit, session);
    }

    /** A verified stop aborts only the matching original; a stop received first durably seals it without invoking a program. */
    public async cancel(
        value: ExecutionCancellation,
        session: ConnectorClientSession,
    ): Promise<ExecutionResult> {
        return await this.#join(value, null, session);
    }

    /** Compaction must wait until native descendants and the terminal journal write have joined. */
    public async idle(): Promise<void> {
        await this.#task;
    }

    /** Owner shutdown joins effects; transport disconnect never calls this method. */
    public async [Symbol.asyncDispose](): Promise<void> {
        this.#closed = true;
        this.interactive.stopInput();
        this.#stop?.abort();
        await this.#task;
    }

    async #join(
        value: ExecutionPermit | ExecutionCancellation,
        permit: ExecutionPermit | null,
        session: ConnectorClientSession,
    ): Promise<ExecutionResult> {
        if (this.#closed || this.failed) {
            throw new Error('Execution operation unavailable');
        }
        let task: Promise<ExecutionResult> | null = this.#task;
        if (task !== null) {
            if (
                this.#dispatch?.jobId !== value.jobId ||
                this.#dispatch.sequence !== value.sequence ||
                this.#dispatch.dispatchId !== value.dispatchId ||
                this.#dispatch.requestHash !== value.requestHash ||
                this.#dispatch.admissionHash !== value.admissionHash ||
                ConnectorAuthorizationCodec.encode(this.#dispatch.authorization) !==
                    ConnectorAuthorizationCodec.encode(value.authorization)
            ) {
                throw new Error('Another original execution is in progress');
            }
            if (permit === null) {
                const stopping: ConnectorActivityHandle | null =
                    this.#stop?.signal.aborted === false
                        ? (this.activity?.begin(ConnectorActivityLane.commandStop(value)) ?? null)
                        : null;
                this.interactive.stopInput();
                this.#stop?.abort();
                stopping?.finish(true, null);
            }
        } else {
            const stop: AbortController = new AbortController();
            if (permit === null) {
                stop.abort();
            }
            this.#stop = stop;
            this.#dispatch = value;
            task = this.#perform(value, permit, stop, session);
            this.#task = task;
        }
        try {
            return await task;
        } finally {
            if (this.#task === task) {
                this.#task = null;
                this.#dispatch = null;
                this.#stop = null;
            }
        }
    }

    async #perform(
        value: ExecutionPermit | ExecutionCancellation,
        permit: ExecutionPermit | null,
        controller: AbortController,
        session: ConnectorClientSession,
    ): Promise<ExecutionResult> {
        const stop: AbortSignal = controller.signal;
        const freshJoint: boolean =
            this.journal.pending === null &&
            permit !== null &&
            permit.authorization.kind === ConnectorAuthorizationKind.Joint;
        if (freshJoint && permit !== null) {
            await this.authorize(permit);
        }
        const captureBudget: bigint =
            permit === null ? 0n : permit.executionDeadlineMs - BigInt(Date.now());
        const resolved: ExecutionInteractiveResolution | null =
            this.journal.pending === null &&
            !stop.aborted &&
            permit !== null &&
            captureBudget > 0n &&
            BigInt(Date.now()) < permit.expiresAtMs
                ? this.policy.interactive(value.request)
                : null;
        const context: ConnectorEffectContext =
            this.journal.pending?.effectContext ??
            (stop.aborted ||
            permit === null ||
            captureBudget <= 0n ||
            BigInt(Date.now()) >= permit.expiresAtMs
                ? { kind: ConnectorEffectKind.ExecutionNotStarted }
                : await this.policy.effectContext(value.request.rootId));
        const captured: ConnectorEffectContext =
            resolved === null || context.kind !== ConnectorEffectKind.CapturedExecution
                ? context
                : {
                      ...context,
                      kind: ConnectorEffectKind.CapturedInteractiveExecution,
                      incarnation: randomBytes(32).toString('hex'),
                  };
        if (
            freshJoint &&
            permit !== null &&
            !stop.aborted &&
            BigInt(Date.now()) < permit.expiresAtMs &&
            BigInt(Date.now()) < permit.executionDeadlineMs
        ) {
            await this.authorize(permit);
        }
        const claim: ConnectorJournalClaim<ExecutionRequest, ExecutionResult, ExecutionOutput> =
            await this.journal.begin(value, captured);
        const id: string = ExecutionProof.cgroupId(this.journal.id, value);
        if (!claim.fresh) {
            if (
                claim.pending.response !== null &&
                captured.kind !== ConnectorEffectKind.CapturedInteractiveExecution
            ) {
                return claim.pending.response;
            }
            try {
                if (captured.kind === ConnectorEffectKind.CapturedInteractiveExecution) {
                    try {
                        await this.interactive.recover(value, session, captured);
                    } finally {
                        await ExecutionCgroup.recover(captured, id);
                    }
                } else if (captured.kind === ConnectorEffectKind.CapturedExecution) {
                    if (claim.pending.response === null) {
                        await ExecutionCgroup.recover(captured, id);
                    }
                } else if (context.kind !== ConnectorEffectKind.ExecutionNotStarted) {
                    throw new Error('Original physical command authority is unproven');
                }
            } catch {
                this.#failed = true;
                throw new Error('Original execution cleanup was not proven');
            }
            return (
                claim.pending.response ??
                (await this.journal.finish(value, {
                    ...ExecutionResultCodec.interrupted(ExecutionFailure.Interrupted),
                    ...claim.pending.progress,
                }))
            );
        }
        let response: ExecutionResult;
        const remaining: bigint =
            permit === null ? 0n : permit.executionDeadlineMs - BigInt(Date.now());
        if (stop.aborted || permit === null) {
            response = ExecutionResultCodec.interrupted(ExecutionFailure.Cancelled);
        } else if (BigInt(Date.now()) >= permit.expiresAtMs || remaining <= 0n) {
            response = ExecutionResultCodec.interrupted(ExecutionFailure.Expired);
        } else {
            if (
                captured.kind !== ConnectorEffectKind.CapturedExecution &&
                captured.kind !== ConnectorEffectKind.CapturedInteractiveExecution
            ) {
                throw new Error('Fresh command requires original physical capture');
            }
            let activity: ConnectorActivityHandle | null = null;
            let succeeded: boolean = false;
            try {
                const deadline: AbortSignal = AbortSignal.timeout(Number(remaining));
                const signal: AbortSignal = AbortSignal.any([stop, deadline]);
                const launchAdmission: ExecutionLaunchAdmission = new ExecutionLaunchAdmission(
                    permit,
                    session,
                    this.journal,
                    signal,
                );
                launchAdmission.assert();
                let binding: ExecutionInteractiveNativeBinding | null = null;
                if (captured.kind === ConnectorEffectKind.CapturedInteractiveExecution) {
                    if (resolved === null) {
                        throw new Error('Fresh interactive resolution unavailable');
                    }
                    binding = await this.interactive.prepare(
                        permit,
                        session,
                        resolved,
                        captured,
                        (): void => controller.abort(),
                    );
                }
                launchAdmission.assert();
                activity = this.activity?.begin(ConnectorActivityLane.command(permit)) ?? null;
                response = await this.policy.execute(
                    {
                        policySha256: value.request.policySha256,
                        programId: value.request.programId,
                        rootId: value.request.rootId,
                        arguments: value.request.arguments,
                    },
                    id,
                    signal,
                    {
                        context: captured,
                        expiresAtMs: launchAdmission.expiresAtMs,
                        assertLaunch: (): void => launchAdmission.assert(),
                        commit: async (group: ExecutionCgroupIdentity): Promise<void> => {
                            launchAdmission.assert();
                            await this.journal.bindExecutionGroup(value, group);
                            launchAdmission.assert();
                        },
                    },
                    {
                        retain: async (output: ExecutionOutput): Promise<void> => {
                            await this.journal.retain(value, output);
                            this.committed();
                        },
                    },
                    binding,
                );
                if (
                    response.failure === ExecutionFailure.Cancelled &&
                    deadline.aborted &&
                    signal.reason === deadline.reason
                ) {
                    response = { ...response, failure: ExecutionFailure.Timeout };
                }
                succeeded =
                    response.setupFailure === null &&
                    response.failure === null &&
                    response.termination === ExecutionTermination.Exited &&
                    response.exitCode === 0;
            } catch (caught: unknown) {
                if (
                    this.journal.failed ||
                    this.interactive.failed ||
                    caught instanceof ExecutionOutputRetentionError
                ) {
                    this.#failed = true;
                    throw caught;
                }
                if (this.policy.failed) {
                    this.#failed = true;
                    throw new Error('Execution kernel cleanup was not proven', { cause: caught });
                }
                response = ExecutionResultCodec.interrupted(ExecutionFailure.Sandbox);
            } finally {
                activity?.finish(succeeded, null);
                if (captured.kind === ConnectorEffectKind.CapturedInteractiveExecution) {
                    await this.interactive.completed();
                }
            }
        }
        return await this.journal.finish(value, response);
    }
}
