// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

import { ConnectorClock } from '../protocol/ConnectorClock.js';
import { executionPublicProfile } from './ExecutionPublicProfile.js';
import type { ConnectorJointAdmission } from '../runtime/ConnectorJointAdmission.js';
import { ConnectorOperationAuthorization } from '../runtime/ConnectorOperationAuthorization.js';
import { ConnectorAuthorizationKind } from 'nerva-connector-protocol/protocol/ConnectorAuthorization.js';
import { ConnectorAuthorizationCodec } from 'nerva-connector-protocol/protocol/ConnectorAuthorizationCodec.js';
import { ConnectorAuthorizationProof } from 'nerva-connector-protocol/protocol/ConnectorAuthorizationProof.js';
import type { ConnectorClientIdentity } from '../runtime/ConnectorClientConfiguration.js';
import { JointWorkspaceConfiguration } from '../workspace/JointWorkspaceConfiguration.js';
import { ConnectorClientSession } from '../runtime/ConnectorClientSession.js';
import type { ConnectorDeviceLease } from 'nerva-connector-protocol/protocol/ConnectorDevice.js';
import { ConnectorOperationJournal } from '../runtime/ConnectorOperationJournal.js';
import { SignaturePurpose } from 'nerva-connector-protocol/identity/IdentityFormat.js';
import { SigningKey } from '../identity/SigningKey.js';
import { ExecutionConfiguration } from './ExecutionConfiguration.js';
import type { ExecutionClientSettings } from './ExecutionClientSettings.js';
import { ExecutionInteractiveOwnership } from './ExecutionInteractiveOwnership.js';
import type { ExecutionInteractiveReady } from 'nerva-connector-protocol/execution/ExecutionInteractive.js';
import type { ExecutionInputWorkCapture } from 'nerva-connector-protocol/execution/ExecutionInputWorkCapture.js';
import type { ExecutionInteractiveDeliveryReply } from './ExecutionInteractiveOwnershipTypes.js';
import { ConnectorEffectKind } from '../runtime/ConnectorEffectContext.js';
import { ExecutionPolicy } from './ExecutionPolicy.js';
import { ExecutionOperation } from './ExecutionOperation.js';
import { ExecutionOutputProtocol } from './ExecutionOutputProtocol.js';
import type {
    ExecutionOutputUpdate,
    ExecutionOutputAck,
} from 'nerva-connector-protocol/execution/ExecutionOutput.js';
import type { ConnectorJournalPending } from '../runtime/ConnectorJournalState.js';
import type { ExecutionOutput } from 'nerva-connector-protocol/execution/ExecutionOutput.js';
import { ExecutionJournalCodec } from './ExecutionJournalCodec.js';
import { ExecutionJobsCodec } from './ExecutionJobsCodec.js';
import { ExecutionProof } from 'nerva-connector-protocol/execution/ExecutionProof.js';
import type { ExecutionResult } from 'nerva-connector-protocol/execution/ExecutionTypes.js';
import type {
    ExecutionRequest,
    ExecutionPermit,
    ExecutionCancellation,
    ExecutionCompletion,
    ExecutionPublication,
    ExecutionAcknowledgment,
    ExecutionAcknowledged,
    ExecutionBinding,
    ExecutionProfile,
} from 'nerva-connector-protocol/execution/ExecutionJobs.js';
import type { ConnectorActivitySink } from '../runtime/ConnectorActivity.js';

/** One signed command lane retains exact original effects across session and process replacement. */
export class ExecutionClient implements AsyncDisposable {
    readonly #policy: ExecutionPolicy;
    readonly #journal: ConnectorOperationJournal<
        ExecutionRequest,
        ExecutionResult,
        ExecutionOutput
    >;
    readonly #operation: ExecutionOperation;
    readonly #profile: ExecutionProfile;
    readonly #interactive: ExecutionInteractiveOwnership;
    #closed: boolean = false;
    #jointAdmission: ConnectorJointAdmission | null = null;
    #active: number = 0;
    #observer: (() => void) | null = null;
    #interactiveObserver: (() => void) | null = null;

    private constructor(
        public readonly identity: ConnectorClientIdentity,
        public readonly settings: ExecutionClientSettings,
        policy: ExecutionPolicy,
        journal: ConnectorOperationJournal<ExecutionRequest, ExecutionResult, ExecutionOutput>,
        interactive: ExecutionInteractiveOwnership,
        activity: ConnectorActivitySink | null,
    ) {
        this.#policy = policy;
        this.#profile = executionPublicProfile(policy);
        this.#journal = journal;
        this.#interactive = interactive;
        this.#operation = new ExecutionOperation(
            policy,
            journal,
            async (permit: ExecutionPermit): Promise<void> => {
                if (permit.authorization.kind === ConnectorAuthorizationKind.Joint) {
                    if (this.#jointAdmission === null) {
                        throw new Error('Fresh joint command admission unavailable');
                    }
                    await this.#jointAdmission.execution(permit);
                }
            },
            interactive,
            (): void => this.#observer?.(),
            activity,
        );
    }

    /**
     * Borrows one already verified/MAC-checked installation policy; the caller must outlive all lane work and journal disposal.
     *
     * @param activity - Receives each launched command and verified stop for the local activity screen; it never changes one
     */
    public static async load(
        identity: ConnectorClientIdentity,
        settings: ExecutionClientSettings,
        policy: ExecutionPolicy,
        activity: ConnectorActivitySink | null = null,
    ): Promise<ExecutionClient> {
        const installation: typeof identity.settings.execution = identity.settings.execution;
        if (
            installation === null ||
            identity.settings.slot !== 0 ||
            installation.policyFile !== settings.policyFile ||
            installation.stateDirectory !== settings.stateDirectory
        ) {
            throw new Error('Execution lane belongs to another local installation');
        }
        const workspace: ReturnType<typeof JointWorkspaceConfiguration.paths> =
            JointWorkspaceConfiguration.paths(identity.settings.privateKeyFile);
        policy.assertSource(settings.policyFile, [
            workspace.configurationFile,
            workspace.stateDirectory,
            workspace.setupFile,
            identity.configurationFile,
            identity.settings.privateKeyFile,
            identity.settings.authorityPublicKeyFile,
            settings.stateDirectory,
            ...(identity.settings.files === null
                ? []
                : [identity.settings.files.policyFile, identity.settings.files.stateDirectory]),
            ...(identity.settings.serverCaFile === null ? [] : [identity.settings.serverCaFile]),
        ]);
        const journal: ConnectorOperationJournal<
            ExecutionRequest,
            ExecutionResult,
            ExecutionOutput
        > = await ConnectorOperationJournal.load(
            ExecutionConfiguration.journalDirectory(settings),
            identity.settings.enrollmentId,
            identity.key,
            new ExecutionJournalCodec(settings.lane),
        );
        let interactive: ExecutionInteractiveOwnership | null = null;
        try {
            let client: ExecutionClient | null = null;
            interactive = await ExecutionInteractiveOwnership.open(
                identity,
                settings,
                journal,
                (): void => {
                    if (client !== null) {
                        client.#interactiveObserver?.();
                    }
                },
            );
            await interactive.restoreCompleted();
            client = new ExecutionClient(
                identity,
                Object.freeze({ ...settings }),
                policy,
                journal,
                interactive,
                activity,
            );
            return client;
        } catch (caught: unknown) {
            await interactive?.[Symbol.asyncDispose]();
            await journal[Symbol.asyncDispose]();
            throw caught;
        }
    }

    /** Durability or cleanup failure is terminal for this owner rather than permission to retry an uncertain effect. */
    public get failed(): boolean {
        return this.#operation.failed;
    }

    /** Active capture or a retained original forbids policy rebinding, including a terminal result awaiting acknowledgment. */
    public get quiescent(): boolean {
        this.#requireAvailable();
        return this.#active === 0 && this.#journal.pending === null;
    }

    /** The enclosing installation shares exactly one current metadata verifier across both fixed lanes. */
    public bindJointAdmission(owner: ConnectorJointAdmission): void {
        this.#requireAvailable();
        if (this.#jointAdmission !== null) {
            throw new Error('Joint command admission owner already bound');
        }
        this.#jointAdmission = owner;
    }

    /** Public grants are detached from private policy data and remain immutable for this loaded owner. */
    public get profile(): ExecutionProfile {
        this.#requireAvailable();
        return this.#profile;
    }

    /** The original encrypted lane identity is available before any socket or lease, never synthesized on access. */
    public get journalId(): string {
        this.#requireAvailable();
        return this.#journal.id;
    }

    /** Only variable argument rules and public aliases leave the host; fixed local arguments and executable paths remain private. */
    public publication(session: ConnectorClientSession): ExecutionPublication {
        const lease: ConnectorDeviceLease = this.#lease(session);
        this.#binding({ ...lease, lane: this.settings.lane }, lease);
        const value: Omit<ExecutionPublication, 'signature'> = {
            lane: this.settings.lane,
            environmentId: this.identity.settings.environmentId,
            enrollmentId: this.identity.settings.enrollmentId,
            leaseId: lease.leaseId,
            profile: this.profile,
            journalId: this.journalId,
        };
        return {
            ...value,
            signature: this.identity.key.sign(
                SignaturePurpose.ExecutionProfile,
                ExecutionProof.publication(value),
            ),
        };
    }

    /** Both server signatures and the exact current local target are checked before durable admission or any command effect. */
    public async execute(
        input: ExecutionPermit,
        session: ConnectorClientSession,
    ): Promise<ExecutionCompletion> {
        const lease: ConnectorDeviceLease = this.#lease(session);
        const permit: ExecutionPermit = ExecutionJobsCodec.permit(
            JSON.parse(ExecutionJobsCodec.encode(input)),
        );
        this.#binding(permit, lease);
        const now: bigint = BigInt(Date.now());
        if (
            permit.authorityId !== this.identity.authority.authorityId ||
            permit.issuedAtMs < lease.issuedAtMs ||
            !ConnectorClock.issued(permit.issuedAtMs, now) ||
            permit.expiresAtMs <= now ||
            permit.expiresAtMs > lease.expiresAtMs ||
            (this.#journal.pending === null &&
                permit.request.policySha256 !== this.#policy.policySha256) ||
            ExecutionProof.requestHash(permit.request) !== permit.requestHash ||
            ConnectorAuthorizationProof.execution(
                permit.requestHash,
                this.settings.lane,
                permit.authorization,
            ) !== permit.admissionHash ||
            !SigningKey.verify(
                SignaturePurpose.OperationExecutionPermit,
                this.identity.authority.publicKey,
                ExecutionProof.permit(permit),
                permit.signature,
            )
        ) {
            throw new Error('Signed execution permit denied');
        }
        ConnectorOperationAuthorization.execution(this.identity, this.#journal.id, permit);
        this.#active += 1;
        try {
            return this.#completion(permit, await this.#operation.execute(permit, session));
        } finally {
            this.#active -= 1;
        }
    }

    /** A stop is independently authenticated, short-lived and original-bound; EOF never grants this authority. */
    public async cancel(
        input: ExecutionCancellation,
        session: ConnectorClientSession,
    ): Promise<ExecutionCompletion> {
        const lease: ConnectorDeviceLease = this.#lease(session);
        const cancellation: ExecutionCancellation = ExecutionJobsCodec.cancellation(
            JSON.parse(ExecutionJobsCodec.encode(input)),
        );
        this.#binding(cancellation, lease);
        const now: bigint = BigInt(Date.now());
        if (
            cancellation.authorityId !== this.identity.authority.authorityId ||
            cancellation.issuedAtMs < lease.issuedAtMs ||
            !ConnectorClock.issued(cancellation.issuedAtMs, now) ||
            cancellation.expiresAtMs <= now ||
            cancellation.expiresAtMs > lease.expiresAtMs ||
            (this.#journal.pending === null &&
                cancellation.authorization.kind === ConnectorAuthorizationKind.Independent &&
                cancellation.request.policySha256 !== this.#policy.policySha256) ||
            ExecutionProof.requestHash(cancellation.request) !== cancellation.requestHash ||
            ConnectorAuthorizationProof.execution(
                cancellation.requestHash,
                this.settings.lane,
                cancellation.authorization,
            ) !== cancellation.admissionHash ||
            !SigningKey.verify(
                SignaturePurpose.OperationExecutionCancellation,
                this.identity.authority.publicKey,
                ExecutionProof.cancellation(cancellation),
                cancellation.signature,
            )
        ) {
            throw new Error('Signed execution cancellation denied');
        }
        ConnectorOperationAuthorization.execution(this.identity, this.#journal.id, cancellation);
        this.#active += 1;
        try {
            return this.#completion(
                cancellation,
                await this.#operation.cancel(cancellation, session),
            );
        } finally {
            this.#active -= 1;
        }
    }

    /** The exclusive delivery owner observes committed local output without making network loss a durability failure. */
    public observeOutput(observer: (() => void) | null): void {
        this.#observer = observer;
    }

    /** The exclusive delivery owner observes durable Ready/outbox changes without owning native lifecycle. */
    public observeInteractive(observer: (() => void) | null): void {
        this.#interactiveObserver = observer;
    }

    /** A current observer can publish only the first durable proof of this lane's retained main original. */
    public interactiveReady(session: ConnectorClientSession): ExecutionInteractiveReady | null {
        this.#lease(session);
        return this.#interactive.ready(session);
    }

    /** Signed input is independently bounded while ordinary execution awaits native completion. */
    public async input(
        work: ExecutionInputWorkCapture,
        session: ConnectorClientSession,
    ): Promise<ExecutionInteractiveDeliveryReply> {
        this.#lease(session);
        this.#active++;
        try {
            return await this.#interactive.input(work, session);
        } finally {
            this.#active--;
        }
    }
    /** Only retained bytes for the matching original can leave under the current mutually confirmed lease. */
    public output(
        original: ExecutionPermit | ExecutionCancellation,
        session: ConnectorClientSession,
        previousHash: string | null,
    ): ExecutionOutputUpdate | null {
        const lease: ConnectorDeviceLease = this.#lease(session);
        this.#binding(original, lease);
        const pending: ConnectorJournalPending<
            ExecutionRequest,
            ExecutionResult,
            ExecutionOutput
        > | null = this.#journal.pending;
        if (pending === null) {
            return null;
        }
        if (
            pending.jobId !== original.jobId ||
            pending.sequence !== original.sequence ||
            pending.dispatchId !== original.dispatchId ||
            pending.requestHash !== original.requestHash ||
            pending.admissionHash !== original.admissionHash ||
            ConnectorAuthorizationCodec.encode(pending.authorization) !==
                ConnectorAuthorizationCodec.encode(original.authorization)
        ) {
            throw new Error('Execution output original changed');
        }
        const output: ExecutionOutput | null = pending.response ?? pending.progress;
        if (output === null || (output.stdoutBase64 === '' && output.stderrBase64 === '')) {
            return null;
        }
        const outputHash: string = ExecutionProof.outputHash(output);
        if (outputHash === previousHash) {
            return null;
        }
        const value: Omit<ExecutionOutputUpdate, 'signature'> = {
            lane: original.lane,
            environmentId: original.environmentId,
            enrollmentId: original.enrollmentId,
            leaseId: lease.leaseId,
            jobId: pending.jobId,
            sequence: pending.sequence,
            dispatchId: pending.dispatchId,
            requestHash: pending.requestHash,
            admissionHash: pending.admissionHash,
            outputHash,
            output: { stdoutBase64: output.stdoutBase64, stderrBase64: output.stderrBase64 },
        };
        return {
            ...value,
            signature: this.identity.key.sign(
                SignaturePurpose.OperationExecutionOutput,
                ExecutionProof.output(value),
            ),
        };
    }
    /** Prefix acknowledgments grant only bounded flow-control credit, never command completion or local compaction. */
    public verifyOutputAck(
        raw: ExecutionOutputAck,
        update: ExecutionOutputUpdate,
        session: ConnectorClientSession,
    ): void {
        const ack: ExecutionOutputAck = ExecutionOutputProtocol.ack(
            JSON.parse(ExecutionOutputProtocol.encode(raw)),
        );
        this.#binding(ack, this.#lease(session));
        if (
            ack.authorityId !== this.identity.authority.authorityId ||
            !ExecutionProof.output(ack).equals(ExecutionProof.output(update)) ||
            !SigningKey.verify(
                SignaturePurpose.OperationExecutionOutputAck,
                this.identity.authority.publicKey,
                ExecutionProof.outputAck(ack),
                ack.signature,
            )
        ) {
            throw new Error('Execution output acknowledgment denied');
        }
    }

    #completion(
        permit: ExecutionPermit | ExecutionCancellation | ExecutionAcknowledgment,
        response: ExecutionResult,
    ): ExecutionCompletion {
        const value: Omit<ExecutionCompletion, 'signature'> = {
            lane: permit.lane,
            environmentId: permit.environmentId,
            enrollmentId: permit.enrollmentId,
            leaseId: permit.leaseId,
            jobId: permit.jobId,
            sequence: permit.sequence,
            dispatchId: permit.dispatchId,
            requestHash: permit.requestHash,
            admissionHash: permit.admissionHash,
            responseHash: ExecutionProof.responseHash(response),
            response,
        };
        return {
            ...value,
            signature: this.identity.key.sign(
                SignaturePurpose.OperationExecutionResult,
                ExecutionProof.completion(value),
            ),
        };
    }

    /** Only a valid backend proof of this exact retained response can authorize durable compaction and a device receipt. */
    public async acknowledge(
        input: ExecutionAcknowledgment,
        session: ConnectorClientSession,
    ): Promise<ExecutionAcknowledged> {
        const lease: ConnectorDeviceLease = this.#lease(session);
        const acknowledgment: ExecutionAcknowledgment = ExecutionJobsCodec.acknowledgment(
            JSON.parse(ExecutionJobsCodec.encode(input)),
        );
        this.#binding(acknowledgment, lease);
        if (
            acknowledgment.authorityId !== this.identity.authority.authorityId ||
            !SigningKey.verify(
                SignaturePurpose.OperationExecutionAcknowledgment,
                this.identity.authority.publicKey,
                ExecutionProof.acknowledgment(acknowledgment),
                acknowledgment.signature,
            )
        ) {
            throw new Error('Signed execution acknowledgment denied');
        }
        await this.#operation.idle();
        const pending: ConnectorJournalPending<
            ExecutionRequest,
            ExecutionResult,
            ExecutionOutput
        > | null = this.#journal.pending;
        if (pending?.effectContext.kind === ConnectorEffectKind.CapturedInteractiveExecution) {
            if (pending.response === null) {
                throw new Error('Interactive terminal response is not durable');
            }
            if (
                pending.jobId !== acknowledgment.jobId ||
                pending.sequence !== acknowledgment.sequence ||
                pending.dispatchId !== acknowledgment.dispatchId ||
                pending.requestHash !== acknowledgment.requestHash ||
                pending.admissionHash !== acknowledgment.admissionHash ||
                ExecutionProof.responseHash(pending.response) !== acknowledgment.responseHash
            ) {
                throw new Error(
                    'Interactive terminal acknowledgment changed its exact retained main outcome',
                );
            }
            await this.#interactive.retire(
                this.#completion(acknowledgment, pending.response),
                acknowledgment,
                session,
            );
        }
        await this.#journal.acknowledge(acknowledgment);
        const value: Omit<ExecutionAcknowledged, 'signature'> = {
            lane: acknowledgment.lane,
            environmentId: acknowledgment.environmentId,
            enrollmentId: acknowledgment.enrollmentId,
            leaseId: acknowledgment.leaseId,
            jobId: acknowledgment.jobId,
            sequence: acknowledgment.sequence,
            dispatchId: acknowledgment.dispatchId,
            requestHash: acknowledgment.requestHash,
            admissionHash: acknowledgment.admissionHash,
            responseHash: acknowledgment.responseHash,
        };
        return {
            ...value,
            signature: this.identity.key.sign(
                SignaturePurpose.OperationExecutionAcknowledged,
                ExecutionProof.acknowledged(value),
            ),
        };
    }

    /** Socket replacement retains this owner; actual owner shutdown stops and joins effects before releasing journal and identity ownership. */
    public async [Symbol.asyncDispose](): Promise<void> {
        this.#closed = true;
        try {
            await this.#operation[Symbol.asyncDispose]();
        } finally {
            try {
                await this.#interactive[Symbol.asyncDispose]();
            } finally {
                await this.#journal[Symbol.asyncDispose]();
            }
        }
    }

    #requireAvailable(): void {
        if (this.#closed || this.failed) {
            throw new Error('Execution workspace owner unavailable');
        }
    }

    #lease(session: ConnectorClientSession): ConnectorDeviceLease {
        if (session.identity !== this.identity) {
            throw new Error('Execution session belongs to another local owner');
        }
        return ConnectorClientSession.current(session, BigInt(Date.now()));
    }
    #binding(value: ExecutionBinding, lease: ConnectorDeviceLease): void {
        const now: bigint = BigInt(Date.now());
        if (
            this.#closed ||
            this.failed ||
            value.lane !== this.settings.lane ||
            value.environmentId !== this.identity.settings.environmentId ||
            value.enrollmentId !== this.identity.settings.enrollmentId ||
            value.leaseId !== lease.leaseId ||
            lease.authorityId !== this.identity.authority.authorityId ||
            lease.environmentId !== this.identity.settings.environmentId ||
            lease.enrollmentId !== this.identity.settings.enrollmentId ||
            lease.publicKey !== this.identity.key.publicKey ||
            lease.slot !== 0 ||
            !ConnectorClock.issued(lease.issuedAtMs, now) ||
            lease.expiresAtMs <= now
        ) {
            throw new Error('Execution environment or current lease changed');
        }
    }
}
