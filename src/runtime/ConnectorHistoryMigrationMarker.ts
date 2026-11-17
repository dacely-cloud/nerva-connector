// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

import { createHash } from 'node:crypto';
import { Boundary } from 'nerva-connector-protocol/protocol/Boundary.js';
import { ConnectorEnrollmentCodec } from 'nerva-connector-protocol/protocol/ConnectorEnrollmentCodec.js';
import { SignaturePurpose } from 'nerva-connector-protocol/identity/IdentityFormat.js';
import { SigningKey } from '../identity/SigningKey.js';
import type { ConnectorClientIdentity } from './ConnectorClientConfiguration.js';
import { ConnectorOperationPurpose } from './ConnectorOperationCodec.js';

/** The marker format is separate from the migrated journal format and cannot be negotiated. */
export enum ConnectorHistoryMigrationSchema {
    AuthorizedAdmission = 'authorized-admission-migration',
}

/** A durable prepared marker fences all normal startup until every retained history is verified current. */
export enum ConnectorHistoryMigrationPhase {
    Prepared = 'prepared',
    Complete = 'complete',
}

/** One source/target pair identifies only a retained configured journal, never its private payload. */
export interface ConnectorHistoryMigrationEntry {
    readonly purpose: ConnectorOperationPurpose;
    readonly sourceSha256: string;
    readonly expectedPlainSha256: string;
}

/** The signed private marker keeps one bounded interrupted migration recoverable. */
export interface ConnectorHistoryMigrationReceipt {
    readonly schema: ConnectorHistoryMigrationSchema.AuthorizedAdmission;
    readonly phase: ConnectorHistoryMigrationPhase;
    readonly bindingSha256: string;
    readonly approvalSha256: string;
    readonly appliedSha256: string | null;
    readonly entries: readonly ConnectorHistoryMigrationEntry[];
    readonly signature: string;
}

/** One canonical envelope protects marker phase and immutable original source/target commitments. */
export class ConnectorHistoryMigrationMarker {
    public static readonly filename: string = 'history-migration.json';
    public static readonly maximumBytes: number = 16384;

    /** Policy text may change later; the retained key, authority, enrollment and journal locations may not be silently adopted. */
    public static binding(identity: ConnectorClientIdentity): string {
        return createHash('sha256')
            .update(
                JSON.stringify([
                    'nerva-connector:history-migration:1',
                    identity.publicKey,
                    identity.authority.authorityId,
                    identity.authority.publicKey,
                    identity.settings.enrollmentId,
                    identity.settings.environmentId,
                    identity.settings.files?.stateDirectory ?? null,
                    identity.settings.execution?.stateDirectory ?? null,
                ]),
            )
            .digest('hex');
    }

    /** Marker creation adds no new device identity or remote authentication authority. */
    public static create(
        identity: ConnectorClientIdentity,
        phase: ConnectorHistoryMigrationPhase,
        entries: readonly ConnectorHistoryMigrationEntry[],
        approvalSha256: string,
        appliedSha256: string | null,
    ): ConnectorHistoryMigrationReceipt {
        const payload: Omit<ConnectorHistoryMigrationReceipt, 'signature'> = {
            schema: ConnectorHistoryMigrationSchema.AuthorizedAdmission,
            phase,
            bindingSha256: this.binding(identity),
            approvalSha256: ConnectorEnrollmentCodec.digest(approvalSha256),
            appliedSha256:
                appliedSha256 === null ? null : ConnectorEnrollmentCodec.digest(appliedSha256),
            entries,
        };
        return {
            ...payload,
            signature: identity.key.sign(SignaturePurpose.HistoryMigration, this.#payload(payload)),
        };
    }

    /** Invalid signatures, extra fields and different local history authority fail closed. */
    public static read(
        bytes: Buffer,
        identity: ConnectorClientIdentity,
    ): ConnectorHistoryMigrationReceipt {
        const raw: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
        const value: Readonly<Record<string, unknown>> = Boundary.record(raw, [
            'schema',
            'phase',
            'bindingSha256',
            'approvalSha256',
            'appliedSha256',
            'entries',
            'signature',
        ]);
        const phase: ConnectorHistoryMigrationPhase | undefined = Object.values(
            ConnectorHistoryMigrationPhase,
        ).find((entry: ConnectorHistoryMigrationPhase): boolean => entry === value['phase']);
        if (
            value['schema'] !== ConnectorHistoryMigrationSchema.AuthorizedAdmission ||
            phase === undefined ||
            typeof value['signature'] !== 'string'
        ) {
            throw new Error('Invalid history migration marker');
        }
        const entries: readonly ConnectorHistoryMigrationEntry[] = Boundary.array(
            value['entries'],
            3,
        ).map((rawEntry: unknown): ConnectorHistoryMigrationEntry => {
            const entry: Readonly<Record<string, unknown>> = Boundary.record(rawEntry, [
                'purpose',
                'sourceSha256',
                'expectedPlainSha256',
            ]);
            const purpose: ConnectorOperationPurpose | undefined = Object.values(
                ConnectorOperationPurpose,
            ).find(
                (candidate: ConnectorOperationPurpose): boolean => candidate === entry['purpose'],
            );
            if (purpose === undefined) {
                throw new Error('Invalid history migration lane');
            }
            return {
                purpose,
                sourceSha256: ConnectorEnrollmentCodec.digest(entry['sourceSha256']),
                expectedPlainSha256: ConnectorEnrollmentCodec.digest(entry['expectedPlainSha256']),
            };
        });
        if (
            new Set(
                entries.map(
                    (entry: ConnectorHistoryMigrationEntry): ConnectorOperationPurpose =>
                        entry.purpose,
                ),
            ).size !== entries.length
        ) {
            throw new Error('Repeated history migration lane');
        }
        const expected: readonly ConnectorOperationPurpose[] = [
            ...(identity.settings.files === null ? [] : [ConnectorOperationPurpose.Files]),
            ...(identity.settings.execution === null
                ? []
                : [
                      ConnectorOperationPurpose.ExecutionFirst,
                      ConnectorOperationPurpose.ExecutionSecond,
                  ]),
        ];
        if (
            entries.length !== expected.length ||
            entries.some(
                (entry: ConnectorHistoryMigrationEntry, index: number): boolean =>
                    entry.purpose !== expected[index],
            )
        ) {
            throw new Error('History migration marker omits or substitutes a configured lane');
        }
        const payload: Omit<ConnectorHistoryMigrationReceipt, 'signature'> = {
            schema: ConnectorHistoryMigrationSchema.AuthorizedAdmission,
            phase,
            bindingSha256: ConnectorEnrollmentCodec.digest(value['bindingSha256']),
            approvalSha256: ConnectorEnrollmentCodec.digest(value['approvalSha256']),
            appliedSha256:
                value['appliedSha256'] === null
                    ? null
                    : ConnectorEnrollmentCodec.digest(value['appliedSha256']),
            entries,
        };
        if (
            (payload.phase === ConnectorHistoryMigrationPhase.Prepared &&
                payload.appliedSha256 !== null) ||
            (payload.phase === ConnectorHistoryMigrationPhase.Complete &&
                payload.appliedSha256 === null) ||
            payload.bindingSha256 !== this.binding(identity) ||
            !SigningKey.verify(
                SignaturePurpose.HistoryMigration,
                identity.publicKey,
                this.#payload(payload),
                value['signature'],
            )
        ) {
            throw new Error('History migration authority changed');
        }
        return { ...payload, signature: value['signature'] };
    }

    static #payload(receipt: Omit<ConnectorHistoryMigrationReceipt, 'signature'>): Buffer {
        return Buffer.from(JSON.stringify(receipt));
    }
}
