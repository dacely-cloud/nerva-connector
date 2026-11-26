// SPDX-FileCopyrightText: 2026 Dacely <business@dacely.com>
// SPDX-License-Identifier: LicenseRef-Proprietary

import { Boundary } from 'nerva-connector-protocol/protocol/Boundary.js';
import { ConnectorEnrollmentCodec } from 'nerva-connector-protocol/protocol/ConnectorEnrollmentCodec.js';
import { WorkspaceIdentityCodec } from '../workspace/WorkspaceIdentityCodec.js';
import { ExecutionCgroupIdentityCodec } from '../execution/ExecutionCgroupIdentityCodec.js';
import type { ExecutionCgroupIdentity } from '../execution/ExecutionCgroupIdentity.js';
import {
    ConnectorEffectKind,
    type ConnectorEffectContext,
    type ConnectorNativeFileEffect,
    type ConnectorCapturedFileEffect,
} from './ConnectorEffectContext.js';

/** Exact private journal/native shapes preserve uint64 identity without exposing it as public grant data. */
export class ConnectorEffectContextCodec {
    /** Migration provenance is explicit; unsupported or missing alternatives fail normal decoding. */
    public static read(raw: unknown): ConnectorEffectContext {
        if (typeof raw !== 'object' || raw === null || !('kind' in raw)) {
            throw new Error('File effect provenance is missing');
        }
        if (raw.kind === ConnectorEffectKind.HistoricalUnproven) {
            const value: Readonly<Record<string, unknown>> = Boundary.record(raw, [
                'kind',
                'sourceSha256',
            ]);
            return Object.freeze({
                kind: ConnectorEffectKind.HistoricalUnproven,
                sourceSha256: ConnectorEnrollmentCodec.digest(value['sourceSha256']),
            });
        }
        if (raw.kind === ConnectorEffectKind.IndependentExecution) {
            Boundary.record(raw, ['kind']);
            return Object.freeze({ kind: ConnectorEffectKind.IndependentExecution });
        }
        if (raw.kind === ConnectorEffectKind.ExecutionNotStarted) {
            Boundary.record(raw, ['kind']);
            return Object.freeze({ kind: ConnectorEffectKind.ExecutionNotStarted });
        }
        if (
            raw.kind === ConnectorEffectKind.CapturedExecution ||
            raw.kind === ConnectorEffectKind.CapturedInteractiveExecution
        ) {
            const captured: Readonly<Record<string, unknown>> = Boundary.record(raw, [
                'kind',
                'policySha256',
                'rootId',
                'root',
                'cgroupRoot',
                'cgroupHelperFile',
                'cgroupHelperSha256',
                'delegation',
                'group',
                ...(raw.kind === ConnectorEffectKind.CapturedInteractiveExecution
                    ? ['incarnation']
                    : []),
            ]);
            const cgroupRoot: string = this.#path(captured['cgroupRoot']);
            if (!cgroupRoot.startsWith('/sys/fs/cgroup/')) {
                throw new Error('Invalid original cgroup delegation locator');
            }
            const delegation: ExecutionCgroupIdentity = ExecutionCgroupIdentityCodec.read(
                captured['delegation'],
            );
            const group: ExecutionCgroupIdentity | null =
                captured['group'] === null
                    ? null
                    : ExecutionCgroupIdentityCodec.read(captured['group']);
            if (
                group !== null &&
                (ExecutionCgroupIdentityCodec.same(delegation, group) ||
                    group.bootId !== delegation.bootId ||
                    group.device !== delegation.device ||
                    group.filesystemId !== delegation.filesystemId)
            ) {
                throw new Error('Original command group differs from its delegation');
            }
            return Object.freeze({
                ...(raw.kind === ConnectorEffectKind.CapturedInteractiveExecution
                    ? {
                          kind: ConnectorEffectKind.CapturedInteractiveExecution,
                          incarnation: ConnectorEnrollmentCodec.digest(captured['incarnation']),
                      }
                    : { kind: ConnectorEffectKind.CapturedExecution }),
                policySha256: ConnectorEnrollmentCodec.digest(captured['policySha256']),
                rootId: Boundary.id(captured['rootId']),
                root: WorkspaceIdentityCodec.identity(captured['root']),
                cgroupRoot,
                cgroupHelperFile: this.#path(captured['cgroupHelperFile']),
                cgroupHelperSha256: ConnectorEnrollmentCodec.digest(captured['cgroupHelperSha256']),
                delegation,
                group,
            });
        }
        const value: Readonly<Record<string, unknown>> = Boundary.record(raw, [
            'kind',
            'policySha256',
            'rootId',
            'root',
            'staging',
        ]);
        if (value['kind'] !== ConnectorEffectKind.CapturedFile) {
            throw new Error('Unsupported file effect provenance');
        }
        return Object.freeze({
            kind: ConnectorEffectKind.CapturedFile,
            policySha256: ConnectorEnrollmentCodec.digest(value['policySha256']),
            rootId: Boundary.id(value['rootId']),
            root: WorkspaceIdentityCodec.identity(value['root']),
            staging:
                value['staging'] === null
                    ? null
                    : WorkspaceIdentityCodec.identity(value['staging']),
        });
    }

    /** Only the closed native tuple is accepted from the private capture pipe. */
    public static native(raw: unknown): ConnectorNativeFileEffect {
        const value: Readonly<Record<string, unknown>> = Boundary.record(raw, ['root', 'staging']);
        return Object.freeze({
            root: WorkspaceIdentityCodec.identity(value['root']),
            staging:
                value['staging'] === null
                    ? null
                    : WorkspaceIdentityCodec.identity(value['staging']),
        });
    }

    /** One canonical private encoding is used for persistence and the bounded native context pipe. */
    public static encode(
        value: ConnectorEffectContext | ConnectorNativeFileEffect | ExecutionCgroupIdentity,
    ): string {
        return JSON.stringify(value, (_key: string, entry: unknown): unknown =>
            typeof entry === 'bigint' ? entry.toString() : entry,
        );
    }

    /** Equality concerns captured objects and exact policy/alias; it never follows a pathname. */
    public static same(
        first: ConnectorCapturedFileEffect,
        second: ConnectorCapturedFileEffect,
    ): boolean {
        return (
            first.policySha256 === second.policySha256 &&
            first.rootId === second.rootId &&
            WorkspaceIdentityCodec.same(first.root, second.root) &&
            (first.staging === null
                ? second.staging === null
                : second.staging !== null &&
                  WorkspaceIdentityCodec.same(first.staging, second.staging))
        );
    }

    static #path(raw: unknown): string {
        if (
            typeof raw !== 'string' ||
            !raw.isWellFormed() ||
            raw.length > 4096 ||
            !raw.startsWith('/') ||
            raw
                .split('/')
                .slice(1)
                .some(
                    (part: string): boolean =>
                        part === '' ||
                        part === '.' ||
                        part === '..' ||
                        /[\p{Cc}\p{Cf}]/u.test(part),
                )
        ) {
            throw new Error('Invalid original private resource locator');
        }
        return raw;
    }
}
