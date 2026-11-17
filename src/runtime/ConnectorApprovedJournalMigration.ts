// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

import {
    ConnectorMigrationLane,
    type ConnectorMigrationApproval,
    type ConnectorMigrationExpected,
    type ConnectorMigrationSource,
    type ConnectorMigrationAuthorization,
    type ConnectorMigrationAdmission,
    type ConnectorMigrationOriginal,
} from 'nerva-connector-protocol/protocol/ConnectorAdmissionMigration.js';
import { ConnectorMigrationApprovalCodec } from 'nerva-connector-protocol/protocol/ConnectorMigrationApprovalCodec.js';
import { ConnectorAdmissionMigrationProof } from '../protocol/ConnectorAdmissionMigrationProof.js';
import { ConnectorAuthorizationKind } from 'nerva-connector-protocol/protocol/ConnectorAuthorization.js';
import type { ConnectorClientIdentity } from './ConnectorClientConfiguration.js';
import type { ConnectorJournalMigrationSource } from './ConnectorJournalMigrationSource.js';
import {
    ConnectorJournalSchema,
    ConnectorJournalState,
    type ConnectorJournalSnapshot,
    type ConnectorJournalReceipt,
    type ConnectorJournalPending,
} from './ConnectorJournalState.js';
import {
    ConnectorOperationPurpose,
    type ConnectorOperationCodec,
} from './ConnectorOperationCodec.js';

/** Only a verified authority approval can add explicit admission fields to an exact stopped historical source. */
export class ConnectorApprovedJournalMigration {
    private constructor(
        public readonly approval: ConnectorMigrationApproval,
        public readonly source: ConnectorMigrationSource,
        public readonly authorization: ConnectorMigrationAuthorization,
    ) {}

    /** Authority and device pins come from the protected installation; the certificate never supplies its own trust root. */
    public static create(
        identity: ConnectorClientIdentity,
        approval: ConnectorMigrationApproval,
        purpose: ConnectorOperationPurpose,
    ): ConnectorApprovedJournalMigration {
        const captured: ConnectorMigrationApproval =
            ConnectorMigrationApprovalCodec.value(approval);
        const expected: ConnectorMigrationExpected = {
            authorityId: identity.authority.authorityId,
            authorityPublicKey: identity.authority.publicKey,
            environmentId: identity.settings.environmentId,
            enrollmentId: identity.settings.enrollmentId,
            devicePublicKey: identity.publicKey,
        };
        if (!ConnectorAdmissionMigrationProof.verifyApproval(expected, captured.plan, captured)) {
            throw new Error('Historical admission migration approval is invalid');
        }
        const lane: ConnectorMigrationLane = this.lane(purpose);
        const source: ConnectorMigrationSource | undefined = captured.plan.sources.find(
            (entry: ConnectorMigrationSource): boolean => entry.lane === lane,
        );
        const authorization: ConnectorMigrationAuthorization | undefined =
            captured.authorizations.find(
                (entry: ConnectorMigrationAuthorization): boolean => entry.lane === lane,
            );
        if (source === undefined || authorization === undefined) {
            throw new Error('Historical approval omits the receiver-selected journal');
        }
        return new ConnectorApprovedJournalMigration(captured, source, authorization);
    }

    /** Journal purpose is chosen by the local owner before looking up any certificate entry. */
    public static lane(purpose: ConnectorOperationPurpose): ConnectorMigrationLane {
        switch (purpose) {
            case ConnectorOperationPurpose.Files:
                return ConnectorMigrationLane.Files;
            case ConnectorOperationPurpose.ExecutionFirst:
                return ConnectorMigrationLane.ExecutionFirst;
            case ConnectorOperationPurpose.ExecutionSecond:
                return ConnectorMigrationLane.ExecutionSecond;
        }
    }

    /** Original request, result, physical provenance, dispatch identity and watermarks survive conversion unchanged. */
    public convert<TRequest, TResponse, TProgress = never>(
        historical: ConnectorJournalMigrationSource<TRequest, TResponse, TProgress>,
        sourceSha256: string,
        operation: ConnectorOperationCodec<TRequest, TResponse, TProgress>,
    ): ConnectorJournalSnapshot<TRequest, TResponse, TProgress> {
        const source: ConnectorMigrationSource = this.source;
        if (
            source.lane !== ConnectorApprovedJournalMigration.lane(operation.purpose) ||
            source.sourceSha256 !== sourceSha256 ||
            source.journalId !== historical.journalId ||
            source.acknowledgedSequence !== historical.acknowledgedSequence ||
            !ConnectorApprovedJournalMigration.#same(source.receipt, historical.receipt) ||
            !ConnectorApprovedJournalMigration.#same(source.pending, historical.pending) ||
            source.receipt?.responseHash !== historical.receipt?.responseHash
        ) {
            throw new Error('Historical source changed after its signed migration plan');
        }
        const receipt: ConnectorJournalReceipt | null =
            historical.receipt === null
                ? null
                : {
                      ...historical.receipt,
                      admissionHash: this.#admission(
                          this.authorization.receipt,
                          historical.receipt.requestHash,
                          operation,
                      ),
                  };
        let pending: ConnectorJournalPending<TRequest, TResponse, TProgress> | null = null;
        if (historical.pending !== null) {
            const admission: ConnectorMigrationAdmission | null = this.authorization.pending;
            const admissionHash: string = this.#admission(
                admission,
                historical.pending.requestHash,
                operation,
            );
            if (admission === null) {
                throw new Error('Historical pending authority is missing');
            }
            pending = {
                ...historical.pending,
                authorization: admission.authorization,
                admissionHash,
            };
        }
        const state: ConnectorJournalState<TRequest, TResponse, TProgress> =
            new ConnectorJournalState(operation);
        const target: ConnectorJournalSnapshot<TRequest, TResponse, TProgress> = {
            schema: ConnectorJournalSchema.AuthorizedEffectContext,
            journalId: historical.journalId,
            acknowledgedSequence: historical.acknowledgedSequence,
            receipt,
            pending,
        };
        const raw: unknown = JSON.parse(state.encode(target));
        return state.read(raw);
    }

    #admission<TRequest, TResponse, TProgress>(
        admission: ConnectorMigrationAdmission | null,
        requestHash: string,
        operation: ConnectorOperationCodec<TRequest, TResponse, TProgress>,
    ): string {
        if (
            admission === null ||
            admission.authorization.kind !== ConnectorAuthorizationKind.Independent ||
            operation.admissionHash(requestHash, admission.authorization) !==
                admission.admissionHash
        ) {
            throw new Error(
                'Historical operations require explicit approved independent authority; no joint proof is invented',
            );
        }
        return admission.admissionHash;
    }

    static #same(
        expected: ConnectorMigrationOriginal | null,
        actual: ConnectorMigrationOriginal | null,
    ): boolean {
        return expected === null || actual === null
            ? expected === actual
            : expected.jobId === actual.jobId &&
                  expected.sequence === actual.sequence &&
                  expected.dispatchId === actual.dispatchId &&
                  expected.requestHash === actual.requestHash;
    }
}
