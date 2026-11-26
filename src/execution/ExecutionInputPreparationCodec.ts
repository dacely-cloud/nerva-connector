// SPDX-FileCopyrightText: 2026 Dacely <business@dacely.com>
// SPDX-License-Identifier: LicenseRef-Proprietary

import { ConnectorClock } from '../protocol/ConnectorClock.js';
import { SigningKey } from '../identity/SigningKey.js';
import { SignaturePurpose } from 'nerva-connector-protocol/identity/IdentityFormat.js';
import { ConnectorAuthorizationProof } from 'nerva-connector-protocol/protocol/ConnectorAuthorizationProof.js';
import { ExecutionInteractiveFields as Fields } from 'nerva-connector-protocol/execution/ExecutionInteractiveFields.js';
import { ExecutionInteractiveRuleCodec } from 'nerva-connector-protocol/execution/ExecutionInteractiveRuleCodec.js';
import { ExecutionInteractiveLaunchCodec } from 'nerva-connector-protocol/execution/ExecutionInteractiveLaunchCodec.js';
import { ExecutionJobsCodec } from './ExecutionJobsCodec.js';
import { ExecutionProof } from 'nerva-connector-protocol/execution/ExecutionProof.js';
import type { ConnectorStorageCodec } from '../runtime/ConnectorOperationCodec.js';
import type { ConnectorClientSession } from '../runtime/ConnectorClientSession.js';
import type { ConnectorDeviceLease } from 'nerva-connector-protocol/protocol/ConnectorDevice.js';
import type { ExecutionInputJournalValidation } from './ExecutionInputJournalValidation.js';
import {
    ExecutionInputJournalSchema,
    ExecutionInputJournalPhase,
    ExecutionInputJournalLimits as Limits,
    type ExecutionInputJournalPreparedState,
    type ExecutionInputJournalPreparation,
    type ExecutionInputJournalTerminal,
} from './ExecutionInputJournalTypes.js';

/** Intended launch authority is durable before group binding, without asserting that exec or any input occurred. */
export class ExecutionInputPreparationCodec implements ConnectorStorageCodec<ExecutionInputJournalPreparedState> {
    public constructor(public readonly validation: ExecutionInputJournalValidation) {}

    /** Decrypted preparation must still carry its complete original backend signature and canonical grant. */
    public read(raw: unknown): ExecutionInputJournalPreparedState {
        const value: Readonly<Record<string, unknown>> = Fields.record(raw, [
            'schema',
            'phase',
            'scope',
            'preparation',
            'ownerLost',
            'terminal',
        ]);
        const scope: Readonly<Record<string, unknown>> = Fields.record(value['scope'], [
            'lane',
            'journalId',
        ]);
        if (
            value['schema'] !== ExecutionInputJournalSchema.Cursor ||
            value['phase'] !== ExecutionInputJournalPhase.Prepared ||
            ExecutionJobsCodec.lane(scope['lane']) !== this.validation.scope.lane ||
            Fields.digest(scope['journalId']) !== this.validation.scope.journalId
        ) {
            throw new Error('Prepared input belongs to another permanent execution lane');
        }
        return Object.freeze({
            schema: ExecutionInputJournalSchema.Cursor,
            phase: ExecutionInputJournalPhase.Prepared,
            scope: this.validation.scope,
            preparation: this.#preparation(value['preparation']),
            ownerLost: Fields.boolean(value['ownerLost']),
            terminal: value['terminal'] === null ? null : this.#terminal(value['terminal']),
        });
    }
    /** Typed preparations pass through the same bounded wire decoder before they become durable authority. */
    public capture(value: ExecutionInputJournalPreparation): ExecutionInputJournalPreparation {
        const raw: unknown = JSON.parse(this.#json(value));
        return this.#preparation(raw);
    }
    /** Only the genuinely fresh main execution path may prepare under this exact current mutually confirmed lease. */
    public fresh(
        value: ExecutionInputJournalPreparation,
        session: ConnectorClientSession,
        nowMs: bigint,
    ): void {
        const lease: ConnectorDeviceLease = this.validation.current(session, nowMs);
        const permit: typeof value.permit = value.permit;
        if (
            permit.leaseId !== lease.leaseId ||
            permit.issuedAtMs < lease.issuedAtMs ||
            !ConnectorClock.issued(permit.issuedAtMs, nowMs) ||
            permit.expiresAtMs <= nowMs ||
            permit.expiresAtMs > lease.expiresAtMs
        ) {
            throw new Error('Prepared input requires a live exact original execution permit');
        }
        ExecutionInteractiveLaunchCodec.admit(value.rule, permit.request.arguments[0] ?? '', nowMs);
    }
    /** Every atomic publication revalidates the exact finite record. */
    public encode(state: ExecutionInputJournalPreparedState): string {
        const json: string = this.#json(state);
        const raw: unknown = JSON.parse(json);
        return this.#json(this.read(raw));
    }
    #preparation(raw: unknown): ExecutionInputJournalPreparation {
        const value: Readonly<Record<string, unknown>> = Fields.record(raw, [
            'permit',
            'rule',
            'launch',
            'incarnation',
        ]);
        const permit: ReturnType<typeof ExecutionJobsCodec.permit> = ExecutionJobsCodec.permit(
            value['permit'],
        );
        const rule: ReturnType<typeof ExecutionInteractiveRuleCodec.read> =
            ExecutionInteractiveRuleCodec.read(value['rule']);
        const launch: ReturnType<typeof ExecutionInteractiveLaunchCodec.decode> =
            ExecutionInteractiveLaunchCodec.decode(rule, JSON.stringify(value['launch']));
        if (
            Buffer.byteLength(this.#json(rule)) > Limits.ruleBytes ||
            permit.authorityId !== this.validation.identity.authority.authorityId ||
            permit.environmentId !== this.validation.identity.settings.environmentId ||
            permit.enrollmentId !== this.validation.identity.settings.enrollmentId ||
            permit.lane !== this.validation.scope.lane ||
            permit.executionDeadlineMs !== launch.executionDeadlineMs ||
            permit.request.arguments.length !== 1 ||
            permit.request.arguments[0] !== ExecutionInteractiveLaunchCodec.encode(rule, launch) ||
            ExecutionProof.requestHash(permit.request) !== permit.requestHash ||
            ConnectorAuthorizationProof.execution(
                permit.requestHash,
                permit.lane,
                permit.authorization,
            ) !== permit.admissionHash ||
            !SigningKey.verify(
                SignaturePurpose.OperationExecutionPermit,
                this.validation.identity.authority.publicKey,
                ExecutionProof.permit(permit),
                permit.signature,
            )
        ) {
            throw new Error('Prepared input changed its captured original or signed launch');
        }
        return Object.freeze({
            permit,
            rule,
            launch,
            incarnation: Fields.digest(value['incarnation']),
        });
    }
    #terminal(raw: unknown): ExecutionInputJournalTerminal {
        const value: Readonly<Record<string, unknown>> = Fields.record(raw, [
            'completionSha256',
            'acknowledgmentSha256',
            'responseHash',
        ]);
        return Object.freeze({
            completionSha256: Fields.digest(value['completionSha256']),
            acknowledgmentSha256: Fields.digest(value['acknowledgmentSha256']),
            responseHash: Fields.digest(value['responseHash']),
        });
    }
    #json(
        value:
            | ExecutionInputJournalPreparedState
            | ExecutionInputJournalPreparation
            | ExecutionInputJournalPreparation['rule'],
    ): string {
        const json: string = JSON.stringify(value, (_key: string, entry: unknown): unknown =>
            typeof entry === 'bigint' ? entry.toString() : entry,
        );
        if (Buffer.byteLength(json) > Limits.plainBytes) {
            throw new Error('Prepared input exceeds its finite journal bound');
        }
        return json;
    }
}
