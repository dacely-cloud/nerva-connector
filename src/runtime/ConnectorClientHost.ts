// SPDX-FileCopyrightText: 2026 Dacely <business@dacely.com>
// SPDX-License-Identifier: LicenseRef-Proprietary

import { ConnectorClock } from '../protocol/ConnectorClock.js';
import { SignaturePurpose } from 'nerva-connector-protocol/identity/IdentityFormat.js';
import { ConnectorHostCodec } from 'nerva-connector-protocol/protocol/ConnectorHostCodec.js';
import {
    ConnectorHostLimits,
    ConnectorHostTool,
    ConnectorHostOutcome,
    ConnectorHostErrorCode,
    type ConnectorHostPublication,
    type ConnectorHostPermit,
    type ConnectorHostResponse,
    type ConnectorHostCompletion,
    type ConnectorHostAcknowledgment,
    type ConnectorHostAcknowledged,
} from 'nerva-connector-protocol/protocol/ConnectorHost.js';
import { HostWorkspace } from '../host/HostWorkspace.js';
import { HostTerminal } from '../host/HostTerminal.js';
import { HostMcpProtocol, type HostJsonObject } from '../host/HostMcpProtocol.js';
import { HostMcpWorkspaceTools } from '../host/HostMcpWorkspaceTools.js';
import { HostWindowsBuild } from '../host/HostWindowsBuild.js';
import type { ConnectorClientIdentity } from './ConnectorClientConfiguration.js';
import {
    ConnectorPrivateDirectory,
    ConnectorDirectoryPurpose,
} from './ConnectorPrivateDirectory.js';
import { ConnectorHostGrant } from './ConnectorHostGrant.js';
import { type ConnectorHostLocalGrant } from './ConnectorHostGrantTypes.js';
import { ConnectorHostJournal } from './ConnectorHostJournal.js';
import { ConnectorHostProof } from './ConnectorHostProof.js';
import { ConnectorHostFailure } from './ConnectorHostFailure.js';
import { ConnectorHostObservationAccess } from './ConnectorHostObservationAccess.js';
import { HostOperationError } from '../host/HostOperationError.js';
import { ConnectorHostObservedStart } from 'nerva-connector-protocol/protocol/ConnectorHostObservationProtocol.js';
import { ConnectorHostObservedStartCodec as ObservedStart } from 'nerva-connector-protocol/protocol/ConnectorHostObservedStartCodec.js';
import {
    type ConnectorHostObservationConnection,
    type ConnectorHostObservationOwned,
    type ConnectorHostObservationPrepared,
} from './ConnectorHostObservationOwners.js';
import type { ConnectorHostObservationCapability } from 'nerva-connector-protocol/protocol/ConnectorHostObservationCapability.js';
import type { ConnectorActivityHandle, ConnectorActivitySink } from './ConnectorActivity.js';
import { ConnectorConnectionLog } from './ConnectorConnectionLog.js';
import { HostDesktopError } from '../host/HostDesktopError.js';
import { ConnectorActivityArguments } from './ConnectorActivityArguments.js';

/** One verified delivery of an original host permit, bound to the lease it arrived on. */
export interface ConnectorHostDelivery {
    /** The canonical permit as delivered. */
    readonly permit: ConnectorHostPermit;
    /** The lease the delivery arrived on; its completion is signed for this lease. */
    readonly leaseId: string;
    /** The original's single response, shared by every delivery of that original. */
    readonly response: Promise<ConnectorHostResponse>;
}

/** Paired host effects are independently consented, backend-authorized and retained before any operation executes. */
export class ConnectorClientHost implements AsyncDisposable {
    readonly #stop: AbortController = new AbortController();
    readonly #observations: ConnectorHostObservationAccess | null;
    readonly #activity: ConnectorActivitySink | null;
    #workspace: HostWorkspace | null = null;
    #tools: HostMcpWorkspaceTools | null = null;
    #permit: ConnectorHostPermit | null = null;
    #task: Promise<ConnectorHostResponse> | null = null;
    #closed: boolean = false;
    #failed: boolean = false;
    #linkClose: (() => void) | null = null;
    #inspection: Promise<void> | null = null;
    #disposal: Promise<void> | null = null;
    readonly #timer: NodeJS.Timeout;
    private constructor(
        public readonly identity: ConnectorClientIdentity,
        public readonly grant: ConnectorHostLocalGrant,
        public readonly journal: ConnectorHostJournal,
        observationProtocol: typeof ConnectorHostObservedStart.Protocol | null,
        activity: ConnectorActivitySink | null,
        public readonly log: ConnectorConnectionLog | null,
    ) {
        this.#activity = activity;
        this.#observations =
            observationProtocol === ConnectorHostObservedStart.Protocol
                ? new ConnectorHostObservationAccess(identity, grant, {
                      runtime: (): string | null => this.#workspace?.observationRuntimeId ?? null,
                      active: (): void => this.#active(),
                      publication: (leaseId: string): ConnectorHostPublication =>
                          this.observationPublication(leaseId),
                  })
                : null;
        this.#timer = setInterval((): void => {
            if (this.#inspection === null) {
                const task: Promise<void> = this.#inspect();
                this.#inspection = task;
                void this.#observeInspection(task);
            }
        }, 1000);
        this.#timer.unref();
    }

    /**
     * Missing explicit consent leaves the paired device metadata-only; saved preferences never supply this grant.
     *
     * @param activity - Receives every fresh request that reaches this computer, including refused and failed ones, for the local activity screen; it never changes one
     */
    public static async load(
        identity: ConnectorClientIdentity,
        observationProtocol: typeof ConnectorHostObservedStart.Protocol | null = null,
        activity: ConnectorActivitySink | null = null,
        log: ConnectorConnectionLog | null = null,
    ): Promise<ConnectorClientHost | null> {
        if (
            observationProtocol !== null &&
            observationProtocol !== ConnectorHostObservedStart.Protocol
        ) {
            throw new Error('Unsupported host observation activation');
        }
        const grant: ConnectorHostLocalGrant | null = await ConnectorHostGrant.read(identity);
        if (grant === null) {
            return null;
        }
        if (!grant.journalInitialized) {
            throw new Error('Host setup is incomplete; repeat the explicit local approval');
        }
        if (identity.settings.slot !== 0) {
            throw new Error('Host grants require primary connector slot zero');
        }
        const owner: ConnectorPrivateDirectory = await ConnectorPrivateDirectory.open(
            ConnectorHostGrant.directory(identity),
            ConnectorDirectoryPurpose.Installation,
        );
        let journal: ConnectorHostJournal | null = null;
        let host: ConnectorClientHost | null = null;
        try {
            journal = await ConnectorHostJournal.load(owner, identity, grant);
            host = new ConnectorClientHost(
                identity,
                grant,
                journal,
                observationProtocol,
                activity,
                log,
            );
            if (grant.profile.enabled) {
                const windowsLauncher: string | undefined =
                    process.platform === 'win32'
                        ? await HostWindowsBuild.verifiedExecutable()
                        : undefined;
                const terminalSupported: boolean = await HostTerminal.available(windowsLauncher);
                host.#workspace = await HostWorkspace.create({
                    directory: grant.profile.directory,
                    authorization: {
                        authorize: (): Promise<void> =>
                            host === null
                                ? Promise.reject(new Error('Host owner unavailable'))
                                : host.#authorize(),
                    },
                    ...(windowsLauncher !== undefined ? { windowsLauncher } : {}),
                    ended: (processId: string): void => activity?.ended(processId),
                });
                host.#tools = new HostMcpWorkspaceTools(
                    host.#workspace,
                    host.#stop.signal,
                    {
                        maximumChunkBytes: ConnectorHostLimits.chunkBytes,
                        defaultChunkBytes: ConnectorHostLimits.chunkBytes,
                        maximumDirectoryEntries: ConnectorHostLimits.directoryEntries,
                        compactEncodedBytes: true,
                    },
                    terminalSupported,
                );
            }
            return host;
        } catch (caught: unknown) {
            if (host !== null) {
                await host[Symbol.asyncDispose]();
            } else if (journal !== null) {
                await journal[Symbol.asyncDispose]();
            } else {
                await owner[Symbol.asyncDispose]();
            }
            throw caught;
        }
    }
    /** Durability or consent failures retire this owner and the connection that published it. */
    public get failed(): boolean {
        return this.#failed || this.journal.failed;
    }
    /** Default construction advertises no observation support; only trusted current-cohort activation enables this local lane. */
    public get observationEnabled(): boolean {
        return this.#observations?.enabled ?? false;
    }

    /** Read metadata uses independently verified current authority and never installs a synthetic effect permit. */
    public async observe(
        raw: unknown,
        connection: ConnectorHostObservationConnection,
    ): Promise<ConnectorHostObservationOwned> {
        return await this.#observationSupport().observe(raw, connection);
    }
    /** Delivery checks current consent after asynchronous native revision waits. */
    public async inspectObservation(
        owned: ConnectorHostObservationOwned,
        connection: ConnectorHostObservationConnection,
    ): Promise<void> {
        await this.#observationSupport().inspect(owned, connection);
    }
    /** A fresh server challenge starts one exact local companion attempt. */
    public observationCapability(
        companionNonce: string,
        connection: ConnectorHostObservationConnection,
    ): ConnectorHostObservationCapability {
        return this.#observationSupport().capability(companionNonce, connection);
    }
    /** The installed private authority must activate the exact current challenge, lease, profile and runtime. */
    public activateObservation(
        raw: unknown,
        companionNonce: string,
        connection: ConnectorHostObservationConnection,
    ): void {
        this.#observationSupport().activate(raw, companionNonce, connection);
    }
    /** Side closure invalidates only that attempt, retaining native owners and exact original effects. */
    public deactivateObservation(companionNonce: string): void {
        this.#observations?.deactivate(companionNonce);
    }
    #observationSupport(): ConnectorHostObservationAccess {
        this.#active();
        if (this.#observations === null) {
            throw new Error('Host observation support is inactive');
        }
        return this.#observations;
    }
    /** A current transport supplies only its close callback, never account or local authority. */
    public bindLink(close: (() => void) | null): void {
        this.#linkClose = close;
    }
    /** Publication advertises the complete signed local consent, including explicit disablement. */
    public publication(leaseId: string): ConnectorHostPublication {
        return this.#publication(leaseId, false);
    }
    /** Only an explicitly negotiated metadata companion may transmit the extended capability publication. */
    public observationPublication(leaseId: string): ConnectorHostPublication {
        if (!this.observationEnabled) {
            throw new Error('Host observation support is inactive');
        }
        return this.#publication(leaseId, true);
    }
    #publication(leaseId: string, observation: boolean): ConnectorHostPublication {
        this.#active();
        const value: Omit<ConnectorHostPublication, 'signature'> = {
            enrollmentId: this.grant.enrollmentId,
            leaseId,
            journalId: this.grant.journalId,
            profile: this.grant.profile,
            ...(observation ? { observationProtocol: ConnectorHostObservedStart.Protocol } : {}),
        };
        return {
            ...value,
            signature: ConnectorHostProof.sign(
                this.identity.key,
                SignaturePurpose.HostProfile,
                ConnectorHostProof.publication(value),
            ),
        };
    }
    /**
     * Only one exact original may be joined; a fresh Started marker precedes the first local effect.
     *
     * @param input - The permit as delivered on `leaseId`
     * @param leaseId - The current connection lease
     * @param expiresAtMs - When that lease expires
     * @returns The completion signed for `leaseId`
     * @throws Error if the permit is not valid for this lease or another original is in progress
     */
    public async execute(
        input: ConnectorHostPermit,
        leaseId: string,
        expiresAtMs: bigint,
    ): Promise<ConnectorHostCompletion> {
        return await this.complete(this.accept(input, leaseId, expiresAtMs));
    }

    /**
     * Verify one delivery of an original host permit and join its operation, starting it when none is in progress.
     *
     * @remarks
     * Verification finishes before this returns, so a renewed lease can attach its re-delivered permit while the
     * operation started for an earlier lease is still running. A matching re-delivery adds no work: it shares the
     * single in-progress response and becomes the permit that later consent checks of that operation read.
     *
     * @param input - The permit as delivered on `leaseId`
     * @param leaseId - The current connection lease
     * @param expiresAtMs - When that lease expires
     * @returns The accepted delivery and the original's shared response
     * @throws Error if the permit is not valid for this lease or another original is in progress
     */
    public accept(
        input: ConnectorHostPermit,
        leaseId: string,
        expiresAtMs: bigint,
    ): ConnectorHostDelivery {
        const permit: ConnectorHostPermit = ConnectorHostCodec.permit(
            JSON.parse(ConnectorHostCodec.encode(input)),
        );
        this.#binding(permit, leaseId);
        const now: bigint = BigInt(Date.now());
        if (
            permit.authorityId !== this.grant.authorityId ||
            !ConnectorClock.issued(permit.issuedAtMs, now) ||
            permit.expiresAtMs <= now ||
            permit.expiresAtMs > expiresAtMs ||
            ConnectorHostProof.digest(ConnectorHostCodec.encode(permit.request)) !==
                permit.requestHash ||
            !ConnectorHostProof.verify(
                this.identity.authority.publicKey,
                SignaturePurpose.HostPermit,
                ConnectorHostProof.permit(permit),
                permit.signature,
            )
        ) {
            throw new Error('Paired host permit denied');
        }
        if (
            this.#task !== null &&
            (this.#permit === null ||
                this.#permit.jobId !== permit.jobId ||
                this.#permit.sequence !== permit.sequence ||
                this.#permit.dispatchId !== permit.dispatchId ||
                this.#permit.requestHash !== permit.requestHash)
        ) {
            throw new Error('Another host original is already in progress');
        }
        this.#permit = permit;
        this.#task ??= this.#run(permit);
        return { permit, leaseId, response: this.#task };
    }

    /**
     * Wait for an accepted delivery's original and sign its result for the lease that delivery arrived on.
     *
     * @param delivery - A delivery this owner accepted
     * @returns The completion signed for the delivery's lease
     * @throws Error if the original operation failed
     */
    public async complete(delivery: ConnectorHostDelivery): Promise<ConnectorHostCompletion> {
        const response: ConnectorHostResponse = await delivery.response;
        const completion: Omit<ConnectorHostCompletion, 'signature'> = {
            enrollmentId: delivery.permit.enrollmentId,
            leaseId: delivery.leaseId,
            journalId: delivery.permit.journalId,
            jobId: delivery.permit.jobId,
            sequence: delivery.permit.sequence,
            dispatchId: delivery.permit.dispatchId,
            requestHash: delivery.permit.requestHash,
            responseHash: ConnectorHostProof.responseHash(response),
            response,
        };
        return {
            ...completion,
            signature: ConnectorHostProof.sign(
                this.identity.key,
                SignaturePurpose.HostResult,
                ConnectorHostProof.completion(completion),
            ),
        };
    }
    /** Signed cloud completion is committed locally before device compaction confirmation is sent. */
    public async acknowledge(
        input: ConnectorHostAcknowledgment,
        leaseId: string,
    ): Promise<ConnectorHostAcknowledged> {
        const acknowledgment: ConnectorHostAcknowledgment = ConnectorHostCodec.acknowledgment(
            JSON.parse(ConnectorHostCodec.encode(input)),
        );
        this.#binding(acknowledgment, leaseId);
        if (
            acknowledgment.authorityId !== this.grant.authorityId ||
            !ConnectorHostProof.verify(
                this.identity.authority.publicKey,
                SignaturePurpose.HostAcknowledgment,
                ConnectorHostProof.acknowledgment(acknowledgment),
                acknowledgment.signature,
            )
        ) {
            throw new Error('Host acknowledgment denied');
        }
        await this.#task;
        await this.journal.acknowledge(acknowledgment);
        const { authorityId: _authorityId, signature: _signature, ...receipt } = acknowledgment;
        return {
            ...receipt,
            signature: ConnectorHostProof.sign(
                this.identity.key,
                SignaturePurpose.HostAcknowledged,
                ConnectorHostProof.acknowledged(receipt),
            ),
        };
    }
    /** Revoke future operations, join current effects and stop owned processes before releasing history. */
    public async [Symbol.asyncDispose](): Promise<void> {
        const disposal: Promise<void> = this.#disposal ?? this.#dispose();
        this.#disposal = disposal;
        try {
            await disposal;
        } catch (caught: unknown) {
            if (this.#disposal === disposal) {
                this.#disposal = null;
            }
            throw caught;
        }
    }
    async #dispose(): Promise<void> {
        this.#closed = true;
        clearInterval(this.#timer);
        this.#stop.abort();
        this.#observations?.stop();
        this.#linkClose = null;
        const outcomes: readonly PromiseSettledResult<void>[] = await Promise.allSettled([
            ...(this.#workspace === null ? [] : [this.#workspace[Symbol.asyncDispose]()]),
            ...(this.#task === null ? [] : [this.#join(this.#task)]),
            ...(this.#inspection === null ? [] : [this.#inspection]),
            ...(this.#observations === null ? [] : [this.#observations.join()]),
        ]);
        const failed: readonly PromiseRejectedResult[] = outcomes.filter(
            (result: PromiseSettledResult<void>): result is PromiseRejectedResult =>
                result.status === 'rejected',
        );
        this.#observations?.[Symbol.dispose]();
        if (failed.length > 0) {
            throw new AggregateError(
                failed.map((result: PromiseRejectedResult): unknown => result.reason),
                'Paired host shutdown failed',
            );
        }
        await this.journal[Symbol.asyncDispose]();
    }
    async #join(task: Promise<ConnectorHostResponse>): Promise<void> {
        await task;
    }
    /** The single in-progress original releases this owner's work slot as soon as it settles. */
    async #run(permit: ConnectorHostPermit): Promise<ConnectorHostResponse> {
        try {
            return await this.#perform(permit);
        } finally {
            this.#task = null;
            this.#permit = null;
        }
    }
    async #perform(permit: ConnectorHostPermit): Promise<ConnectorHostResponse> {
        if (this.journal.snapshot.pending === null && BigInt(Date.now()) > permit.startByMs) {
            return await this.#expired(permit);
        }
        const fresh: boolean = await this.journal.begin(permit);
        const retained: ConnectorHostResponse | null | undefined =
            this.journal.snapshot.pending?.response;
        if (retained != null) {
            return retained;
        }
        if (!fresh) {
            return await this.#interrupted(permit);
        }
        let response: ConnectorHostResponse;
        const activity: ConnectorActivityHandle | null =
            this.#activity?.begin({
                jobId: permit.jobId,
                toolName: permit.request.toolName,
                argumentsJson: permit.request.argumentsJson,
            }) ?? null;
        try {
            await this.#authorize();
        } catch {
            response = {
                outcome: ConnectorHostOutcome.Failed,
                resultJson: null,
                errorCode: ConnectorHostErrorCode.AdmissionDenied,
            };
            activity?.finish(false, null);
            this.log?.record('host-operation-failed', {
                tool: permit.request.toolName,
                jobId: permit.jobId,
                outcome: response.outcome,
                code: response.errorCode,
                reason: 'Local full computer approval is unavailable or changed',
            });
            await this.journal.complete(permit, response);
            return response;
        }
        let observation: ConnectorHostObservationPrepared | null = null;
        try {
            if (this.#tools === null) {
                throw new Error('Host workspace unavailable');
            }
            let argumentsJson: string = permit.request.argumentsJson;
            try {
                if (ObservedStart.read(permit.request) !== null) {
                    if (this.#observations === null) {
                        throw new HostOperationError(
                            ConnectorHostErrorCode.Unsupported,
                            'Host observation support is inactive',
                            true,
                        );
                    }
                    observation = this.#observations.prepare(permit);
                    argumentsJson = observation.argumentsJson;
                }
            } catch (error: unknown) {
                if (error instanceof HostOperationError) {
                    throw error;
                }
                throw new HostOperationError(
                    ConnectorHostErrorCode.InvalidRequest,
                    'Invalid observed host start',
                    true,
                    { cause: error },
                );
            }
            const raw: unknown = JSON.parse(argumentsJson);
            const argumentsValue: HostJsonObject = HostMcpProtocol.request({
                jsonrpc: '2.0',
                id: 'paired-host',
                method: 'tools/call',
                params: raw,
            }).params;
            const resultJson: string = await this.#tools.call(
                permit.request.toolName,
                argumentsValue,
                observation?.binding,
            );
            response = ConnectorHostCodec.response({
                outcome: ConnectorHostOutcome.Succeeded,
                resultJson,
                errorCode: null,
            });
        } catch (caught: unknown) {
            response = ConnectorHostFailure.response(permit.request.toolName, caught);
            this.log?.record('host-operation-failed', {
                tool: permit.request.toolName,
                jobId: permit.jobId,
                outcome: response.outcome,
                code: response.errorCode,
                reason:
                    caught instanceof HostDesktopError || caught instanceof HostOperationError
                        ? caught.message
                        : 'The OS or local authority rejected this operation: ' +
                          (response.errorCode ?? 'operation-failed'),
                ...(caught instanceof HostDesktopError
                    ? {
                          operation: caught.operation,
                          nativeReason: caught.reason,
                          nativeCode: caught.nativeCode,
                      }
                    : {}),
            });
        }
        if (observation !== null && this.#observations !== null) {
            try {
                this.#observations.complete(permit, response);
            } catch {
                response = {
                    outcome: ConnectorHostOutcome.Indeterminate,
                    errorCode: ConnectorHostErrorCode.OperationFailed,
                    resultJson: null,
                };
            }
        }
        activity?.finish(response.outcome === ConnectorHostOutcome.Succeeded, response.resultJson);
        if (
            permit.request.toolName === ConnectorHostTool.ApplicationOpen &&
            response.resultJson !== null
        ) {
            const result: ConnectorActivityArguments = ConnectorActivityArguments.parse(
                response.resultJson,
            );
            this.log?.record('host-application-result', {
                jobId: permit.jobId,
                status: result.text('status'),
                windowObserved: result.flag('windowObserved'),
            });
        }
        await this.journal.complete(permit, response);
        return response;
    }
    /**
     * A started original whose operation is no longer running and left no response is answered as interrupted.
     *
     * @remarks
     * This is the in-process form of what {@link ConnectorHostJournal.load} records after a restart. Throwing here
     * retired the socket, and the server re-delivered the same original on every reconnect, so the connector looped
     * forever with nothing completing it. The original is never started again: its effect stays indeterminate and
     * that outcome is the signed result.
     */
    /**
     * An original that reaches this computer after its start deadline is answered as expired and never started.
     *
     * @remarks
     * A computer that was offline, or refused every permit, kept the original waiting; when it came back it ran every
     * such request, however old, before the one just asked for. The answer is a definite failure, because nothing
     * ran, and it is journaled like any result, so every later delivery returns it unchanged. An original that did
     * start before its deadline keeps its own result or becomes interrupted as before.
     */
    async #expired(permit: ConnectorHostPermit): Promise<ConnectorHostResponse> {
        const response: ConnectorHostResponse = {
            outcome: ConnectorHostOutcome.Failed,
            resultJson: null,
            errorCode: ConnectorHostErrorCode.Expired,
        };
        await this.journal.decline(permit, response);
        return response;
    }
    async #interrupted(permit: ConnectorHostPermit): Promise<ConnectorHostResponse> {
        const response: ConnectorHostResponse = {
            outcome: ConnectorHostOutcome.Indeterminate,
            resultJson: null,
            errorCode: ConnectorHostErrorCode.Interrupted,
        };
        await this.journal.complete(permit, response);
        return response;
    }
    async #authorize(): Promise<void> {
        this.#active();
        const permit: ConnectorHostPermit | null = this.#permit;
        const current: ConnectorHostLocalGrant | null = await ConnectorHostGrant.read(
            this.identity,
        );
        if (
            permit === null ||
            current === null ||
            !current.profile.enabled ||
            ConnectorHostCodec.encode(current) !== ConnectorHostCodec.encode(this.grant) ||
            current.journalId !== this.grant.journalId ||
            current.profile.grantId !== permit.request.grantId ||
            current.profile.grantRevision !== permit.request.grantRevision ||
            !current.profile.tools.includes(permit.request.toolName) ||
            permit.expiresAtMs <= BigInt(Date.now())
        ) {
            throw new Error('Full-computer consent changed or expired before the operation');
        }
    }
    async #inspect(): Promise<void> {
        try {
            const current: ConnectorHostLocalGrant | null = await ConnectorHostGrant.read(
                this.identity,
            );
            if (
                current === null ||
                ConnectorHostCodec.encode(current) !== ConnectorHostCodec.encode(this.grant)
            ) {
                this.#failed = true;
                this.#stop.abort();
                this.#linkClose?.();
                await this.#workspace?.[Symbol.asyncDispose]();
            }
        } catch {
            this.#failed = true;
            this.#stop.abort();
            this.#linkClose?.();
            await this.#workspace?.[Symbol.asyncDispose]();
        }
    }
    async #observeInspection(task: Promise<void>): Promise<void> {
        try {
            await task;
        } catch {
            this.#failed = true;
            this.#stop.abort();
            this.#linkClose?.();
        } finally {
            if (this.#inspection === task) {
                this.#inspection = null;
            }
        }
    }
    #active(): void {
        if (this.#closed || this.failed) {
            throw new Error('Paired host owner is unavailable');
        }
    }
    #binding(value: ConnectorHostPermit | ConnectorHostAcknowledgment, leaseId: string): void {
        this.#active();
        if (
            value.enrollmentId !== this.grant.enrollmentId ||
            value.journalId !== this.grant.journalId ||
            value.leaseId !== leaseId
        ) {
            throw new Error('Host operation changed its device or lease');
        }
    }
}
