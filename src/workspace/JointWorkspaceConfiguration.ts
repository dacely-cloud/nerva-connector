// SPDX-FileCopyrightText: 2026 Dacely <business@dacely.com>
// SPDX-License-Identifier: LicenseRef-Proprietary

import { dirname, join, resolve } from 'node:path';
import { ProtectedFiles } from '../local/ProtectedFiles.js';
import { Boundary } from 'nerva-connector-protocol/protocol/Boundary.js';
import { JointWorkspaceJournalLimits } from './JointWorkspaceJournalTypes.js';

/** A local explicit mapping names two already-granted aliases, never arbitrary host paths or inferred capabilities. */
export interface JointWorkspaceRootMapping {
    readonly fileRootId: string;
    readonly executionRootId: string;
}

/** This opt-in shape is independent of device pairing and release configuration. */
export interface JointWorkspaceLocalConfiguration {
    readonly roots: readonly JointWorkspaceRootMapping[];
}

/** Fixed protected references remain excluded from both capability roots even before installation. */
export interface JointWorkspaceConfigurationPaths {
    readonly configurationFile: string;
    readonly stateDirectory: string;
    readonly setupFile: string;
}

/** Missing optional configuration means uninstalled; malformed or changed existing state never becomes a fallback grant. */
export class JointWorkspaceConfiguration {
    public static readonly maximumBytes: number = 65536;

    public static paths(privateKeyFile: string): JointWorkspaceConfigurationPaths {
        const path: string = ProtectedFiles.path(privateKeyFile);
        if (resolve(path) !== path) {
            throw new Error('Canonical joint workspace identity path required');
        }
        const directory: string = dirname(path);
        return Object.freeze({
            configurationFile: join(directory, 'workspace-bindings.json'),
            stateDirectory: join(directory, 'workspace-bindings'),
            setupFile: join(directory, 'workspace-bindings-setup.json'),
        });
    }

    /** Only absence of the fixed optional file is accepted; permission, corruption and ancestor failures propagate. */
    public static async read(
        privateKeyFile: string,
    ): Promise<JointWorkspaceLocalConfiguration | null> {
        try {
            return await this.request(this.paths(privateKeyFile).configurationFile);
        } catch (caught: unknown) {
            if (caught instanceof Error && 'code' in caught && caught.code === 'ENOENT') {
                return null;
            }
            throw caught;
        }
    }

    /** The explicit operator request must already be a protected regular file; it cannot select installation destinations. */
    public static async request(path: string): Promise<JointWorkspaceLocalConfiguration> {
        const bytes: Buffer = await ProtectedFiles.readPrivate(
            ProtectedFiles.path(path),
            this.maximumBytes,
        );
        try {
            const raw: unknown = JSON.parse(
                new TextDecoder('utf-8', { fatal: true }).decode(bytes),
            );
            return this.value(raw);
        } finally {
            bytes.fill(0);
        }
    }

    public static value(raw: unknown): JointWorkspaceLocalConfiguration {
        const record: Readonly<Record<string, unknown>> = Boundary.record(raw, ['roots']);
        const seen: Set<string> = new Set();
        const roots: readonly JointWorkspaceRootMapping[] = Object.freeze(
            Boundary.array(record['roots'], JointWorkspaceJournalLimits.pairs).map(
                (rawRoot: unknown): JointWorkspaceRootMapping => {
                    const root: Readonly<Record<string, unknown>> = Boundary.record(rawRoot, [
                        'fileRootId',
                        'executionRootId',
                    ]);
                    const pair: JointWorkspaceRootMapping = Object.freeze({
                        fileRootId: Boundary.id(root['fileRootId']),
                        executionRootId: Boundary.id(root['executionRootId']),
                    });
                    const identity: string = JSON.stringify([
                        pair.fileRootId,
                        pair.executionRootId,
                    ]);
                    if (seen.has(identity)) {
                        throw new Error('Joint workspace root mappings must be unique');
                    }
                    seen.add(identity);
                    return pair;
                },
            ),
        );
        if (roots.length === 0) {
            throw new Error('At least one explicit joint workspace root mapping required');
        }
        return Object.freeze({ roots });
    }

    /** Validate and detach the whole explicit mapping before creating its bounded fixed representation. */
    public static encode(value: JointWorkspaceLocalConfiguration): string {
        return JSON.stringify(this.value(value));
    }
}
