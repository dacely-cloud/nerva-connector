// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

import { ConnectorJournalLimits } from './ConnectorJournalLimits.js';
import { join } from 'node:path';
import { ProtectedFiles } from '../local/ProtectedFiles.js';
import {
    ConnectorClientConfiguration,
    type ConnectorClientIdentity,
} from './ConnectorClientConfiguration.js';
import type { ConnectorPairIdentity } from './ConnectorPairConfiguration.js';
import type { ConnectorPairState } from './ConnectorPairState.js';
import type { ConnectorDeviceIdentity } from './ConnectorDeviceKey.js';
import { ExecutionLane } from 'nerva-connector-protocol/execution/ExecutionLane.js';

/** Completed pairing validates account/deployment identity while retaining subsequent explicitly installed local grants. */
export class ConnectorPairedRuntime {
    /** Pairing is not a policy editor or journal reset; an active capability owner is never opened or replaced here. */
    public static async verify(
        state: ConnectorPairState,
        pairing: ConnectorPairIdentity,
        device: ConnectorDeviceIdentity,
        keyFile: string,
    ): Promise<void> {
        const runtime: ConnectorClientIdentity = await ConnectorClientConfiguration.load(
            state.directory.file('device.json'),
        );
        using owner: DisposableStack = new DisposableStack();
        owner.use(runtime.key);
        if (
            runtime.publicKey !== device.publicKey ||
            runtime.settings.privateKeyFile !== keyFile ||
            runtime.settings.environmentId !== state.snapshot.environmentId ||
            runtime.settings.enrollmentId !== state.snapshot.enrollmentId ||
            runtime.settings.slot !== 0 ||
            runtime.settings.authorityId !== pairing.settings.authorityId ||
            runtime.settings.authorityPublicKeyFile !== pairing.settings.authorityPublicKeyFile ||
            runtime.authority.publicKey !== pairing.authority.publicKey ||
            runtime.settings.serverCaFile !== pairing.settings.serverCaFile ||
            !(runtime.ca ?? Buffer.alloc(0)).equals(pairing.ca ?? Buffer.alloc(0)) ||
            JSON.stringify(runtime.settings.endpoints) !==
                JSON.stringify(pairing.settings.endpoints)
        ) {
            throw new Error('Paired runtime account or deployment identity changed');
        }
        const paths: string[] = [];
        if (runtime.settings.files !== null) {
            paths.push(join(runtime.settings.files.stateDirectory, 'file-journal'));
        }
        if (runtime.settings.execution !== null) {
            for (const lane of Object.values(ExecutionLane)) {
                paths.push(
                    join(runtime.settings.execution.stateDirectory, lane, 'execution-journal'),
                );
            }
        }
        for (const path of paths) {
            const bytes: Buffer = await ProtectedFiles.readPrivate(
                path,
                ConnectorJournalLimits.recordBytes,
            );
            bytes.fill(0);
        }
    }
}
