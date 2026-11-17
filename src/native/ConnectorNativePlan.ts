// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

import { dirname, join, posix, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { Boundary } from 'nerva-connector-protocol/protocol/Boundary.js';
import { ProtectedFiles } from '../local/ProtectedFiles.js';
import { ConnectorServiceUnit } from '../service/ConnectorServiceUnit.js';
import { ConnectorServiceScope } from '../service/ConnectorServiceTypes.js';
import { ExecutionPolicyCodec } from '../execution/ExecutionPolicyCodec.js';
import type { ExecutionPolicyDefinition } from '../execution/ExecutionPolicyTypes.js';
import { ConnectorFileMode } from 'nerva-connector-protocol/protocol/ConnectorFiles.js';
import { ConnectorEnrollmentCodec } from 'nerva-connector-protocol/protocol/ConnectorEnrollmentCodec.js';
import { IdentityCodec } from 'nerva-connector-protocol/identity/IdentityCodec.js';
import {
    ConnectorRuntimeFileMode,
    ConnectorNativePhase,
    type ConnectorRuntimeFile,
    type ConnectorNativeRequest,
    type ConnectorNativeExecutionGrant,
    type ConnectorNativeFileGrant,
    type ConnectorNativeFileRoot,
    type ConnectorNativePlan,
    type ConnectorNativeLayout,
} from './ConnectorNativeTypes.js';

/** One canonical private native plan supplies all boot paths; model requests never choose host resources. */
export class ConnectorNativePlans {
    /** Only the current root-owned system-service layout can own automatic native execution. */
    public static layout(directory: string): ConnectorNativeLayout {
        const root: string = this.path(directory);
        const identity: string = createHash('sha256').update(root).digest('hex');
        const unitName: string = ConnectorServiceUnit.layout(
            root,
            ConnectorServiceScope.System,
        ).unitName;
        const cgroupDirectory: string = '/sys/fs/cgroup/system.slice/' + unitName;
        return {
            installationDirectory: root,
            directory: join(root, 'native'),
            runtimeDirectory: join(root, 'native/runtime'),
            unitName,
            cgroupDirectory,
            jobsDirectory: join(cgroupDirectory, 'jobs'),
            identity,
        };
    }
    /** Input quantities are exact and runtime files are a finite approved set, never an archive or recursive host copy. */
    public static request(raw: unknown): ConnectorNativeRequest {
        const value: Readonly<Record<string, unknown>> = Boundary.record(raw, [
            'installationDirectory',
            'sourceDirectory',
            'runtimeFiles',
            'files',
            'execution',
        ]);
        const layout: ConnectorNativeLayout = this.layout(
            this.path(value['installationDirectory']),
        );
        const files: readonly ConnectorRuntimeFile[] = Boundary.array(
            value['runtimeFiles'],
            256,
        ).map((entry: unknown): ConnectorRuntimeFile => {
            const record: Readonly<Record<string, unknown>> = Boundary.record(entry, [
                'path',
                'sizeBytes',
                'sha256',
                'mode',
            ]);
            const path: string = this.path(record['path']);
            const mode: ConnectorRuntimeFileMode | undefined = Object.values(
                ConnectorRuntimeFileMode,
            ).find((entry): boolean => entry === record['mode']);
            const sizeBytes: bigint = Boundary.integer(record['sizeBytes']);
            if (
                !/^\/(?:usr|opt|lib|lib64|etc)\/.+/u.test(path) ||
                path.split('/').length > 33 ||
                path.split('/').some((part): boolean => Buffer.byteLength(part) > 255) ||
                mode === undefined ||
                sizeBytes < 1n ||
                sizeBytes > 268435456n
            ) {
                throw new Error('Invalid approved runtime file');
            }
            return {
                path,
                mode,
                sizeBytes,
                sha256: ConnectorEnrollmentCodec.digest(record['sha256']),
            };
        });
        const paths: readonly string[] = files.map((entry): string => entry.path).sort();
        if (
            files.length === 0 ||
            new Set(paths).size !== paths.length ||
            paths.some(
                (path, index): boolean => paths[index + 1]?.startsWith(path + '/') ?? false,
            ) ||
            files.reduce((sum: bigint, entry): bigint => sum + entry.sizeBytes, 0n) > 1073741824n
        ) {
            throw new Error('Runtime file set exceeds its independent bounds');
        }
        const fields: Readonly<Record<string, unknown>> = Boundary.record(value['execution'], [
            'revision',
            'roots',
            'programs',
            'resources',
            'timeoutMs',
            'maximumAddressBytes',
            'maximumFileBytes',
        ]);
        const execution: ExecutionPolicyDefinition = ExecutionPolicyCodec.policy({
            ...fields,
            installationId: layout.identity.slice(0, 32),
            trampolineFile: join(layout.installationDirectory, 'nerva-connector-exec'),
            trampolineSha256: '0'.repeat(64),
            bubblewrapFile: '/usr/bin/bwrap',
            bubblewrapSha256: '0'.repeat(64),
            runtimeDirectory: layout.runtimeDirectory,
            cgroupRoot: layout.jobsDirectory,
        });
        for (const program of execution.programs) {
            for (const binary of [program, ...program.children]) {
                if (
                    !files.some(
                        (file): boolean =>
                            file.path === binary.path &&
                            file.sha256 === binary.sha256 &&
                            file.mode === ConnectorRuntimeFileMode.Executable,
                    )
                ) {
                    throw new Error(
                        'An approved program is missing from the exact runtime manifest',
                    );
                }
            }
        }
        return {
            installationDirectory: layout.installationDirectory,
            sourceDirectory: this.path(value['sourceDirectory']),
            runtimeFiles: files,
            files: value['files'] === null ? null : this.#files(value['files']),
            execution: this.#grant(execution),
        };
    }
    /** Exact stored shape is validated again on every service boot before restoring any kernel state. */
    public static plan(raw: unknown): ConnectorNativePlan {
        const value: Readonly<Record<string, unknown>> = Boundary.record(raw, [
            'request',
            'releaseSha256',
            'devicePublicKey',
            'enrollmentId',
            'environmentId',
            'phase',
            'bubblewrapSha256',
        ]);
        const phase: ConnectorNativePhase | undefined = Object.values(ConnectorNativePhase).find(
            (entry): boolean => entry === value['phase'],
        );
        if (phase === undefined) {
            throw new Error('Unknown native setup phase');
        }
        return {
            request: this.request(value['request']),
            phase,
            releaseSha256: ConnectorEnrollmentCodec.digest(value['releaseSha256']),
            devicePublicKey: IdentityCodec.publicKey(value['devicePublicKey']).toString(
                'base64url',
            ),
            enrollmentId: ConnectorEnrollmentCodec.id(value['enrollmentId']),
            environmentId: Boundary.id(value['environmentId']),
            bubblewrapSha256: ConnectorEnrollmentCodec.digest(value['bubblewrapSha256']),
        };
    }
    /** The helper, runtime, delegation and system binary are derived/pinned locally rather than copied from model input. */
    public static execution(
        request: ConnectorNativeRequest,
        bubblewrapSha256: string,
        helperSha256: string,
    ): ExecutionPolicyDefinition {
        const layout: ConnectorNativeLayout = this.layout(request.installationDirectory);
        return {
            ...request.execution,
            installationId: layout.identity.slice(0, 32),
            trampolineFile: join(layout.installationDirectory, 'nerva-connector-exec'),
            trampolineSha256: helperSha256,
            bubblewrapFile: '/usr/bin/bwrap',
            bubblewrapSha256,
            runtimeDirectory: layout.runtimeDirectory,
            cgroupRoot: layout.jobsDirectory,
        };
    }
    /** Writable staging stays outside its workspace and is unique to the original installation/root alias. */
    public static staging(layout: ConnectorNativeLayout, root: ConnectorNativeFileRoot): string {
        return join(
            dirname(root.path),
            '.nerva-connector-' + layout.identity.slice(0, 32) + '-' + root.id + '-staging',
        );
    }
    /** Canonical serialization persists exact integers without truncation or additional credential copies. */
    public static encode(
        value: ConnectorNativePlan | ConnectorNativeRequest | ExecutionPolicyDefinition,
    ): Buffer {
        const canonical: ConnectorNativePlan | ConnectorNativeRequest | ExecutionPolicyDefinition =
            'request' in value
                ? {
                      request: value.request,
                      releaseSha256: value.releaseSha256,
                      devicePublicKey: value.devicePublicKey,
                      enrollmentId: value.enrollmentId,
                      environmentId: value.environmentId,
                      phase: value.phase,
                      bubblewrapSha256: value.bubblewrapSha256,
                  }
                : value;
        return Buffer.from(
            JSON.stringify(canonical, (_key: string, entry: unknown): unknown =>
                typeof entry === 'bigint' ? entry.toString() : entry,
            ),
        );
    }
    /** Invalid Unicode and noncanonical pathname aliases are rejected before filesystem mutation. */
    public static path(raw: unknown): string {
        const path: string = ProtectedFiles.path(raw);
        if (posix.normalize(path) !== path || resolve(path) !== path || path.endsWith('/')) {
            throw new Error('Canonical native paths required');
        }
        return path;
    }
    static #files(raw: unknown): ConnectorNativeFileGrant {
        const value: Readonly<Record<string, unknown>> = Boundary.record(raw, [
            'mode',
            'revision',
            'roots',
        ]);
        const mode: ConnectorFileMode | undefined = Object.values(ConnectorFileMode).find(
            (entry): boolean => entry === value['mode'],
        );
        const revision: bigint = Boundary.integer(value['revision']);
        const roots: readonly ConnectorNativeFileRoot[] = Boundary.array(value['roots'], 16).map(
            (entry: unknown): ConnectorNativeFileRoot => {
                const root: Readonly<Record<string, unknown>> = Boundary.record(entry, [
                    'id',
                    'path',
                ]);
                return { id: Boundary.id(root['id']), path: this.path(root['path']) };
            },
        );
        if (
            mode === undefined ||
            revision === 0n ||
            roots.length === 0 ||
            new Set(roots.map((entry): string => entry.id)).size !== roots.length ||
            new Set(roots.map((entry): string => entry.path)).size !== roots.length
        ) {
            throw new Error('Explicit unique native file grants required');
        }
        return { mode, revision, roots };
    }
    static #grant(policy: ExecutionPolicyDefinition): ConnectorNativeExecutionGrant {
        return {
            revision: policy.revision,
            roots: policy.roots,
            programs: policy.programs,
            resources: policy.resources,
            timeoutMs: policy.timeoutMs,
            maximumAddressBytes: policy.maximumAddressBytes,
            maximumFileBytes: policy.maximumFileBytes,
        };
    }
}
