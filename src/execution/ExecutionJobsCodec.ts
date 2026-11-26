// SPDX-FileCopyrightText: 2026 Dacely <business@dacely.com>
// SPDX-License-Identifier: LicenseRef-Proprietary

import { ExecutionLaneCodec } from 'nerva-connector-protocol/execution/ExecutionLaneCodec.js';
import { ExecutionInputCodec } from 'nerva-connector-protocol/execution/ExecutionInputCodec.js';
import { ExecutionMachineRuleCodec } from 'nerva-connector-protocol/execution/ExecutionMachineRuleCodec.js';
import { ExecutionInteractiveRuleCodec } from 'nerva-connector-protocol/execution/ExecutionInteractiveRuleCodec.js';
import type { ExecutionMachineInvocationRule } from 'nerva-connector-protocol/execution/ExecutionMachineInvocation.js';
import { ConnectorAuthorizationCodec } from 'nerva-connector-protocol/protocol/ConnectorAuthorizationCodec.js';
import { Boundary } from 'nerva-connector-protocol/protocol/Boundary.js';
import { ConnectorDeviceCodec } from 'nerva-connector-protocol/protocol/ConnectorDeviceCodec.js';
import { ConnectorEnrollmentCodec } from 'nerva-connector-protocol/protocol/ConnectorEnrollmentCodec.js';
import { IdentityLengths } from 'nerva-connector-protocol/identity/IdentityFormat.js';
import { ExecutionResultCodec } from './ExecutionResultCodec.js';
import { type ExecutionArgumentRule } from 'nerva-connector-protocol/execution/ExecutionPolicyTypes.js';
import { ExecutionArgumentKind } from 'nerva-connector-protocol/execution/ExecutionArgumentKind.js';
import {
    ExecutionWorkspaceAccess,
    type ExecutionResourceLimits,
} from 'nerva-connector-protocol/execution/ExecutionTypes.js';
import {
    ExecutionJobLimits,
    type ExecutionRequest,
    type ExecutionPermit,
    type ExecutionCancellation,
    type ExecutionCompletion,
    type ExecutionAcknowledgment,
    type ExecutionAcknowledged,
    type ExecutionBinding,
    type ExecutionProfile,
    type ExecutionPublication,
    type ExecutionRootGrant,
    type ExecutionProgramGrant,
    type ExecutionInputRule,
} from 'nerva-connector-protocol/execution/ExecutionJobs.js';
import type { ExecutionLane } from 'nerva-connector-protocol/execution/ExecutionLane.js';

/** Execution authority has its own exact codecs; a file operation or signed blob cannot be reinterpreted as a command. */
export class ExecutionJobsCodec {
    /** Preserve exact integers while committing only validated shapes in a fixed property order. */
    public static encode(
        value:
            | ExecutionRequest
            | ExecutionProfile
            | ExecutionPublication
            | ExecutionPermit
            | ExecutionCancellation
            | ExecutionCompletion
            | ExecutionAcknowledgment
            | ExecutionAcknowledged,
    ): string {
        return JSON.stringify(value, (_key: string, entry: unknown): unknown =>
            typeof entry === 'bigint' ? entry.toString() : entry,
        );
    }

    /** Requests select local aliases and explicitly variable argument positions, never host execution configuration. */
    public static request(raw: unknown): ExecutionRequest {
        const value: Readonly<Record<string, unknown>> = Boundary.record(raw, [
            'requestId',
            'policySha256',
            'programId',
            'rootId',
            'arguments',
        ]);
        const request: ExecutionRequest = {
            requestId: Boundary.id(value['requestId']),
            ...ExecutionInputCodec.invocation({
                policySha256: value['policySha256'],
                programId: value['programId'],
                rootId: value['rootId'],
                arguments: value['arguments'],
            }),
        };
        if (Buffer.byteLength(this.encode(request)) > ExecutionJobLimits.requestBytes) {
            throw new Error('Encoded execution request exceeds its retained-result budget');
        }
        return request;
    }

    /** Public profile validation excludes fixed private arguments and enforces the same finite native ceilings. */
    public static profile(raw: unknown): ExecutionProfile {
        const value: Readonly<Record<string, unknown>> = Boundary.record(raw, [
            'revision',
            'policySha256',
            'roots',
            'programs',
            'resources',
            'timeoutMs',
            'maximumAddressBytes',
            'maximumFileBytes',
        ]);
        const roots: readonly ExecutionRootGrant[] = Boundary.array(value['roots'], 16).map(
            (rawRoot: unknown): ExecutionRootGrant => {
                const root: Readonly<Record<string, unknown>> = Boundary.record(rawRoot, [
                    'id',
                    'access',
                ]);
                const access: ExecutionWorkspaceAccess | undefined = Object.values(
                    ExecutionWorkspaceAccess,
                ).find((mode: ExecutionWorkspaceAccess): boolean => mode === root['access']);
                if (access === undefined) {
                    throw new Error('Explicit execution root grant required');
                }
                return { id: Boundary.id(root['id']), access };
            },
        );
        const programs: readonly ExecutionProgramGrant[] = Boundary.array(
            value['programs'],
            16,
        ).map((rawProgram: unknown): ExecutionProgramGrant => {
            const program: Readonly<Record<string, unknown>> = Boundary.record(rawProgram, [
                'id',
                'rootIds',
                'arguments',
            ]);
            const args: readonly ExecutionInputRule[] = Boundary.array(
                program['arguments'],
                32,
            ).map((rawRule: unknown): ExecutionInputRule => {
                const rule: ExecutionArgumentRule = ExecutionInputCodec.argumentRule(rawRule);
                if (rule.kind === ExecutionArgumentKind.Literal) {
                    throw new Error('Fixed private execution arguments cannot be published');
                }
                return rule;
            });
            const rootIds: readonly string[] = Boundary.ids(program['rootIds'], 16);
            ExecutionMachineRuleCodec.placement(args);
            ExecutionInteractiveRuleCodec.placement(args);
            if (
                rootIds.length === 0 ||
                rootIds.some(
                    (id: string): boolean =>
                        !roots.some((root: ExecutionRootGrant): boolean => root.id === id),
                )
            ) {
                throw new Error('Execution program root was not granted');
            }
            return { id: Boundary.id(program['id']), rootIds, arguments: args };
        });
        const resource: Readonly<Record<string, unknown>> = Boundary.record(value['resources'], [
            'memoryBytes',
            'maximumTasks',
            'cpuQuotaMicros',
        ]);
        const resources: ExecutionResourceLimits = {
            memoryBytes: Boundary.integer(resource['memoryBytes']),
            maximumTasks: Boundary.count(resource['maximumTasks'], 64),
            cpuQuotaMicros: Boundary.count(resource['cpuQuotaMicros'], 100000),
        };
        const revision: bigint = Boundary.integer(value['revision']);
        const timeoutMs: number = Boundary.count(value['timeoutMs'], 30000);
        for (const program of programs) {
            ExecutionInteractiveRuleCodec.profile(program.arguments, timeoutMs);
            const rule: ExecutionMachineInvocationRule | null = ExecutionMachineRuleCodec.placement(
                program.arguments,
            );
            if (rule !== null && rule.maximumTimeoutMs > timeoutMs) {
                throw new Error('Published Machine timeout exceeds its execution profile');
            }
        }
        const maximumAddressBytes: bigint = Boundary.integer(value['maximumAddressBytes']);
        const maximumFileBytes: bigint = Boundary.integer(value['maximumFileBytes']);
        if (
            revision === 0n ||
            roots.length === 0 ||
            programs.length === 0 ||
            new Set(roots.map((root: ExecutionRootGrant): string => root.id)).size !==
                roots.length ||
            new Set(programs.map((program: ExecutionProgramGrant): string => program.id)).size !==
                programs.length ||
            resources.memoryBytes < 33554432n ||
            resources.memoryBytes > 1073741824n ||
            resources.maximumTasks < 2 ||
            resources.cpuQuotaMicros < 1000 ||
            timeoutMs < 100 ||
            maximumAddressBytes < 33554432n ||
            maximumAddressBytes > 17592186044416n ||
            maximumFileBytes > 16777216n
        ) {
            throw new Error('Invalid finite execution profile');
        }
        return {
            revision,
            policySha256: ExecutionInputCodec.digest(value['policySha256']),
            roots,
            programs,
            resources,
            timeoutMs,
            maximumAddressBytes,
            maximumFileBytes,
        };
    }

    /** Device-selected grants and permanent state identity are tied to this exact environment and lease. */
    public static publication(raw: unknown): ExecutionPublication {
        const value: Readonly<Record<string, unknown>> = Boundary.record(raw, [
            'environmentId',
            'lane',
            'enrollmentId',
            'leaseId',
            'profile',
            'journalId',
            'signature',
        ]);
        return {
            ...this.#binding(value),
            profile: this.profile(value['profile']),
            journalId: ExecutionInputCodec.digest(value['journalId']),
            signature: this.#signature(value['signature']),
        };
    }

    /** Finite start authority and a hard effect deadline are distinct and both must fit the current lease. */
    public static permit(raw: unknown): ExecutionPermit {
        const value: Readonly<Record<string, unknown>> = Boundary.record(raw, [
            'authorityId',
            'environmentId',
            'lane',
            'enrollmentId',
            'leaseId',
            'jobId',
            'sequence',
            'dispatchId',
            'requestHash',
            'admissionHash',
            'request',
            'authorization',
            'issuedAtMs',
            'expiresAtMs',
            'executionDeadlineMs',
            'signature',
        ]);
        const issuedAtMs: bigint = Boundary.integer(value['issuedAtMs']);
        const expiresAtMs: bigint = Boundary.integer(value['expiresAtMs']);
        const executionDeadlineMs: bigint = Boundary.integer(value['executionDeadlineMs']);
        if (
            expiresAtMs <= issuedAtMs ||
            expiresAtMs - issuedAtMs > ExecutionJobLimits.permitMs ||
            executionDeadlineMs < expiresAtMs ||
            executionDeadlineMs - issuedAtMs > ExecutionJobLimits.executionMs
        ) {
            throw new Error('Invalid execution permit deadlines');
        }
        return {
            authorityId: Boundary.id(value['authorityId']),
            ...this.#binding(value),
            jobId: Boundary.id(value['jobId']),
            sequence: this.#sequence(value['sequence']),
            dispatchId: ConnectorDeviceCodec.nonce(value['dispatchId']),
            requestHash: ExecutionInputCodec.digest(value['requestHash']),
            admissionHash: ExecutionInputCodec.digest(value['admissionHash']),
            request: this.request(value['request']),
            authorization: ConnectorAuthorizationCodec.read(value['authorization']),
            issuedAtMs,
            expiresAtMs,
            executionDeadlineMs,
            signature: this.#signature(value['signature']),
        };
    }

    /** Stops carry no execution deadline or start authority and cannot outlive their short signed validity. */
    public static cancellation(raw: unknown): ExecutionCancellation {
        const value: Readonly<Record<string, unknown>> = Boundary.record(raw, [
            'authorityId',
            'environmentId',
            'lane',
            'enrollmentId',
            'leaseId',
            'jobId',
            'sequence',
            'dispatchId',
            'requestHash',
            'admissionHash',
            'request',
            'authorization',
            'issuedAtMs',
            'expiresAtMs',
            'signature',
        ]);
        const issuedAtMs: bigint = Boundary.integer(value['issuedAtMs']);
        const expiresAtMs: bigint = Boundary.integer(value['expiresAtMs']);
        if (expiresAtMs <= issuedAtMs || expiresAtMs - issuedAtMs > ExecutionJobLimits.permitMs) {
            throw new Error('Invalid execution cancellation validity');
        }
        return {
            authorityId: Boundary.id(value['authorityId']),
            ...this.#binding(value),
            jobId: Boundary.id(value['jobId']),
            sequence: this.#sequence(value['sequence']),
            dispatchId: ConnectorDeviceCodec.nonce(value['dispatchId']),
            requestHash: ExecutionInputCodec.digest(value['requestHash']),
            admissionHash: ExecutionInputCodec.digest(value['admissionHash']),
            request: this.request(value['request']),
            authorization: ConnectorAuthorizationCodec.read(value['authorization']),
            issuedAtMs,
            expiresAtMs,
            signature: this.#signature(value['signature']),
        };
    }

    /** A terminal result is validated before its output is released or accepted as durable history. */
    public static completion(raw: unknown): ExecutionCompletion {
        const value: Readonly<Record<string, unknown>> = Boundary.record(raw, [
            'environmentId',
            'lane',
            'enrollmentId',
            'leaseId',
            'jobId',
            'sequence',
            'dispatchId',
            'requestHash',
            'admissionHash',
            'responseHash',
            'response',
            'signature',
        ]);
        return { ...this.#receipt(value), response: ExecutionResultCodec.read(value['response']) };
    }

    /** Backend acknowledgment has its own signature purpose and explicit installed authority. */
    public static acknowledgment(raw: unknown): ExecutionAcknowledgment {
        const value: Readonly<Record<string, unknown>> = Boundary.record(raw, [
            'authorityId',
            'environmentId',
            'lane',
            'enrollmentId',
            'leaseId',
            'jobId',
            'sequence',
            'dispatchId',
            'requestHash',
            'admissionHash',
            'responseHash',
            'signature',
        ]);
        return { authorityId: Boundary.id(value['authorityId']), ...this.#receipt(value) };
    }

    /** Compaction proof cannot be repurposed into result or start authority. */
    public static acknowledged(raw: unknown): ExecutionAcknowledged {
        const value: Readonly<Record<string, unknown>> = Boundary.record(raw, [
            'environmentId',
            'lane',
            'enrollmentId',
            'leaseId',
            'jobId',
            'sequence',
            'dispatchId',
            'requestHash',
            'admissionHash',
            'responseHash',
            'signature',
        ]);
        return this.#receipt(value);
    }

    static #binding(value: Readonly<Record<string, unknown>>): ExecutionBinding {
        return {
            lane: this.lane(value['lane']),
            environmentId: Boundary.id(value['environmentId']),
            enrollmentId: ConnectorEnrollmentCodec.id(value['enrollmentId']),
            leaseId: ConnectorDeviceCodec.nonce(value['leaseId']),
        };
    }
    /** A caller cannot allocate arbitrary replay journals or increase concurrency through new lane names. */
    public static lane(raw: unknown): ExecutionLane {
        return ExecutionLaneCodec.read(raw);
    }
    static #receipt(value: Readonly<Record<string, unknown>>): ExecutionAcknowledged {
        return {
            ...this.#binding(value),
            jobId: Boundary.id(value['jobId']),
            sequence: this.#sequence(value['sequence']),
            dispatchId: ConnectorDeviceCodec.nonce(value['dispatchId']),
            requestHash: ExecutionInputCodec.digest(value['requestHash']),
            admissionHash: ExecutionInputCodec.digest(value['admissionHash']),
            responseHash: ExecutionInputCodec.digest(value['responseHash']),
            signature: this.#signature(value['signature']),
        };
    }
    static #sequence(raw: unknown): bigint {
        const value: bigint = Boundary.integer(raw);
        if (value === 0n) {
            throw new Error('Execution sequence starts at one');
        }
        return value;
    }
    static #signature(raw: unknown): string {
        return ConnectorEnrollmentCodec.binary(raw, IdentityLengths.signature);
    }
}
