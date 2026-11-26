// SPDX-FileCopyrightText: 2026 Dacely <business@dacely.com>
// SPDX-License-Identifier: LicenseRef-Proprietary

import { dirname } from 'node:path';
import { ConnectorHistoryMigration } from './ConnectorHistoryMigration.js';
import {
    ConnectorClientConfiguration,
    type ConnectorClientIdentity,
} from './ConnectorClientConfiguration.js';
import {
    ConnectorPrivateDirectory,
    ConnectorDirectoryPurpose,
} from './ConnectorPrivateDirectory.js';
import {
    ConnectorFileHistoryPreparation,
    type ConnectorFileHistoryPreparationReport,
} from './ConnectorFileHistoryPreparation.js';
import {
    ExecutionHistoryPreparation,
    type ExecutionHistoryPreparationReport,
} from '../execution/ExecutionHistoryPreparation.js';

/** A local stopped-runtime check cannot observe queued server work or authorize activation of changed policies. */
export interface ConnectorPolicyPreparationReport {
    readonly localReady: boolean;
    readonly remoteStateVerified: false;
    readonly files: ConnectorFileHistoryPreparationReport;
    readonly execution: ExecutionHistoryPreparationReport;
}

/** The operator sees only fixed copy, never raw filesystem errors or private retained command data. */
export class ConnectorPolicyPreparationError extends Error {
    /** Completed cleanup remains durable even when a later step cannot finish. */
    public constructor(canceled: boolean = false) {
        super(
            canceled
                ? 'Local preparation canceled; original history and completed recovery were retained'
                : 'Local preparation unavailable; stop the connector and keep its original configuration and journals',
        );
        this.name = 'ConnectorPolicyPreparationError';
    }
}

/** Exclusive runtime/pairing ownership prevents ordinary startup or re-enrollment while retained work is prepared. */
export class ConnectorPolicyPreparation {
    /** Existing-only preparation never contacts the backend, grants access, resets state or acknowledges originals. */
    public static async prepare(
        path: string,
        signal: AbortSignal,
    ): Promise<ConnectorPolicyPreparationReport> {
        try {
            signal.throwIfAborted();
            if (process.platform !== 'linux') {
                throw new ConnectorPolicyPreparationError();
            }
            const identity: ConnectorClientIdentity = await ConnectorClientConfiguration.load(path);
            await using resources: AsyncDisposableStack = new AsyncDisposableStack();
            resources.use(identity.key);
            const directory: string = dirname(identity.settings.privateKeyFile);
            for (const purpose of [
                ConnectorDirectoryPurpose.Runtime,
                ConnectorDirectoryPurpose.Pairing,
            ]) {
                resources.use(await ConnectorPrivateDirectory.open(directory, purpose));
            }
            const current: ConnectorClientIdentity = await ConnectorClientConfiguration.load(path);
            resources.use(current.key);
            if (
                current.publicKey !== identity.publicKey ||
                current.authority.publicKey !== identity.authority.publicKey ||
                JSON.stringify(current.settings) !== JSON.stringify(identity.settings)
            ) {
                throw new ConnectorPolicyPreparationError();
            }
            signal.throwIfAborted();
            await ConnectorHistoryMigration.requireComplete(identity);
            const files: ConnectorFileHistoryPreparationReport =
                await ConnectorFileHistoryPreparation.prepare(identity, signal);
            signal.throwIfAborted();
            const execution: ExecutionHistoryPreparationReport =
                await ExecutionHistoryPreparation.prepare(identity, signal);
            signal.throwIfAborted();
            return {
                localReady: files.ready && execution.ready,
                remoteStateVerified: false,
                files,
                execution,
            };
        } catch {
            throw new ConnectorPolicyPreparationError(signal.aborted);
        }
    }
}
