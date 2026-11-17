// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

import { basename } from 'node:path';
import { Boundary } from 'nerva-connector-protocol/protocol/Boundary.js';
import { ConnectorEnrollmentCodec } from 'nerva-connector-protocol/protocol/ConnectorEnrollmentCodec.js';
import type { ConnectorPrivateDirectory } from '../runtime/ConnectorPrivateDirectory.js';
import { ConnectorCapabilityState } from '../install/ConnectorCapabilityState.js';
import {
    JointWorkspaceConfiguration,
    type JointWorkspaceLocalConfiguration,
} from './JointWorkspaceConfiguration.js';

/** The private installation intent binds exact mapping order, public installation identity and both original source policies. */
export interface JointWorkspaceInstallationIntent {
    readonly identitySha256: string;
    readonly filePolicySha256: string;
    readonly executionPolicySha256: string;
    readonly configuration: JointWorkspaceLocalConfiguration;
    readonly intentSha256: string;
}

/** The existing protected operator-intent pattern never becomes cloud authority or a substitute for signed descriptors. */
export class JointWorkspaceInstallationState {
    public static readonly maximumBytes: number = 65536;

    public static create(
        identitySha256: string,
        filePolicySha256: string,
        executionPolicySha256: string,
        configuration: JointWorkspaceLocalConfiguration,
    ): JointWorkspaceInstallationIntent {
        const identity: string = ConnectorEnrollmentCodec.digest(identitySha256);
        const file: string = ConnectorEnrollmentCodec.digest(filePolicySha256);
        const execution: string = ConnectorEnrollmentCodec.digest(executionPolicySha256);
        const mapping: JointWorkspaceLocalConfiguration =
            JointWorkspaceConfiguration.value(configuration);
        return Object.freeze({
            identitySha256: identity,
            filePolicySha256: file,
            executionPolicySha256: execution,
            configuration: mapping,
            intentSha256: ConnectorCapabilityState.hash(
                JSON.stringify([
                    'nerva-connector:workspace-installation:1',
                    identity,
                    file,
                    execution,
                    mapping,
                ]),
            ),
        });
    }

    public static async read(
        owner: ConnectorPrivateDirectory,
        path: string,
    ): Promise<JointWorkspaceInstallationIntent | null> {
        const name: string = basename(path);
        if (!(await owner.exists(name))) {
            if (await owner.exists(name + '.partial')) {
                throw new Error('Workspace setup has retained partial intent; keep original state');
            }
            return null;
        }
        const bytes: Buffer = await owner.read(name, this.maximumBytes);
        try {
            const raw: unknown = JSON.parse(
                new TextDecoder('utf-8', { fatal: true }).decode(bytes),
            );
            const value: Readonly<Record<string, unknown>> = Boundary.record(raw, [
                'identitySha256',
                'filePolicySha256',
                'executionPolicySha256',
                'configuration',
                'intentSha256',
            ]);
            const record: JointWorkspaceInstallationIntent = this.create(
                ConnectorEnrollmentCodec.digest(value['identitySha256']),
                ConnectorEnrollmentCodec.digest(value['filePolicySha256']),
                ConnectorEnrollmentCodec.digest(value['executionPolicySha256']),
                JointWorkspaceConfiguration.value(value['configuration']),
            );
            if (record.intentSha256 !== value['intentSha256']) {
                throw new Error('Workspace setup intent commitment changed');
            }
            if (await owner.exists(name + '.partial')) {
                const partial: Buffer = await owner.read(name + '.partial', this.maximumBytes);
                try {
                    if (!partial.equals(bytes)) {
                        throw new Error('Workspace setup partial differs from its original intent');
                    }
                } finally {
                    partial.fill(0);
                }
                await owner.cleanPartial(name, this.maximumBytes);
            }
            return record;
        } finally {
            bytes.fill(0);
        }
    }

    public static async write(
        owner: ConnectorPrivateDirectory,
        path: string,
        intent: JointWorkspaceInstallationIntent,
    ): Promise<void> {
        const bytes: Buffer = Buffer.from(JSON.stringify(intent));
        try {
            await owner.write(basename(path), bytes, this.maximumBytes, true);
        } finally {
            bytes.fill(0);
        }
    }
}
