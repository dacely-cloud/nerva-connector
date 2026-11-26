// SPDX-FileCopyrightText: 2026 Dacely <business@dacely.com>
// SPDX-License-Identifier: LicenseRef-Proprietary

import { mkdir, rmdir } from 'node:fs/promises';
import type { ConnectorClientIdentity } from '../runtime/ConnectorClientConfiguration.js';
import {
    ConnectorPrivateDirectory,
    ConnectorDirectoryPurpose,
} from '../runtime/ConnectorPrivateDirectory.js';
import { ConnectorOperationJournal } from '../runtime/ConnectorOperationJournal.js';
import { ExecutionJournalCodec } from './ExecutionJournalCodec.js';
import { ExecutionConfiguration } from './ExecutionConfiguration.js';
import type { ExecutionClientSettings } from './ExecutionClientSettings.js';

/** Explicit local installation creates only a lane-owned empty journal; normal execution never calls this role. */
export class ExecutionJournalInstallation {
    /** Explicit installation validates local paths/code/grants before initializing a new journal without overwriting history. */
    public static async initialize(
        identity: ConnectorClientIdentity,
        settings: ExecutionClientSettings,
    ): Promise<void> {
        await using resources: AsyncDisposableStack = new AsyncDisposableStack();
        resources.use(await ExecutionConfiguration.loadPolicy(identity, settings));
        resources.use(
            await ConnectorPrivateDirectory.open(
                settings.stateDirectory,
                ConnectorDirectoryPurpose.Execution,
            ),
        );
        const directory: string = ExecutionConfiguration.journalDirectory(settings);
        let created: boolean = false;
        try {
            try {
                await mkdir(directory, { mode: 0o700 });
                created = true;
            } catch (caught: unknown) {
                if (!(caught instanceof Error) || !('code' in caught) || caught.code !== 'EEXIST') {
                    throw caught;
                }
            }
            await ConnectorOperationJournal.initialize(
                directory,
                identity.settings.enrollmentId,
                identity.key,
                new ExecutionJournalCodec(settings.lane),
            );
        } catch (caught: unknown) {
            if (created) {
                try {
                    await rmdir(directory);
                } catch (cleanup: unknown) {
                    if (
                        !(cleanup instanceof Error) ||
                        !('code' in cleanup) ||
                        cleanup.code !== 'ENOTEMPTY'
                    ) {
                        throw new AggregateError(
                            [caught, cleanup],
                            'Execution journal initialization cleanup failed',
                            { cause: cleanup },
                        );
                    }
                }
            }
            throw caught;
        }
    }
}
