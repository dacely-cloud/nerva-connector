// SPDX-FileCopyrightText: 2026 Dacely <business@dacely.com>
// SPDX-License-Identifier: LicenseRef-Proprietary

import { lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { ExecutionLane } from 'nerva-connector-protocol/execution/ExecutionLane.js';
import { ExecutionJournalInstallation } from './ExecutionJournalInstallation.js';
import type { ConnectorClientIdentity } from '../runtime/ConnectorClientConfiguration.js';
import { ConnectorClientExecution } from '../runtime/ConnectorClientExecution.js';

/** Only original approved enrollment preparation may initialize fresh command journals; configured devices require their original history. */
export class ExecutionPairPreparation {
    /** Local explicit grants and installed enforcing policy are validated before publishing normal runtime configuration. */
    public static async prepare(identity: ConnectorClientIdentity, fresh: boolean): Promise<void> {
        const settings: typeof identity.settings.execution = identity.settings.execution;
        if (settings === null) {
            return;
        }
        for (const lane of Object.values(ExecutionLane)) {
            let missing: boolean = false;
            try {
                await lstat(join(settings.stateDirectory, lane, 'execution-journal'));
            } catch (caught: unknown) {
                if (caught instanceof Error && 'code' in caught && caught.code === 'ENOENT') {
                    missing = true;
                } else {
                    throw caught;
                }
            }
            if (missing) {
                if (!fresh) {
                    throw new Error('Configured connector lost its original execution journal');
                }
                await ExecutionJournalInstallation.initialize(identity, { ...settings, lane });
            }
        }
        await using owner: ConnectorClientExecution = await ConnectorClientExecution.load(identity);
        if (owner.failed) {
            throw new Error('Prepared execution journals are unavailable');
        }
    }
}
