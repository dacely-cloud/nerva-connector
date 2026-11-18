// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

import { ConnectorClock } from '../protocol/ConnectorClock.js';
import {
    SignaturePurpose,
    KeyDerivationPurpose,
} from 'nerva-connector-protocol/identity/IdentityFormat.js';
import type { ConnectorJointAdmission } from './ConnectorJointAdmission.js';
import { ConnectorOperationAuthorization } from './ConnectorOperationAuthorization.js';
import { ConnectorAuthorizationKind } from 'nerva-connector-protocol/protocol/ConnectorAuthorization.js';
import { ConnectorAuthorizationCodec } from 'nerva-connector-protocol/protocol/ConnectorAuthorizationCodec.js';
import { ConnectorAuthorizationProof } from 'nerva-connector-protocol/protocol/ConnectorAuthorizationProof.js';
import { ConnectorFileProof } from 'nerva-connector-protocol/protocol/ConnectorFileProof.js';
import {
    ConnectorOperationJournal,
    type ConnectorJournalClaim,
} from './ConnectorOperationJournal.js';
import { ConnectorFileJournalCodec } from './ConnectorFileJournalCodec.js';
import { ConnectorFilesystem } from './ConnectorFilesystem.js';
import { ConnectorFileJobsCodec } from 'nerva-connector-protocol/protocol/ConnectorFileJobsCodec.js';
import { ConnectorFilesCodec } from 'nerva-connector-protocol/protocol/ConnectorFilesCodec.js';
import {
    ConnectorFileFailure,
    type ConnectorFileResponse,
} from 'nerva-connector-protocol/protocol/ConnectorFiles.js';
import { ConnectorFileAction } from 'nerva-connector-protocol/protocol/ConnectorFileTypes.js';
import type {
    ConnectorFileOperation,
    ConnectorFilePermit,
    ConnectorFileCompletion,
    ConnectorFilePublication,
    ConnectorFileAcknowledgment,
    ConnectorFileAcknowledged,
} from 'nerva-connector-protocol/protocol/ConnectorFileJobs.js';
import type { ConnectorClientIdentity } from './ConnectorClientConfiguration.js';
import type { ConnectorLocalCapabilitySettings } from './ConnectorClientSettings.js';
import { ExecutionConfiguration } from '../execution/ExecutionConfiguration.js';
import {
    ConnectorEffectKind,
    type ConnectorEffectContext,
    type ConnectorCapturedFileEffect,
} from './ConnectorEffectContext.js';
import { ConnectorEffectContextCodec } from './ConnectorEffectContextCodec.js';
import { ConnectorHistoryMigration } from './ConnectorHistoryMigration.js';
import type { ConnectorFileWorkspaceSource } from '../workspace/ConnectorWorkspaceSource.js';
import { JointWorkspaceConfiguration } from '../workspace/JointWorkspaceConfiguration.js';
import { ConnectorHostGrant } from './ConnectorHostGrant.js';
import type { ConnectorActivityHandle, ConnectorActivitySink } from './ConnectorActivity.js';
import { ConnectorActivityLane } from './ConnectorActivityLane.js';
import { SigningKey } from '../identity/SigningKey.js';

/** One verified delivery of an original file permit, bound to the lease it arrived on. */
export interface ConnectorFileDelivery {
    /** The canonical permit as delivered. */
    readonly permit: ConnectorFilePermit;
    /** The lease the delivery arrived on; its completion is signed for this lease. */
    readonly leaseId: string;
    /** The original's single response, shared by every delivery of that original. */
    readonly response: Promise<ConnectorFileResponse>;
}

/** Local authority verifies backend pins and retains a single confined file operation across connection replacement. */
export class ConnectorClientFiles implements AsyncDisposable {
    readonly #filesystem: ConnectorFilesystem;
    readonly #journal: ConnectorOperationJournal<ConnectorFileOperation, ConnectorFileResponse>;
    readonly #authorityKey: string;
    readonly #workspaceSource: ConnectorFileWorkspaceSource;
    readonly #activity: ConnectorActivitySink | null;
    #task: Promise<ConnectorFileResponse> | null = null;
    #permit: ConnectorFilePermit | null = null;
    #closed: boolean = false;
    #jointAdmission: ConnectorJointAdmission | null = null;
    private constructor(
        public readonly identity: ConnectorClientIdentity,
        public readonly settings: ConnectorLocalCapabilitySettings,
        filesystem: ConnectorFilesystem,
        journal: ConnectorOperationJournal<ConnectorFileOperation, ConnectorFileResponse>,
        authorityKey: string,
        activity: ConnectorActivitySink | null,
    ) {
        this.#filesystem = filesystem;
        this.#journal = journal;
        this.#authorityKey = authorityKey;
        this.#activity = activity;
        const requireAvailable: () => void = (): void => this.#requireAvailable();
        const quiescent: () => boolean = (): boolean => {
            this.#requireAvailable();
            return this.#task === null && this.#permit === null && this.#journal.pending === null;
        };
        this.#workspaceSource = Object.freeze({
            get quiescent(): boolean {
                return quiescent();
            },
            get filesystem(): ConnectorFilesystem {
                requireAvailable();
                return filesystem;
            },
            get profile(): ConnectorFileWorkspaceSource['profile'] {
                requireAvailable();
                return filesystem.profile;
            },
            get journalId(): string {
                requireAvailable();
                return journal.id;
            },
        });
    }

    /** Explicit initialization verifies local helper/grants before creating a new empty encrypted journal. */
    public static async initialize(identity: ConnectorClientIdentity): Promise<void> {
        const settings: ConnectorLocalCapabilitySettings = this.#settings(identity);
        await using resources: AsyncDisposableStack = new AsyncDisposableStack();
        resources.use(await this.#openFilesystem(identity, settings));
        await ConnectorOperationJournal.initialize(
            settings.stateDirectory,
            identity.settings.enrollmentId,
            identity.key,
            new ConnectorFileJournalCodec(),
        );
    }
    /**
     * A missing or corrupt journal never becomes a fresh device counter on reconnect.
     *
     * @param activity - Receives each dispatched file operation for the local activity screen; it never changes one
     */
    public static async load(
        identity: ConnectorClientIdentity,
        activity: ConnectorActivitySink | null = null,
    ): Promise<ConnectorClientFiles> {
        const settings: ConnectorLocalCapabilitySettings = this.#settings(identity);
        const key: string = identity.authority.publicKey;
        const filesystem: ConnectorFilesystem = await this.#openFilesystem(identity, settings);
        let journal: ConnectorOperationJournal<
            ConnectorFileOperation,
            ConnectorFileResponse
        > | null = null;
        try {
            journal = await ConnectorOperationJournal.load(
                settings.stateDirectory,
                identity.settings.enrollmentId,
                identity.key,
                new ConnectorFileJournalCodec(),
            );
            await ConnectorHistoryMigration.requireComplete(identity);
            return new ConnectorClientFiles(identity, settings, filesystem, journal, key, activity);
        } catch (caught: unknown) {
            await journal?.[Symbol.asyncDispose]();
            await filesystem[Symbol.asyncDispose]();
            throw caught;
        }
    }
    /** A durability failure stops the connector rather than continuing with uncertain local history. */
    public get failed(): boolean {
        return this.#journal.failed;
    }
    /** Stable borrowed getters reject a closed or failed owner, including projections retained before disposal. */
    public get workspaceSource(): ConnectorFileWorkspaceSource {
        this.#requireAvailable();
        return this.#workspaceSource;
    }

    /** Only the installation owner may attach its one shared verifier; missing metadata authority never enables a joint request. */
    public bindJointAdmission(owner: ConnectorJointAdmission): void {
        this.#requireAvailable();
        if (this.#jointAdmission !== null) {
            throw new Error('Joint file admission owner already bound');
        }
        this.#jointAdmission = owner;
    }

    /** A signed local profile contains aliases and commitments, never absolute private paths. */
    public publication(leaseId: string): ConnectorFilePublication {
        this.#requireAvailable();
        const value: Omit<ConnectorFilePublication, 'signature'> = {
            enrollmentId: this.identity.settings.enrollmentId,
            leaseId,
            profile: this.#filesystem.profile,
            journalId: this.#journal.id,
        };
        return {
            ...value,
            signature: ConnectorFileProof.sign(
                this.identity.key,
                SignaturePurpose.FileProfile,
                ConnectorFileProof.publication(value),
            ),
        };
    }

    /**
     * Verify the backend and current connection, then join or start exactly the original file operation.
     *
     * @param input - The permit as delivered on `leaseId`
     * @param leaseId - The current connection lease
     * @param expiresAtMs - When that lease expires
     * @returns The completion signed for `leaseId`
     * @throws Error if the permit is not valid for this lease or another original is in progress
     */
    public async execute(
        input: ConnectorFilePermit,
        leaseId: string,
        expiresAtMs: bigint,
    ): Promise<ConnectorFileCompletion> {
        return await this.complete(this.accept(input, leaseId, expiresAtMs));
    }

    /**
     * Verify one delivery of an original permit and join its operation, starting it when none is in progress.
     *
     * @remarks
     * Verification finishes before this returns, so a renewed lease can attach its re-delivered permit while the
     * operation started for an earlier lease is still running. A matching re-delivery adds no work: it shares the
     * single in-progress response.
     *
     * @param input - The permit as delivered on `leaseId`
     * @param leaseId - The current connection lease
     * @param expiresAtMs - When that lease expires
     * @returns The accepted delivery and the original's shared response
     * @throws Error if the permit is not valid for this lease or another original is in progress
     */
    public accept(
        input: ConnectorFilePermit,
        leaseId: string,
        expiresAtMs: bigint,
    ): ConnectorFileDelivery {
        const permit: ConnectorFilePermit = ConnectorFileJobsCodec.permit(
            JSON.parse(ConnectorFileJobsCodec.encode(input)),
        );
        this.#binding(permit, leaseId);
        const now: bigint = BigInt(Date.now());
        if (
            !ConnectorClock.issued(permit.issuedAtMs, now) ||
            permit.expiresAtMs <= now ||
            permit.expiresAtMs > expiresAtMs ||
            !ConnectorFileProof.verify(
                SigningKey,
                this.#authorityKey,
                SignaturePurpose.OperationFilePermit,
                ConnectorFileProof.permit(permit),
                permit.signature,
            ) ||
            ConnectorFileProof.digest(ConnectorFileJobsCodec.encode(permit.request)) !==
                permit.requestHash ||
            ConnectorAuthorizationProof.file(permit.requestHash, permit.authorization) !==
                permit.admissionHash
        ) {
            throw new Error('Connector file permit denied');
        }
        ConnectorOperationAuthorization.file(this.identity, this.#journal.id, permit);
        let task: Promise<ConnectorFileResponse> | null = this.#task;
        if (task !== null) {
            if (
                this.#permit?.jobId !== permit.jobId ||
                this.#permit.sequence !== permit.sequence ||
                this.#permit.dispatchId !== permit.dispatchId ||
                this.#permit.requestHash !== permit.requestHash ||
                this.#permit.admissionHash !== permit.admissionHash ||
                ConnectorAuthorizationCodec.encode(this.#permit.authorization) !==
                    ConnectorAuthorizationCodec.encode(permit.authorization)
            ) {
                throw new Error('Connector file work already in progress');
            }
        } else {
            this.#permit = permit;
            task = this.#run(permit);
            this.#task = task;
        }
        return { permit, leaseId, response: task };
    }

    /**
     * Wait for an accepted delivery's original and sign its result for the lease that delivery arrived on.
     *
     * @param delivery - A delivery this owner accepted
     * @returns The completion signed for the delivery's lease
     * @throws Error if the original operation failed
     */
    public async complete(delivery: ConnectorFileDelivery): Promise<ConnectorFileCompletion> {
        const response: ConnectorFileResponse = await delivery.response;
        const result: Omit<ConnectorFileCompletion, 'signature'> = {
            enrollmentId: delivery.permit.enrollmentId,
            leaseId: delivery.leaseId,
            jobId: delivery.permit.jobId,
            sequence: delivery.permit.sequence,
            dispatchId: delivery.permit.dispatchId,
            requestHash: delivery.permit.requestHash,
            admissionHash: delivery.permit.admissionHash,
            responseHash: ConnectorFileProof.responseHash(response),
            response,
        };
        return {
            ...result,
            signature: ConnectorFileProof.sign(
                this.identity.key,
                SignaturePurpose.OperationFileResult,
                ConnectorFileProof.completion(result),
            ),
        };
    }

    /** Verified backend acknowledgment precedes local compaction and device confirmation. */
    public async acknowledge(
        input: ConnectorFileAcknowledgment,
        leaseId: string,
    ): Promise<ConnectorFileAcknowledged> {
        const acknowledgment: ConnectorFileAcknowledgment = ConnectorFileJobsCodec.acknowledgment(
            JSON.parse(ConnectorFileJobsCodec.encode(input)),
        );
        this.#binding(acknowledgment, leaseId);
        if (
            !ConnectorFileProof.verify(
                SigningKey,
                this.#authorityKey,
                SignaturePurpose.OperationFileAcknowledgment,
                ConnectorFileProof.acknowledgment(acknowledgment),
                acknowledgment.signature,
            )
        ) {
            throw new Error('Connector file acknowledgment denied');
        }
        if (this.#task !== null) {
            await this.#task;
        }
        await this.#journal.acknowledge(acknowledgment);
        const receipt: Omit<ConnectorFileAcknowledged, 'signature'> = {
            enrollmentId: acknowledgment.enrollmentId,
            leaseId,
            jobId: acknowledgment.jobId,
            sequence: acknowledgment.sequence,
            dispatchId: acknowledgment.dispatchId,
            requestHash: acknowledgment.requestHash,
            admissionHash: acknowledgment.admissionHash,
            responseHash: acknowledgment.responseHash,
        };
        return {
            ...receipt,
            signature: ConnectorFileProof.sign(
                this.identity.key,
                SignaturePurpose.OperationFileAcknowledged,
                ConnectorFileProof.acknowledged(receipt),
            ),
        };
    }
    /** Join the native operation and atomic retained-result write before releasing process/file capabilities. */
    public async [Symbol.asyncDispose](): Promise<void> {
        this.#closed = true;
        try {
            await this.#task;
        } catch {
        } finally {
            await this.#filesystem[Symbol.asyncDispose]();
            await this.#journal[Symbol.asyncDispose]();
        }
    }

    /** The single in-progress original releases this owner's work slot as soon as it settles. */
    async #run(permit: ConnectorFilePermit): Promise<ConnectorFileResponse> {
        try {
            return await this.#perform(permit);
        } finally {
            this.#task = null;
            this.#permit = null;
        }
    }

    /** Only a fresh effect retains this owner's original staging descriptors; recovered history cannot authorize path-based cleanup. */
    async #perform(permit: ConnectorFilePermit): Promise<ConnectorFileResponse> {
        const freshJoint: boolean =
            this.#journal.pending === null &&
            permit.authorization.kind === ConnectorAuthorizationKind.Joint;
        if (freshJoint) {
            await this.#authorizeJoint(permit);
        }
        const context: ConnectorEffectContext =
            this.#journal.pending?.effectContext ??
            (await this.#filesystem.effectContext(permit.request.rootId));
        if (freshJoint) {
            await this.#authorizeJoint(permit);
        }
        const claim: ConnectorJournalClaim<ConnectorFileOperation, ConnectorFileResponse> =
            await this.#journal.begin(permit, context);
        if (claim.pending.response !== null) {
            return claim.pending.response;
        }
        let stagingId: string | undefined;
        if (ConnectorFilesCodec.isMutation(permit.request.action)) {
            const token: Buffer = this.identity.key.deriveKey(
                KeyDerivationPurpose.WriteStaging,
                Buffer.from(JSON.stringify([permit.jobId, permit.dispatchId, permit.requestHash])),
            );
            try {
                stagingId = token.toString('hex');
            } finally {
                token.fill(0);
            }
        }
        let captured: ConnectorCapturedFileEffect | null = null;
        if (context.kind === ConnectorEffectKind.CapturedFile) {
            captured = context;
            if (!claim.fresh && permit.request.action === ConnectorFileAction.Write) {
                const current: ConnectorCapturedFileEffect = await this.#filesystem.effectContext(
                    permit.request.rootId,
                );
                if (!ConnectorEffectContextCodec.same(current, captured)) {
                    throw new Error('Original physical file authority changed');
                }
                if (stagingId === undefined) {
                    throw new Error('Original staging token unavailable');
                }
                await this.#filesystem.cleanupWrite(permit.request, stagingId, captured);
            }
        }
        if (claim.fresh && captured === null) {
            throw new Error('Fresh file effects require physical capture');
        }
        const response: ConnectorFileResponse =
            claim.fresh && captured !== null && BigInt(Date.now()) < permit.expiresAtMs
                ? await this.#dispatch(permit, stagingId, captured)
                : {
                      ok: false,
                      error:
                          !claim.fresh && ConnectorFilesCodec.isMutation(permit.request.action)
                              ? ConnectorFileFailure.Indeterminate
                              : ConnectorFileFailure.Unavailable,
                  };
        if (claim.fresh && stagingId !== undefined && captured !== null) {
            await this.#filesystem.cleanupWrite(permit.request, stagingId, captured);
        }
        return await this.#journal.finish(permit, response);
    }

    /** The activity screen sees a file operation only when its fresh captured effect is actually dispatched. */
    async #dispatch(
        permit: ConnectorFilePermit,
        stagingId: string | undefined,
        captured: ConnectorCapturedFileEffect,
    ): Promise<ConnectorFileResponse> {
        const activity: ConnectorActivityHandle | null =
            this.#activity?.begin(ConnectorActivityLane.folder(permit.jobId, permit.request)) ??
            null;
        let succeeded: boolean = false;
        try {
            const response: ConnectorFileResponse = await this.#filesystem.dispatchBound(
                ConnectorFileJobsCodec.encode(permit.request),
                stagingId,
                captured,
            );
            succeeded = response.ok;
            return response;
        } finally {
            activity?.finish(succeeded, null);
        }
    }

    async #authorizeJoint(permit: ConnectorFilePermit): Promise<void> {
        if (this.#jointAdmission === null) {
            throw new Error('Fresh joint file admission unavailable');
        }
        await this.#jointAdmission.file(permit);
    }

    #requireAvailable(): void {
        if (this.#closed || this.failed) {
            throw new Error('Connector file workspace owner unavailable');
        }
    }

    #binding(
        value: Pick<ConnectorFilePermit, 'authorityId' | 'enrollmentId' | 'leaseId'>,
        leaseId: string,
    ): void {
        if (
            this.#closed ||
            this.failed ||
            value.authorityId !== this.identity.authority.authorityId ||
            value.enrollmentId !== this.identity.settings.enrollmentId ||
            value.leaseId !== leaseId
        ) {
            throw new Error('Connector file authority changed');
        }
    }
    static #settings(identity: ConnectorClientIdentity): ConnectorLocalCapabilitySettings {
        if (identity.settings.files === null || identity.settings.slot !== 0) {
            throw new Error('Connector file support must be explicitly configured in slot zero');
        }
        return identity.settings.files;
    }
    static async #openFilesystem(
        identity: ConnectorClientIdentity,
        settings: ConnectorLocalCapabilitySettings,
    ): Promise<ConnectorFilesystem> {
        const workspace: ReturnType<typeof JointWorkspaceConfiguration.paths> =
            JointWorkspaceConfiguration.paths(identity.settings.privateKeyFile);
        return await ConnectorFilesystem.load(settings.policyFile, [
            ConnectorHostGrant.directory(identity),
            workspace.configurationFile,
            workspace.stateDirectory,
            workspace.setupFile,
            identity.configurationFile,
            identity.settings.privateKeyFile,
            identity.settings.authorityPublicKeyFile,
            settings.stateDirectory,
            ...(identity.settings.execution === null
                ? []
                : await ExecutionConfiguration.protectedPaths(identity.settings.execution)),
            ...(identity.settings.serverCaFile === null ? [] : [identity.settings.serverCaFile]),
        ]);
    }
}
