// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

import { Boundary } from 'nerva-connector-protocol/protocol/Boundary.js';
import { ConnectorEnrollmentCodec } from 'nerva-connector-protocol/protocol/ConnectorEnrollmentCodec.js';
import type { ConnectorStorageCodec } from '../runtime/ConnectorOperationCodec.js';
import { JointWorkspaceJournalContext } from './JointWorkspaceJournalContext.js';
import { JointWorkspacePublicationCodec } from 'nerva-connector-protocol/workspace/JointWorkspacePublicationCodec.js';
import { JointWorkspaceProof } from 'nerva-connector-protocol/workspace/JointWorkspaceProof.js';
import { JointWorkspaceReceiptCodec } from 'nerva-connector-protocol/workspace/JointWorkspaceReceiptCodec.js';
import { JointWorkspaceReceiptProof } from 'nerva-connector-protocol/workspace/JointWorkspaceReceiptProof.js';
import type { JointWorkspacePublication } from 'nerva-connector-protocol/workspace/JointWorkspacePublication.js';
import type {
    JointWorkspaceReceiptExpected,
    JointWorkspaceReceipt,
} from 'nerva-connector-protocol/workspace/JointWorkspaceReceipt.js';
import {
    JointWorkspaceJournalLimits,
    JointWorkspaceJournalSchema,
    type JointWorkspaceJournalSnapshot,
    type JointWorkspaceJournalReference,
    type JointWorkspaceJournalPair,
    type JointWorkspaceJournalAccepted,
} from './JointWorkspaceJournalTypes.js';
import { SigningKey } from '../identity/SigningKey.js';

/** Authenticated plaintext still undergoes strict ordering, immutable-reference, proof and installation validation. */
export class JointWorkspaceJournalState implements ConnectorStorageCodec<JointWorkspaceJournalSnapshot> {
    public constructor(public readonly context: JointWorkspaceJournalContext) {}

    /** Only explicit installation may create this empty state; runtime opening never calls it. */
    public empty(): JointWorkspaceJournalSnapshot {
        return Object.freeze({
            schema: JointWorkspaceJournalSchema.Current,
            identitySha256: this.context.digest,
            revision: 0n,
            reservedRevision: null,
            references: Object.freeze([]),
            pairs: Object.freeze([]),
            pending: null,
            accepted: null,
        });
    }

    public read(raw: unknown): JointWorkspaceJournalSnapshot {
        const value: Readonly<Record<string, unknown>> = Boundary.record(raw, [
            'schema',
            'identitySha256',
            'revision',
            'reservedRevision',
            'references',
            'pairs',
            'pending',
            'accepted',
        ]);
        if (
            value['schema'] !== JointWorkspaceJournalSchema.Current ||
            value['identitySha256'] !== this.context.digest
        ) {
            throw new Error('Joint workspace history does not match this installation');
        }
        const revision: bigint = Boundary.integer(value['revision']);
        if (revision > BigInt(JointWorkspaceJournalLimits.revisions)) {
            throw new Error('Joint workspace revision quota exceeded');
        }
        const references: readonly JointWorkspaceJournalReference[] = Object.freeze(
            Boundary.array(value['references'], JointWorkspaceJournalLimits.revisions).map(
                (entry: unknown): JointWorkspaceJournalReference => {
                    const row: Readonly<Record<string, unknown>> = Boundary.record(entry, [
                        'revision',
                        'bindingSha256',
                    ]);
                    const current: bigint = Boundary.integer(row['revision']);
                    if (current === 0n || current > revision) {
                        throw new Error('Invalid retained workspace revision');
                    }
                    return Object.freeze({
                        revision: current,
                        bindingSha256: ConnectorEnrollmentCodec.digest(row['bindingSha256']),
                    });
                },
            ),
        );
        for (let index: number = 1; index < references.length; index++) {
            const previous: JointWorkspaceJournalReference | undefined = references[index - 1];
            const current: JointWorkspaceJournalReference | undefined = references[index];
            if (
                previous === undefined ||
                current === undefined ||
                previous.revision >= current.revision
            ) {
                throw new Error('Workspace archive references must be strictly ordered');
            }
        }
        const retained: Set<bigint> = new Set(
            references.map((entry: JointWorkspaceJournalReference): bigint => entry.revision),
        );
        const reservedRevision: bigint | null =
            value['reservedRevision'] === null ? null : Boundary.integer(value['reservedRevision']);
        if (
            reservedRevision !== null &&
            (reservedRevision === 0n ||
                reservedRevision !== revision ||
                retained.has(reservedRevision))
        ) {
            throw new Error('Invalid durable workspace revision reservation');
        }
        const pairKeys: Set<string> = new Set();
        const pairs: readonly JointWorkspaceJournalPair[] = Object.freeze(
            Boundary.array(value['pairs'], JointWorkspaceJournalLimits.pairs).map(
                (entry: unknown): JointWorkspaceJournalPair => {
                    const row: Readonly<Record<string, unknown>> = Boundary.record(entry, [
                        'fileRootId',
                        'executionRootId',
                        'revision',
                    ]);
                    const pair: JointWorkspaceJournalPair = Object.freeze({
                        fileRootId: Boundary.id(row['fileRootId']),
                        executionRootId: Boundary.id(row['executionRootId']),
                        revision: Boundary.integer(row['revision']),
                    });
                    const key: string = JSON.stringify([pair.fileRootId, pair.executionRootId]);
                    if (!retained.has(pair.revision) || pairKeys.has(key)) {
                        throw new Error('Invalid current workspace alias-pair reference');
                    }
                    pairKeys.add(key);
                    return pair;
                },
            ),
        );
        const pending: JointWorkspacePublication | null =
            value['pending'] === null
                ? null
                : JointWorkspacePublicationCodec.publication(value['pending']);
        if (pending !== null) {
            this.#publication(pending, references);
            if (
                reservedRevision !== null ||
                !pairs.some((pair: JointWorkspaceJournalPair): boolean => this.#pair(pair, pending))
            ) {
                throw new Error('Pending workspace publication lost its current alias pair');
            }
        }
        const accepted: JointWorkspaceJournalAccepted | null =
            value['accepted'] === null ? null : this.#accepted(value['accepted'], references);
        return Object.freeze({
            schema: JointWorkspaceJournalSchema.Current,
            identitySha256: this.context.digest,
            revision,
            reservedRevision,
            references,
            pairs,
            pending,
            accepted,
        });
    }

    /** Owner-generated states remain bounded and validate before encryption; no content or private physical identity is retained. */
    public encode(value: JointWorkspaceJournalSnapshot): string {
        if (
            value.references.length > JointWorkspaceJournalLimits.revisions ||
            value.pairs.length > JointWorkspaceJournalLimits.pairs
        ) {
            throw new Error('Joint workspace history exceeds its fixed quota');
        }
        const json: string = JSON.stringify(value, (_key: string, entry: unknown): unknown =>
            typeof entry === 'bigint' ? entry.toString() : entry,
        );
        if (Buffer.byteLength(json) > JointWorkspaceJournalLimits.headPlainBytes) {
            throw new Error('Joint workspace history exceeds its fixed storage bound');
        }
        const raw: unknown = JSON.parse(json);
        this.read(raw);
        return json;
    }

    #publication(
        publication: JointWorkspacePublication,
        references: readonly JointWorkspaceJournalReference[],
    ): void {
        this.context.publication(publication);
        const reference: JointWorkspaceJournalReference | undefined = references.find(
            (entry: JointWorkspaceJournalReference): boolean =>
                entry.revision === publication.descriptor.binding.revision,
        );
        if (
            reference === undefined ||
            reference.bindingSha256 !==
                JointWorkspaceProof.bindingSha256(publication.descriptor.binding)
        ) {
            throw new Error('Workspace publication has no matching retained archive');
        }
    }

    #accepted(
        raw: unknown,
        references: readonly JointWorkspaceJournalReference[],
    ): JointWorkspaceJournalAccepted {
        const value: Readonly<Record<string, unknown>> = Boundary.record(raw, [
            'publication',
            'receipt',
            'leaseIssuedAtMs',
            'leaseExpiresAtMs',
        ]);
        const publication: JointWorkspacePublication = JointWorkspacePublicationCodec.publication(
            value['publication'],
        );
        this.#publication(publication, references);
        const receipt: JointWorkspaceReceipt = JointWorkspaceReceiptCodec.receipt(value['receipt']);
        const leaseIssuedAtMs: bigint = Boundary.integer(value['leaseIssuedAtMs']);
        const leaseExpiresAtMs: bigint = Boundary.integer(value['leaseExpiresAtMs']);
        const expected: JointWorkspaceReceiptExpected = {
            ...this.context.scope,
            slot: 0,
            leaseId: publication.leaseId,
            authorityPublicKey: this.context.identity.scope.authorityPublicKey,
            leaseIssuedAtMs,
            leaseExpiresAtMs,
        };
        if (
            !JointWorkspaceReceiptProof.verify(
                SigningKey,
                expected,
                publication,
                receipt,
                receipt.issuedAtMs,
            )
        ) {
            throw new Error('Retained workspace acceptance does not authenticate');
        }
        return Object.freeze({ publication, receipt, leaseIssuedAtMs, leaseExpiresAtMs });
    }

    #pair(pair: JointWorkspaceJournalPair, publication: JointWorkspacePublication): boolean {
        const binding: JointWorkspacePublication['descriptor']['binding'] =
            publication.descriptor.binding;
        return (
            pair.fileRootId === binding.fileRootId &&
            pair.executionRootId === binding.executionRootId &&
            pair.revision === binding.revision
        );
    }
}
