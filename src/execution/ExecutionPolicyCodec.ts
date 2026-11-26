// SPDX-FileCopyrightText: 2026 Dacely <business@dacely.com>
// SPDX-License-Identifier: LicenseRef-Proprietary

import { ExecutionInputCodec } from 'nerva-connector-protocol/execution/ExecutionInputCodec.js';
import { ExecutionPipePolicy } from './ExecutionPipePolicy.js';
import { resolve, posix } from 'node:path';
import { Boundary } from 'nerva-connector-protocol/protocol/Boundary.js';
import { ProtectedFiles } from '../local/ProtectedFiles.js';
import {
    ExecutionWorkspaceAccess,
    type ExecutionResourceLimits,
} from 'nerva-connector-protocol/execution/ExecutionTypes.js';
import {
    type ExecutionArgumentRule,
    type ExecutionBinaryPolicy,
    type ExecutionProgramPolicy,
    type ExecutionRootPolicy,
    type ExecutionPolicyDefinition,
} from 'nerva-connector-protocol/execution/ExecutionPolicyTypes.js';

/** Unknown local policy and remote invocation data are narrowed before handles, arguments or limits are used. */
export class ExecutionPolicyCodec {
    /** Every field is explicit; missing or unsupported policies never become ambient execution. */
    public static policy(raw: unknown): ExecutionPolicyDefinition {
        const value: Readonly<Record<string, unknown>> = Boundary.record(raw, [
            'revision',
            'installationId',
            'trampolineFile',
            'trampolineSha256',
            'bubblewrapFile',
            'bubblewrapSha256',
            'runtimeDirectory',
            'cgroupRoot',
            'roots',
            'programs',
            'resources',
            'timeoutMs',
            'maximumAddressBytes',
            'maximumFileBytes',
        ]);
        const revision: bigint = Boundary.integer(value['revision']);
        const installationId: unknown = value['installationId'];
        if (typeof installationId !== 'string' || !/^[a-f0-9]{32}$/u.test(installationId)) {
            throw new Error('Permanent execution installation identity required');
        }
        const roots: readonly ExecutionRootPolicy[] = Boundary.array(value['roots'], 16).map(
            (rawRoot: unknown): ExecutionRootPolicy => {
                const root: Readonly<Record<string, unknown>> = Boundary.record(rawRoot, [
                    'id',
                    'path',
                    'access',
                ]);
                const access: ExecutionWorkspaceAccess | undefined = Object.values(
                    ExecutionWorkspaceAccess,
                ).find((mode: ExecutionWorkspaceAccess): boolean => mode === root['access']);
                if (access === undefined) {
                    throw new Error('Explicit execution root mode required');
                }
                return { id: Boundary.id(root['id']), path: this.#path(root['path']), access };
            },
        );
        const programs: readonly ExecutionProgramPolicy[] = Boundary.array(
            value['programs'],
            16,
        ).map((rawProgram: unknown): ExecutionProgramPolicy => {
            const program: Readonly<Record<string, unknown>> = Boundary.record(rawProgram, [
                'id',
                'path',
                'sha256',
                'arguments',
                'children',
                'rootIds',
            ]);
            const children: readonly ExecutionBinaryPolicy[] = Boundary.array(
                program['children'],
                8,
            ).map((child: unknown): ExecutionBinaryPolicy => {
                const binary: Readonly<Record<string, unknown>> = Boundary.record(child, [
                    'path',
                    'sha256',
                ]);
                return this.#binary(binary);
            });
            return {
                id: Boundary.id(program['id']),
                rootIds: Boundary.ids(program['rootIds'], 16),
                ...this.#binary(program),
                arguments: Boundary.array(program['arguments'], 32).map(
                    (rule: unknown): ExecutionArgumentRule =>
                        ExecutionInputCodec.argumentRule(rule),
                ),
                children,
            };
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
        const maximumAddressBytes: bigint = Boundary.integer(value['maximumAddressBytes']);
        const maximumFileBytes: bigint = Boundary.integer(value['maximumFileBytes']);
        const timeoutMs: number = Boundary.count(value['timeoutMs'], 30000);
        for (const program of programs) {
            ExecutionPipePolicy.program(program, timeoutMs);
        }
        if (
            revision === 0n ||
            roots.length === 0 ||
            programs.length === 0 ||
            programs.some(
                (program: ExecutionProgramPolicy): boolean =>
                    program.rootIds.length === 0 ||
                    program.rootIds.some(
                        (id: string): boolean =>
                            !roots.some((root: ExecutionRootPolicy): boolean => root.id === id),
                    ),
            ) ||
            new Set(roots.map((root: ExecutionRootPolicy): string => root.id)).size !==
                roots.length ||
            new Set(programs.map((program: ExecutionProgramPolicy): string => program.id)).size !==
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
            throw new Error('Invalid execution resource or capability policy');
        }
        return {
            installationId,
            revision,
            trampolineFile: this.#path(value['trampolineFile']),
            trampolineSha256: ExecutionInputCodec.digest(value['trampolineSha256']),
            bubblewrapFile: this.#path(value['bubblewrapFile']),
            bubblewrapSha256: ExecutionInputCodec.digest(value['bubblewrapSha256']),
            runtimeDirectory: this.#path(value['runtimeDirectory']),
            cgroupRoot: this.#path(value['cgroupRoot']),
            roots,
            programs,
            resources,
            timeoutMs,
            maximumAddressBytes,
            maximumFileBytes,
        };
    }

    static #path(raw: unknown): string {
        const path: string = ProtectedFiles.path(raw);
        if (resolve(path) !== path || path.endsWith('/')) {
            throw new Error('Canonical explicit execution reference required');
        }
        return path;
    }
    static #binary(value: Readonly<Record<string, unknown>>): ExecutionBinaryPolicy {
        const path: string = this.#path(value['path']);
        if (
            (!path.startsWith('/usr/') && !path.startsWith('/opt/')) ||
            posix.normalize(path) !== path
        ) {
            throw new Error('Explicit runtime ELF path required');
        }
        return { path, sha256: ExecutionInputCodec.digest(value['sha256']) };
    }
}
