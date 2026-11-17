// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

import { Boundary } from 'nerva-connector-protocol/protocol/Boundary.js';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { ConnectorFileMode } from 'nerva-connector-protocol/protocol/ConnectorFiles.js';
import { ConnectorEnrollmentCodec } from 'nerva-connector-protocol/protocol/ConnectorEnrollmentCodec.js';
import { ProtectedFiles } from '../local/ProtectedFiles.js';
import type { ConnectorLocalCapabilitySettings } from './ConnectorClientSettings.js';
import { ConnectorFileRoots, type ConnectorFileRootPolicy } from './ConnectorFileRoots.js';

/** Local policy references remain private and retain the existing exact policy commitment inputs. */
export interface ConnectorFilePolicyDefinition {
    readonly mode: ConnectorFileMode;
    readonly revision: bigint;
    readonly helperFile: string;
    readonly helperSha256: string;
    readonly roots: readonly ConnectorFileRootPolicy[];
}

/** File loading and cross-policy protection share one strict parser without opening grants or journals. */
export class ConnectorFilePolicy {
    /** Read only the bounded current contract; no missing field becomes implied access. */
    public static async load(path: string): Promise<ConnectorFilePolicyDefinition> {
        const bytes: Buffer = await ProtectedFiles.readPrivate(path, 131072);
        try {
            const raw: unknown = JSON.parse(
                new TextDecoder('utf-8', { fatal: true }).decode(bytes),
            );
            return this.parse(raw);
        } finally {
            bytes.fill(0);
        }
    }

    /** Installer intent validation uses the same parser against its retained exact source bytes. */
    public static parse(raw: unknown): ConnectorFilePolicyDefinition {
        const value: Readonly<Record<string, unknown>> = Boundary.record(raw, [
            'mode',
            'revision',
            'helperFile',
            'helperSha256',
            'roots',
        ]);
        const revision: bigint = Boundary.integer(value['revision']);
        const mode: ConnectorFileMode | undefined = Object.values(ConnectorFileMode).find(
            (entry: ConnectorFileMode): boolean => entry === value['mode'],
        );
        if (mode === undefined || revision === 0n) {
            throw new Error('Explicit supported connector policy required');
        }
        const helperFile: string = ProtectedFiles.path(value['helperFile']);
        if (resolve(helperFile) !== helperFile) {
            throw new Error('Canonical private connector references required');
        }
        return {
            mode,
            revision,
            helperFile,
            helperSha256: ConnectorEnrollmentCodec.digest(value['helperSha256']),
            roots: ConnectorFileRoots.parse(value['roots'], mode),
        };
    }

    /** The exact existing ordered tuple remains stable for published grants and retained original requests. */
    public static commitment(policy: ConnectorFilePolicyDefinition): string {
        return createHash('sha256')
            .update(
                JSON.stringify([
                    policy.mode,
                    policy.revision.toString(),
                    policy.helperFile,
                    policy.helperSha256,
                    policy.roots.map(
                        (root: ConnectorFileRootPolicy): readonly (string | null)[] => [
                            root.id,
                            root.path,
                            root.stagingPath,
                        ],
                    ),
                ]),
            )
            .digest('hex');
    }

    /** Command grants may not modify native file code, encrypted history or any private upload staging root. */
    public static async protectedPaths(
        settings: ConnectorLocalCapabilitySettings,
    ): Promise<readonly string[]> {
        const policy: ConnectorFilePolicyDefinition = await this.load(settings.policyFile);
        return this.privatePaths(policy, settings);
    }

    /** Pure projection keeps preflight and runtime exclusions identical without rereading an installation intent. */
    public static privatePaths(
        policy: ConnectorFilePolicyDefinition,
        settings: ConnectorLocalCapabilitySettings,
    ): readonly string[] {
        for (const path of [settings.policyFile, settings.stateDirectory]) {
            if (resolve(ProtectedFiles.path(path)) !== path) {
                throw new Error('Canonical private connector references required');
            }
        }
        return [
            settings.policyFile,
            ProtectedFiles.path(settings.stateDirectory),
            policy.helperFile,
            ...policy.roots.flatMap((root: ConnectorFileRootPolicy): string[] =>
                root.stagingPath === null ? [] : [root.stagingPath],
            ),
        ];
    }
}
