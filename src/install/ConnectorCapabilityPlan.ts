// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { Boundary } from 'nerva-connector-protocol/protocol/Boundary.js';
import { ProtectedFiles } from '../local/ProtectedFiles.js';
import { ConnectorFilesystem } from '../runtime/ConnectorFilesystem.js';
import { ExecutionPolicy } from '../execution/ExecutionPolicy.js';
import { ExecutionPolicyCodec } from '../execution/ExecutionPolicyCodec.js';
import type { ExecutionPolicyDefinition } from 'nerva-connector-protocol/execution/ExecutionPolicyTypes.js';
import { ConnectorReleaseFile } from './ConnectorRelease.js';
import type { ConnectorInstallationView } from './ConnectorInstallation.js';
import {
    ConnectorFilePolicy,
    type ConnectorFilePolicyDefinition,
} from '../runtime/ConnectorFilePolicy.js';

/** Local administrators approve policies; a release or remote request cannot grant filesystem or program access. */
export interface ConnectorCapabilityRequest {
    readonly installationDirectory: string;
    readonly filesPolicyFile: string | null;
    readonly executionPolicyFile: string | null;
}
/** Bounded original policy bytes are retained unchanged so retries cannot broaden a grant. */
export interface ConnectorCapabilityPolicy {
    readonly bytes: Buffer;
    readonly execution: ExecutionPolicyDefinition | null;
}
/** A stopped installation can activate independent file and program profiles under its original device identity. */
export interface ConnectorCapabilityPlan {
    readonly request: ConnectorCapabilityRequest;
    readonly files: ConnectorCapabilityPolicy | null;
    readonly execution: ConnectorCapabilityPolicy | null;
}

/** Preflight opens the same native policy boundary as production without installing profiles, starting commands or resetting history. */
export class ConnectorCapabilityPlans {
    /** All paths are protected and canonical before installation is inspected or mutated. */
    public static async request(path: string): Promise<ConnectorCapabilityRequest> {
        const raw: unknown = JSON.parse(
            new TextDecoder('utf-8', { fatal: true }).decode(
                await ProtectedFiles.readPrivate(path, 16384),
            ),
        );
        const value: Readonly<Record<string, unknown>> = Boundary.record(raw, [
            'installationDirectory',
            'filesPolicyFile',
            'executionPolicyFile',
        ]);
        const request: ConnectorCapabilityRequest = {
            installationDirectory: this.#path(value['installationDirectory']),
            filesPolicyFile:
                value['filesPolicyFile'] === null ? null : this.#path(value['filesPolicyFile']),
            executionPolicyFile:
                value['executionPolicyFile'] === null
                    ? null
                    : this.#path(value['executionPolicyFile']),
        };
        if (request.filesPolicyFile === null && request.executionPolicyFile === null) {
            throw new Error('At least one explicit local capability policy is required');
        }
        return request;
    }
    /** Signed helper bytes, actual directory roots and execution confinement inputs must agree before any durable setup intent. */
    public static async read(
        path: string,
        request: ConnectorCapabilityRequest,
        installed: ConnectorInstallationView,
    ): Promise<ConnectorCapabilityPlan> {
        await using resources: AsyncDisposableStack = new AsyncDisposableStack();
        const protectedPaths: string[] = [installed.directory, path];
        for (const source of [request.filesPolicyFile, request.executionPolicyFile]) {
            if (source !== null) {
                protectedPaths.push(source);
            }
        }
        let files: ConnectorCapabilityPolicy | null = null;
        let fileDefinition: ConnectorFilePolicyDefinition | null = null;
        let executionProtectedPaths: readonly string[] = protectedPaths;
        if (request.filesPolicyFile !== null) {
            const bytes: Buffer = await ProtectedFiles.readPrivate(request.filesPolicyFile, 131072);
            const raw: unknown = JSON.parse(
                new TextDecoder('utf-8', { fatal: true }).decode(bytes),
            );
            fileDefinition = ConnectorFilePolicy.parse(raw);
            this.#helper(
                installed,
                ConnectorReleaseFile.Files,
                fileDefinition.helperFile,
                fileDefinition.helperSha256,
            );
            executionProtectedPaths = [
                ...protectedPaths,
                ...ConnectorFilePolicy.privatePaths(fileDefinition, {
                    policyFile: request.filesPolicyFile,
                    stateDirectory: join(installed.directory, 'capabilities', 'files'),
                }),
            ];
            files = { bytes, execution: null };
        }
        let execution: ConnectorCapabilityPolicy | null = null;
        if (request.executionPolicyFile !== null) {
            const bytes: Buffer = await ProtectedFiles.readPrivate(
                request.executionPolicyFile,
                65536,
            );
            const definition: ExecutionPolicyDefinition = ExecutionPolicyCodec.policy(
                JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)),
            );
            this.#helper(
                installed,
                ConnectorReleaseFile.Execution,
                definition.trampolineFile,
                definition.trampolineSha256,
            );
            const owner: ExecutionPolicy = resources.use(
                await ExecutionPolicy.load(request.executionPolicyFile, executionProtectedPaths),
            );
            if (owner.policySha256 !== createHash('sha256').update(bytes).digest('hex')) {
                throw new Error('Execution policy changed during capability preflight');
            }
            protectedPaths.push(
                definition.runtimeDirectory,
                definition.cgroupRoot,
                definition.bubblewrapFile,
            );
            execution = { bytes, execution: definition };
        }
        if (request.filesPolicyFile !== null && fileDefinition !== null) {
            const owner: ConnectorFilesystem = resources.use(
                await ConnectorFilesystem.load(request.filesPolicyFile, protectedPaths),
            );
            if (owner.profile.policySha256 !== ConnectorFilePolicy.commitment(fileDefinition)) {
                throw new Error('File policy changed during capability preflight');
            }
        }
        return { request, files, execution };
    }
    static #helper(
        installed: ConnectorInstallationView,
        name: ConnectorReleaseFile,
        path: string,
        digest: string,
    ): void {
        const expected: string | undefined = installed.release.manifest.artifacts.find(
            (entry): boolean => entry.name === name,
        )?.sha256;
        if (
            expected === undefined ||
            path !== join(installed.directory, name) ||
            digest !== expected
        ) {
            throw new Error(
                'Capability policy must use the original signed installed native helper',
            );
        }
    }
    static #path(raw: unknown): string {
        const path: string = ProtectedFiles.path(raw);
        if (resolve(path) !== path) {
            throw new Error('Canonical local capability references required');
        }
        return path;
    }
}
